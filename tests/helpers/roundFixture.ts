/** Deterministic round inputs shared by the pipeline tests. */
import { createHash } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PYTH_SOL_USD_FEED_ID, PYTH_SOL_USD_PRICE_ACCOUNT } from "../../lib/pyth";
import { RoundPolicy } from "../../keeper/round/policy";
import { RoundInputs, snapshotChainHead, snapshotHash } from "../../keeper/round/prepare";
import { deriveSampleSeed, selectSampleIndices } from "../../keeper/round/select";
import { Snapshot } from "../../keeper/round/types";

export const PROGRAM_ID = "C4mQLDEnnFupVCwQbr9Bzygr9kJaowRTmmUEb9FoFaLh";
export const FIXTURE_SECRET = Buffer.alloc(32, 7);
export const FIXTURE_SEED_HASH = Buffer.alloc(32, 9);

/** An on-curve wallet address, stable per `n`. */
export function wallet(n: number): string {
  return Keypair.fromSeed(Uint8Array.from(Buffer.alloc(32, n))).publicKey.toBase58();
}

/** An off-curve (program-derived) address, stable per `n`. */
export function pda(n: number): string {
  return PublicKey.findProgramAddressSync([Buffer.from([n])], new PublicKey(PROGRAM_ID))[0].toBase58();
}

export function tokenAccount(n: number): string {
  return new PublicKey(createHash("sha256").update(`token-account-${n}`).digest()).toBase58();
}

/** Six hourly snapshots: five growing holders, a program-owned vault, and the keeper. */
export function candidateSnapshots(): Snapshot[] {
  const holders = [wallet(1), wallet(2), wallet(3), wallet(4), wallet(5)];
  return Array.from({ length: 6 }, (_, index) => ({
    index,
    slot: 100 + index * 100,
    timestamp: 1_800_000_000 + index * 3_600,
    poolPrice: { num: BigInt(900 + index * 50), den: 1_000n }, // ~0.9–1.15 lamports per raw unit
    accounts: [
      ...holders.map((owner, h) => ({
        address: tokenAccount(h * 10 + 1),
        owner,
        amount: BigInt((h + 1) * 150_000_000 + index * (h + 2) * 20_000_000),
      })),
      { address: tokenAccount(90), owner: pda(1), amount: 9_000_000_000n },
      { address: tokenAccount(91), owner: wallet(50), amount: 7_000_000_000n },
    ],
  }));
}

export function fixturePolicy(): RoundPolicy {
  return {
    version: 1,
    samplesPerRound: 3,
    minWindowSecs: 3_600,
    seedSlotOffset: 32,
    minEligibleUsdMicro: 50_000_000n,
    maxLeavesPerAsset: 65_536,
    maxMinLeafPasses: 3,
    minLeafValueLamports: 1_000n,
    autoPushMinRentMultiple: 3,
    excludeOffCurveOwners: true,
    staticExclusions: [{ owner: "1nc1nerator11111111111111111111111111111111", reason: "burn address" }],
    priceFeedAccount: PYTH_SOL_USD_PRICE_ACCOUNT.toBase58(),
    priceFeedIdHex: PYTH_SOL_USD_FEED_ID,
    maxPriceAgeSecs: 60,
    maxPriceConfBps: 100,
    minExpirySecs: 0,
    roundExpirySecs: 90 * 24 * 60 * 60,
  };
}

/** Round 4 of wallet(60)'s distributor, as the program would have recorded it. */
export function buildRoundInputs(opts: { secret?: Buffer } = {}): RoundInputs {
  const candidates = candidateSnapshots();
  const secret = opts.secret ?? FIXTURE_SECRET;
  const policy = fixturePolicy();
  const intent = {
    openSlot: 100,
    openTs: 1_800_000_000,
    closeSlot: 650,
    closeTs: 1_800_020_000,
    snapshotCount: candidates.length,
    snapshotChainHeadHex: snapshotChainHead(wallet(60), 4n, candidates.map(snapshotHash)),
    secretCommitmentHex: createHash("sha256").update(secret).digest("hex"),
    seedSlot: 700,
    seedHashHex: FIXTURE_SEED_HASH.toString("hex"),
    solUsd: { price: 15_000_000_000n, conf: 1_000_000n, exponent: -8, publishTime: 1_800_019_990 }, // $150
  };
  const selected = selectSampleIndices(
    candidates,
    { startSlot: intent.openSlot, endSlot: intent.closeSlot },
    policy.samplesPerRound,
    deriveSampleSeed(4n, FIXTURE_SEED_HASH, secret)
  );

  return {
    version: 2,
    programId: PROGRAM_ID,
    distributor: wallet(60),
    indexMint: wallet(61),
    rootAuthority: wallet(50),
    roundId: 4n,
    policy,
    intent,
    secretHex: secret.toString("hex"),
    candidates: candidates.map((s) => ({ index: s.index, slot: s.slot, sha256: snapshotHash(s) })),
    selectedSnapshots: selected.map((i) => candidates[i]),
    purchases: [
      // 10,000 lamports bought 1,000 raw units: the 1,000-lamport minimum payout is 100 units.
      { mint: wallet(102), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), buyer: wallet(50), lamportsSpent: 10_000n, received: 1_000n, signatures: ["fixture-signature"] },
    ],
    assets: [
      // Leftovers from an earlier round, not bought this round: no minimum.
      { mint: wallet(101), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), allocatable: 1_000_003n, minLeafAmount: 0n },
      { mint: wallet(102), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), allocatable: 777n, minLeafAmount: 100n },
    ],
  };
}
