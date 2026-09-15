/**
 * stonkfolio-distributor security suite. Needs a running local validator with
 * the program and test price accounts loaded — start it with
 * `bash scripts/distributor-test-validator.sh`, then `npm run test:distributor`.
 *
 * Tests share one validator and run in order. Most use the `main`
 * distributor (one launched coin); others create their own.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountState,
  AuthorityType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createEnableRequiredMemoTransfersInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeMintInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createMint,
  createReallocateInstruction,
  createSetAuthorityInstruction,
  createSetTransferFeeInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import type { StonkfolioDistributor } from "../target/types/stonkfolio_distributor";
import { AssetTuple, MerkleTree, PayoutLeaf, assetLeafHash, payoutLeafHash, u64le } from "../lib/merkle";
import { PYTH_SOL_USD_FEED_ID } from "../lib/pyth";
import { TEST_FEED_IDS, TEST_PRICE_ACCOUNTS, TEST_SOL_USD } from "../scripts/make-test-price-accounts";

const RPC_URL = process.env.DISTRIBUTOR_TEST_RPC ?? "http://127.0.0.1:8899";
const CONFIRM = { commitment: "confirmed" as const };
const DECIMALS = 6;

let connection: Connection;
let program: Program<StonkfolioDistributor>;
let payer: Keypair; // fee payer only — no role in any distributor
const keeper = Keypair.generate(); // root authority of the test distributors
const attacker = Keypair.generate();

// --- helpers ---------------------------------------------------------------

const bn = (v: bigint | number) => new BN(v.toString());
const bytes = (b: Buffer) => Array.from(b);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Dist {
  indexMint: PublicKey;
  authority: Keypair;
  pda: PublicKey;
}

let main: Dist;

/** Rules fixed at distributor creation; tests override one at a time. */
interface DistRules {
  minExpirySecs: number;
  policyHash: Buffer;
  priceFeedAccount: PublicKey;
  priceFeedIdHex: string;
  maxPriceAgeSecs: number;
  maxPriceConfBps: number;
  seedSlotOffset: number;
  minWindowSecs: number;
}

const DEFAULT_RULES: DistRules = {
  minExpirySecs: 0,
  policyHash: Buffer.alloc(32, 42),
  priceFeedAccount: TEST_PRICE_ACCOUNTS.fresh,
  priceFeedIdHex: PYTH_SOL_USD_FEED_ID,
  maxPriceAgeSecs: 30 * 24 * 60 * 60, // the test price is stamped when the validator boots
  maxPriceConfBps: 100,
  seedSlotOffset: 1,
  minWindowSecs: 0,
};

function distributorPda(indexMint: PublicKey, creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("distributor"), indexMint.toBuffer(), creator.toBuffer()],
    program.programId
  )[0];
}

function intentPda(distributor: PublicKey, roundId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("intent"), distributor.toBuffer(), u64le(roundId)],
    program.programId
  )[0];
}

function roundPda(distributor: PublicKey, roundId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), distributor.toBuffer(), u64le(roundId)],
    program.programId
  )[0];
}

function roundAssetPda(round: PublicKey, assetIdx: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round_asset"), round.toBuffer(), Buffer.from([assetIdx])],
    program.programId
  )[0];
}

function ata(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

let txNonce = 0;

async function send(ixs: TransactionInstruction[], signers: Keypair[] = []): Promise<string> {
  // A unique compute-unit price gives every transaction a unique signature, so
  // a deliberate retry of an identical instruction set (e.g. a double push)
  // reaches the program instead of stalling in web3.js's blockhash dedup.
  const unique = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ++txNonce });
  return sendAndConfirmTransaction(connection, new Transaction().add(unique, ...ixs), [payer, ...signers], CONFIRM);
}

function errorText(err: any): string {
  return `${err?.message ?? err}\n${(err?.logs ?? err?.transactionLogs ?? []).join("\n")}`;
}

async function expectFail(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err: any) {
    const text = errorText(err);
    expect(text, text).to.match(pattern);
    return;
  }
  expect.fail(`expected failure matching ${pattern}`);
}

async function chainNow(): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  return Number(info!.data.readBigInt64LE(32));
}

async function waitForChainTime(ts: number): Promise<void> {
  while ((await chainNow()) < ts) await sleep(500);
}

async function tokenBalance(account: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
  return (await getAccount(connection, account, "confirmed", tokenProgram)).amount;
}

async function legacyMint(freezeAuthority: PublicKey | null = null): Promise<PublicKey> {
  return createMint(connection, payer, payer.publicKey, freezeAuthority, DECIMALS, undefined, CONFIRM, TOKEN_PROGRAM_ID);
}

async function token2022Mint(
  extensions: ExtensionType[],
  initIxs: (mint: PublicKey) => TransactionInstruction[],
  freezeAuthority: PublicKey | null = null
): Promise<PublicKey> {
  const mint = Keypair.generate();
  const space = getMintLen(extensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(space);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      ...initIxs(mint.publicKey),
      createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, freezeAuthority, TOKEN_2022_PROGRAM_ID),
    ],
    [mint]
  );
  return mint.publicKey;
}

async function createDistributorIx(indexMint: PublicKey, authority: PublicKey, overrides: Partial<DistRules> = {}) {
  const rules = { ...DEFAULT_RULES, ...overrides };
  return program.methods
    .createDistributor({
      minExpirySecs: bn(rules.minExpirySecs),
      policyHash: bytes(rules.policyHash),
      priceFeedAccount: rules.priceFeedAccount,
      priceFeedId: bytes(Buffer.from(rules.priceFeedIdHex, "hex")),
      maxPriceAgeSecs: rules.maxPriceAgeSecs,
      maxPriceConfBps: rules.maxPriceConfBps,
      seedSlotOffset: rules.seedSlotOffset,
      minWindowSecs: rules.minWindowSecs,
    })
    .accountsStrict({
      rootAuthority: authority,
      payer: payer.publicKey,
      indexMint,
      distributor: distributorPda(indexMint, authority),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function createDistributor(indexMint: PublicKey, authority: Keypair, overrides: Partial<DistRules> = {}): Promise<Dist> {
  await send([await createDistributorIx(indexMint, authority.publicKey, overrides)], [authority]);
  return { indexMint, authority, pda: distributorPda(indexMint, authority.publicKey) };
}

async function nextRoundId(dist: Dist): Promise<bigint> {
  const account = await program.account.distributor.fetch(dist.pda);
  return BigInt(account.nextRoundId.toString());
}

// --- round intent ------------------------------------------------------------

async function openRoundIx(dist: Dist, roundId: bigint, commitment: Buffer, authority: Keypair = dist.authority) {
  return program.methods
    .openRound(bn(roundId), bytes(commitment))
    .accountsStrict({
      rootAuthority: authority.publicKey,
      payer: payer.publicKey,
      distributor: dist.pda,
      intent: intentPda(dist.pda, roundId),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function closeWindowIx(dist: Dist, roundId: bigint, o: { authority?: Keypair; priceUpdate?: PublicKey; count?: number } = {}) {
  const priceUpdate = o.priceUpdate ?? (await program.account.distributor.fetch(dist.pda)).priceFeedAccount;
  return program.methods
    .closeWindow(bytes(Buffer.alloc(32, 5)), o.count ?? 1)
    .accountsStrict({
      rootAuthority: (o.authority ?? dist.authority).publicKey,
      distributor: dist.pda,
      intent: intentPda(dist.pda, roundId),
      priceUpdate,
    })
    .instruction();
}

async function recordSeedIx(dist: Dist, roundId: bigint) {
  return program.methods
    .recordSeed()
    .accountsStrict({ distributor: dist.pda, intent: intentPda(dist.pda, roundId), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY })
    .instruction();
}

async function abandonIx(dist: Dist, roundId: bigint, authority: Keypair = dist.authority) {
  return program.methods
    .abandonRound()
    .accountsStrict({
      rootAuthority: authority.publicKey,
      distributor: dist.pda,
      intent: intentPda(dist.pda, roundId),
      slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    })
    .instruction();
}

interface Intent {
  roundId: bigint;
  secret: Buffer;
}

async function openAndClose(dist: Dist, authority: Keypair = dist.authority): Promise<Intent> {
  const roundId = await nextRoundId(dist);
  const secret = randomBytes(32);
  await send([await openRoundIx(dist, roundId, sha256(secret), authority)], [authority]);
  await send([await closeWindowIx(dist, roundId, { authority })], [authority]);
  return { roundId, secret };
}

/** Sent by the fee payer, not the keeper: recording the seed is permissionless. */
async function recordSeedWhenReady(dist: Dist, roundId: bigint): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await send([await recordSeedIx(dist, roundId)]);
      return;
    } catch (err) {
      if (!/SeedNotYetAvailable/.test(errorText(err))) throw err;
      await sleep(400);
    }
  }
  throw new Error(`round ${roundId} seed never became available`);
}

async function seededIntent(dist: Dist, authority: Keypair = dist.authority): Promise<Intent> {
  const intent = await openAndClose(dist, authority);
  await recordSeedWhenReady(dist, intent.roundId);
  return intent;
}

// --- rounds ------------------------------------------------------------------

interface LeafSpec {
  recipient: PublicKey;
  amount: bigint;
}

interface AssetSpec {
  mint: PublicKey;
  tokenProgram: PublicKey;
  leaves: LeafSpec[];
  allocated?: bigint;
}

interface BuiltAsset {
  assetIdx: number;
  mint: PublicKey;
  tokenProgram: PublicKey;
  leaves: PayoutLeaf[];
  tree: MerkleTree;
  allocated: bigint;
  roundAsset: PublicKey;
  vault: PublicKey;
  tuple: AssetTuple;
  assetProof: Buffer[];
}

interface BuiltRound {
  dist: Dist;
  roundId: bigint;
  secret: Buffer;
  round: PublicKey;
  assets: BuiltAsset[];
  assetsRoot: Buffer;
}

function buildRound(dist: Dist, intent: Intent, specs: AssetSpec[]): BuiltRound {
  const { roundId } = intent;
  const round = roundPda(dist.pda, roundId);
  const assets: BuiltAsset[] = specs.map((spec, assetIdx) => {
    const leaves = spec.leaves.map((l, leafIdx) => ({ leafIdx, recipient: l.recipient, amount: l.amount }));
    const tree = new MerkleTree(leaves.map((l) => payoutLeafHash(program.programId, dist.pda, roundId, assetIdx, l)));
    const allocated = spec.allocated ?? leaves.reduce((sum, l) => sum + l.amount, 0n);
    const roundAsset = roundAssetPda(round, assetIdx);
    return {
      assetIdx,
      mint: spec.mint,
      tokenProgram: spec.tokenProgram,
      leaves,
      tree,
      allocated,
      roundAsset,
      vault: ata(spec.mint, roundAsset, spec.tokenProgram),
      tuple: { assetIdx, mint: spec.mint, tokenProgram: spec.tokenProgram, merkleRoot: tree.root, allocated, leafCount: leaves.length },
      assetProof: [],
    };
  });
  const assetsTree = assets.length > 0 ? new MerkleTree(assets.map((a) => assetLeafHash(program.programId, dist.pda, roundId, a.tuple))) : undefined;
  assets.forEach((a, i) => (a.assetProof = assetsTree!.proof(i)));
  return { dist, roundId, secret: intent.secret, round, assets, assetsRoot: assetsTree?.root ?? Buffer.alloc(32) };
}

interface CommitOptions {
  expiryTs: number;
  roundId?: bigint;
  assetCount?: number;
  allowFreezeMask?: number;
  rootAuthority?: Keypair;
  secret?: Buffer;
}

async function commitIx(r: BuiltRound, o: CommitOptions): Promise<TransactionInstruction> {
  const roundId = o.roundId ?? r.roundId;
  return program.methods
    .commitRound({
      roundId: bn(roundId),
      secret: bytes(o.secret ?? r.secret),
      assetsRoot: bytes(r.assetsRoot),
      artifactHash: Array(32).fill(7),
      assetCount: o.assetCount ?? r.assets.length,
      expiryTs: bn(o.expiryTs),
      allowFreezeAuthorityMask: o.allowFreezeMask ?? 0,
    })
    .accountsStrict({
      rootAuthority: (o.rootAuthority ?? r.dist.authority).publicKey,
      payer: payer.publicKey,
      distributor: r.dist.pda,
      intent: intentPda(r.dist.pda, r.roundId),
      round: roundPda(r.dist.pda, roundId),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** Runs the full on-chain sequence: open, close the window, record the seed, commit. */
async function commitRound(
  specs: AssetSpec[],
  o: { dist?: Dist; expiresInSecs?: number; allowFreezeMask?: number } = {}
): Promise<BuiltRound> {
  const dist = o.dist ?? main;
  const r = buildRound(dist, await seededIntent(dist), specs);
  const expiryTs = (await chainNow()) + (o.expiresInSecs ?? 3600);
  await send([await commitIx(r, { expiryTs, allowFreezeMask: o.allowFreezeMask })], [dist.authority]);
  return r;
}

async function openIx(r: BuiltRound, a: BuiltAsset, assetProof: Buffer[] = a.assetProof): Promise<TransactionInstruction> {
  return program.methods
    .openAsset({
      assetIdx: a.assetIdx,
      merkleRoot: bytes(a.tree.root),
      allocated: bn(a.allocated),
      leafCount: a.leaves.length,
      assetProof: assetProof.map(bytes),
    })
    .accountsStrict({
      payer: payer.publicKey,
      round: r.round,
      roundAsset: a.roundAsset,
      mint: a.mint,
      vault: a.vault,
      tokenProgram: a.tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function activateIx(r: BuiltRound, a: BuiltAsset): Promise<TransactionInstruction> {
  return program.methods
    .activateAsset()
    .accountsStrict({ round: r.round, roundAsset: a.roundAsset, vault: a.vault })
    .instruction();
}

async function fundPayer(mint: PublicKey, tokenProgram: PublicKey, amount: bigint): Promise<PublicKey> {
  const account = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
    false,
    "confirmed",
    CONFIRM,
    tokenProgram
  );
  await mintTo(connection, payer, mint, account.address, payer, amount, [], CONFIRM, tokenProgram);
  return account.address;
}

async function openFundActivate(r: BuiltRound, a: BuiltAsset, fundAmount: bigint = a.allocated): Promise<void> {
  const payerAta = await fundPayer(a.mint, a.tokenProgram, fundAmount);
  await send([
    await openIx(r, a),
    createTransferCheckedInstruction(payerAta, a.mint, a.vault, payer.publicKey, fundAmount, DECIMALS, [], a.tokenProgram),
    await activateIx(r, a),
  ]);
}

interface PayoutOverrides {
  leafIdx?: number;
  recipient?: PublicKey;
  destination?: PublicKey;
  amount?: bigint;
  proof?: Buffer[];
  mint?: PublicKey;
}

async function pushIx(r: BuiltRound, a: BuiltAsset, sourceLeaf: number, o: PayoutOverrides = {}): Promise<TransactionInstruction> {
  const leaf = a.leaves[sourceLeaf];
  const recipient = o.recipient ?? leaf.recipient;
  return program.methods
    .pushPayout(o.leafIdx ?? sourceLeaf, bn(o.amount ?? leaf.amount), (o.proof ?? a.tree.proof(sourceLeaf)).map(bytes))
    .accountsStrict({
      payer: payer.publicKey,
      round: r.round,
      roundAsset: a.roundAsset,
      mint: o.mint ?? a.mint,
      vault: a.vault,
      recipient,
      destination: o.destination ?? ata(a.mint, recipient, a.tokenProgram),
      tokenProgram: a.tokenProgram,
    })
    .instruction();
}

async function push(r: BuiltRound, a: BuiltAsset, leafIdx: number, o: PayoutOverrides = {}): Promise<string> {
  const recipient = o.recipient ?? a.leaves[leafIdx].recipient;
  const ixs = o.destination
    ? []
    : [
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          ata(a.mint, recipient, a.tokenProgram),
          recipient,
          a.mint,
          a.tokenProgram
        ),
      ];
  return send([...ixs, await pushIx(r, a, leafIdx, o)]);
}

async function selfClaim(
  r: BuiltRound,
  a: BuiltAsset,
  leafIdx: number,
  signer: Keypair,
  destination: PublicKey,
  o: PayoutOverrides = {}
): Promise<string> {
  const leaf = a.leaves[leafIdx];
  const ix = await program.methods
    .selfClaim(o.leafIdx ?? leafIdx, bn(o.amount ?? leaf.amount), (o.proof ?? a.tree.proof(leafIdx)).map(bytes))
    .accountsStrict({
      round: r.round,
      roundAsset: a.roundAsset,
      mint: a.mint,
      vault: a.vault,
      recipient: signer.publicKey,
      destination,
      tokenProgram: a.tokenProgram,
    })
    .instruction();
  return send([ix], [signer]);
}

function rolloverAtaIx(r: BuiltRound, a: BuiltAsset): TransactionInstruction {
  const owner = r.dist.authority.publicKey;
  return createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    ata(a.mint, owner, a.tokenProgram),
    owner,
    a.mint,
    a.tokenProgram
  );
}

async function sweepIx(r: BuiltRound, a: BuiltAsset, rolloverDestination = ata(a.mint, r.dist.authority.publicKey, a.tokenProgram)) {
  return program.methods
    .sweepExcess()
    .accountsStrict({
      distributor: r.dist.pda,
      roundAsset: a.roundAsset,
      mint: a.mint,
      vault: a.vault,
      rolloverDestination,
      tokenProgram: a.tokenProgram,
    })
    .instruction();
}

async function closeIx(r: BuiltRound, a: BuiltAsset) {
  return program.methods
    .closeAsset()
    .accountsStrict({
      distributor: r.dist.pda,
      round: r.round,
      roundAsset: a.roundAsset,
      mint: a.mint,
      vault: a.vault,
      rolloverDestination: ata(a.mint, r.dist.authority.publicKey, a.tokenProgram),
      rolloverWallet: r.dist.authority.publicKey,
      tokenProgram: a.tokenProgram,
    })
    .instruction();
}

const recipients = (n: number) => Array.from({ length: n }, () => Keypair.generate());

// --- suite -----------------------------------------------------------------

describe("stonkfolio-distributor", () => {
  before(async () => {
    connection = new Connection(RPC_URL, "confirmed");
    payer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.cwd(), ".keys/test-upgrade-authority.json"), "utf-8")))
    );
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), CONFIRM);
    const idl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target/idl/stonkfolio_distributor.json"), "utf-8"));
    program = new Program(idl as StonkfolioDistributor, provider);

    // The payer is funded at genesis (--mint in scripts/distributor-test-validator.sh).
    await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: attacker.publicKey, lamports: 10 * 1e9 })]);
    main = await createDistributor(await legacyMint(), keeper);
  });

  describe("distributors (one per launched coin)", () => {
    it("anyone can create a distributor for a mint, but only under their own key", async () => {
      const account = await program.account.distributor.fetch(main.pda);
      expect(account.rootAuthority.equals(keeper.publicKey)).to.be.true;
      expect(account.indexMint.equals(main.indexMint)).to.be.true;
      expect(account.nextRoundId.toNumber()).to.equal(0);
      expect(Buffer.from(account.policyHash).equals(DEFAULT_RULES.policyHash)).to.be.true;
      expect(account.priceFeedAccount.equals(TEST_PRICE_ACCOUNTS.fresh)).to.be.true;

      await expectFail(send([await createDistributorIx(main.indexMint, keeper.publicKey)], [keeper]), /already in use/);
      await expectFail(
        send([await createDistributorIx(attacker.publicKey, attacker.publicKey)], [attacker]),
        /InvalidAccountData/
      );

      // an attacker's distributor for the same coin is a different account with no power over main
      const squatter = await createDistributor(main.indexMint, attacker);
      expect(squatter.pda.equals(main.pda)).to.be.false;
      await expectFail(send([await openRoundIx(main, 0n, sha256(randomBytes(32)), attacker)], [attacker]), /Unauthorized/);
    });

    it("rejects seed and price rules outside their bounds, and a price account that isn't Pyth's feed account", async () => {
      const mint = await legacyMint();
      for (const overrides of [
        { seedSlotOffset: 0 },
        { seedSlotOffset: 257 },
        { maxPriceAgeSecs: 0 },
        { maxPriceConfBps: 0 },
        { maxPriceConfBps: 10_001 },
        { minExpirySecs: -1 },
      ]) {
        await expectFail(send([await createDistributorIx(mint, keeper.publicKey, overrides)], [keeper]), /InvalidConfig/);
      }
      // An account the creator posted themselves, or one that doesn't belong to the named feed.
      for (const overrides of [{ priceFeedAccount: TEST_PRICE_ACCOUNTS.partial }, { priceFeedIdHex: "00".repeat(32) }]) {
        await expectFail(send([await createDistributorIx(mint, keeper.publicKey, overrides)], [keeper]), /NotPythFeedAccount/);
      }
    });

    it("each coin's distributor is independent: own round ids, and proofs and asset tuples don't replay across coins", async () => {
      const other = await createDistributor(await legacyMint(), keeper);
      const mint = await legacyMint();
      const [alice, bob] = recipients(2);
      const rMain = await commitRound(
        [{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: [{ recipient: alice.publicKey, amount: 900n }, { recipient: bob.publicKey, amount: 100n }] }],
        { dist: main }
      );
      const rOther = await commitRound(
        [{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: [{ recipient: alice.publicKey, amount: 500n }, { recipient: bob.publicKey, amount: 500n }] }],
        { dist: other }
      );
      expect(rMain.roundId).to.equal(0n);
      expect(rOther.roundId).to.equal(0n);
      const [aMain, aOther] = [rMain.assets[0], rOther.assets[0]];

      // main's asset tuple can't open other's asset
      await expectFail(send([await openIx(rOther, { ...aOther, tree: aMain.tree, allocated: aMain.allocated })]), /InvalidAssetProof/);
      await openFundActivate(rMain, aMain);
      await openFundActivate(rOther, aOther, 1_000n);

      // main's larger leaf for alice can't be paid from other's vault
      await expectFail(push(rOther, aOther, 0, { amount: 900n, proof: aMain.tree.proof(0) }), /InvalidProof/);
      await push(rOther, aOther, 0);
      await push(rMain, aMain, 0);
      expect(await tokenBalance(ata(mint, alice.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)).to.equal(1_400n);
    });
  });

  describe("round intent (sampling can't be revised)", () => {
    it("the keeper opens a round once at the next id; the window closes with Pyth's price; anyone records the seed; the secret must match", async () => {
      const dist = await createDistributor(await legacyMint(), keeper);
      const secret = randomBytes(32);
      await expectFail(send([await openRoundIx(dist, 0n, sha256(secret), attacker)], [attacker]), /Unauthorized/);
      await expectFail(send([await openRoundIx(dist, 1n, sha256(secret))], [keeper]), /InvalidRoundId/);
      await send([await openRoundIx(dist, 0n, sha256(secret))], [keeper]);
      await expectFail(send([await openRoundIx(dist, 0n, sha256(randomBytes(32)))], [keeper]), /already in use/);
      let intent = await program.account.roundIntent.fetch(intentPda(dist.pda, 0n));
      expect("open" in intent.status).to.be.true;
      expect(Buffer.from(intent.secretCommitment).equals(sha256(secret))).to.be.true;

      const r = buildRound(dist, { roundId: 0n, secret }, []);
      const expiryTs = (await chainNow()) + 3600;
      await expectFail(send([await commitIx(r, { expiryTs })], [keeper]), /InvalidIntentStatus/);
      await expectFail(send([await recordSeedIx(dist, 0n)]), /InvalidIntentStatus/);

      await expectFail(send([await closeWindowIx(dist, 0n, { authority: attacker })], [attacker]), /Unauthorized/);
      await expectFail(send([await closeWindowIx(dist, 0n, { count: 0 })], [keeper]), /EmptyWindow/);
      await expectFail(send([await closeWindowIx(dist, 0n, { priceUpdate: TEST_PRICE_ACCOUNTS.partial })], [keeper]), /PriceFeedMismatch/);
      await send([await closeWindowIx(dist, 0n)], [keeper]);
      intent = await program.account.roundIntent.fetch(intentPda(dist.pda, 0n));
      expect("closed" in intent.status).to.be.true;
      expect(intent.solUsdPrice.toString()).to.equal(TEST_SOL_USD.price.toString());
      expect(intent.solUsdExponent).to.equal(TEST_SOL_USD.exponent);
      expect(intent.snapshotCount).to.equal(1);
      expect(intent.closeSlot.gte(intent.openSlot)).to.be.true;
      await expectFail(send([await closeWindowIx(dist, 0n)], [keeper]), /InvalidIntentStatus/);

      await recordSeedWhenReady(dist, 0n);
      intent = await program.account.roundIntent.fetch(intentPda(dist.pda, 0n));
      expect("seeded" in intent.status).to.be.true;
      expect(intent.seedSlot.gte(intent.closeSlot.addn(1))).to.be.true;
      expect(Buffer.from(intent.seedHash).equals(Buffer.alloc(32))).to.be.false;
      await expectFail(send([await recordSeedIx(dist, 0n)]), /InvalidIntentStatus/);

      // Once the seed is known, the draw can't be thrown away and redone.
      await expectFail(send([await abandonIx(dist, 0n)], [keeper]), /CannotAbandon/);
      await expectFail(send([await commitIx(r, { expiryTs, secret: randomBytes(32) })], [keeper]), /SecretMismatch/);
      await send([await commitIx(r, { expiryTs })], [keeper]);

      const header = await program.account.roundHeader.fetch(r.round);
      expect(header.assetCount).to.equal(0);
      expect(header.windowStartSlot.eq(intent.openSlot)).to.be.true;
      expect(header.windowEndSlot.eq(intent.closeSlot)).to.be.true;
      intent = await program.account.roundIntent.fetch(intentPda(dist.pda, 0n));
      expect("committed" in intent.status).to.be.true;
      expect(await nextRoundId(dist)).to.equal(1n);
      await expectFail(send([await abandonIx(dist, 0n)], [keeper]), /InvalidRoundId/);
    });

    it("enforces the distributor's window and price rules when a window closes", async () => {
      const cases: [Partial<DistRules>, RegExp][] = [
        [{ minWindowSecs: 3_600 }, /WindowTooShort/],
        [{ maxPriceAgeSecs: 1 }, /PriceTooOld/],
        [{ maxPriceConfBps: 1 }, /PriceConfidenceTooWide/],
        [{ priceFeedAccount: TEST_PRICE_ACCOUNTS.mismatched, priceFeedIdHex: TEST_FEED_IDS.mismatched }, /PriceFeedMismatch/],
        [{ priceFeedAccount: TEST_PRICE_ACCOUNTS.partial, priceFeedIdHex: TEST_FEED_IDS.partial }, /PriceNotFullyVerified/],
        [{ priceFeedAccount: TEST_PRICE_ACCOUNTS.wrongOwner, priceFeedIdHex: TEST_FEED_IDS.wrongOwner }, /InvalidPriceAccount/],
        [{ priceFeedAccount: TEST_PRICE_ACCOUNTS.future, priceFeedIdHex: TEST_FEED_IDS.future }, /PriceFromTheFuture/],
      ];
      for (const [rules, error] of cases) {
        const dist = await createDistributor(await legacyMint(), keeper, rules);
        await send([await openRoundIx(dist, 0n, sha256(randomBytes(32)))], [keeper]);
        await expectFail(send([await closeWindowIx(dist, 0n)], [keeper]), error);
      }
    });

    it("an open round can be abandoned; a closed one neither while its seed can be recorded nor right after it ages out", async () => {
      const dist = await createDistributor(await legacyMint(), keeper, { seedSlotOffset: 1 });
      await send([await openRoundIx(dist, 0n, sha256(randomBytes(32)))], [keeper]);
      await expectFail(send([await abandonIx(dist, 0n, attacker)], [attacker]), /Unauthorized/);
      await send([await abandonIx(dist, 0n)], [keeper]);
      expect("abandoned" in (await program.account.roundIntent.fetch(intentPda(dist.pda, 0n))).status).to.be.true;
      expect(await nextRoundId(dist)).to.equal(1n);
      await expectFail(send([await closeWindowIx(dist, 0n)], [keeper]), /InvalidIntentStatus/);

      const { roundId } = await openAndClose(dist);
      expect(roundId).to.equal(1n);
      await expectFail(send([await abandonIx(dist, roundId)], [keeper]), /CannotAbandon/);

      // SlotHashes keeps the most recent 512 slots.
      const closeSlot = (await program.account.roundIntent.fetch(intentPda(dist.pda, roundId))).closeSlot.toNumber();
      console.log(`      waiting ~3.5 minutes for slot ${closeSlot + 1} to age out of SlotHashes`);
      while ((await connection.getSlot("confirmed")) < closeSlot + 1 + 520) await sleep(2_000);
      await expectFail(send([await recordSeedIx(dist, roundId)]), /SeedExpired/);
      // Anyone could have read the seed hash, so skipping the record mustn't buy a quick re-draw:
      // abandoning waits a day after close (that path is unit-tested in round_intent.rs).
      await expectFail(send([await abandonIx(dist, roundId)], [keeper]), /CannotAbandon/);
      expect((await program.account.distributor.fetch(dist.pda)).expiredSeedAbandons).to.equal(0);
      expect(await nextRoundId(dist)).to.equal(1n);
    });
  });

  describe("commit_round", () => {
    let mint: PublicKey;
    before(async () => {
      mint = await legacyMint();
    });

    it("rejects a non-keeper signer, a skipped round id, bad asset counts, bad masks, past expiry, and a wrong secret", async () => {
      const r = buildRound(main, await seededIntent(main), [{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: [{ recipient: attacker.publicKey, amount: 1n }] }]);
      const expiryTs = (await chainNow()) + 3600;
      await expectFail(send([await commitIx(r, { expiryTs, rootAuthority: attacker })], [attacker]), /Unauthorized/);
      await expectFail(send([await commitIx(r, { expiryTs, roundId: r.roundId + 1n })], [keeper]), /InvalidRoundId/);
      await expectFail(send([await commitIx(r, { expiryTs, assetCount: 31 })], [keeper]), /InvalidAssetCount/);
      await expectFail(send([await commitIx(r, { expiryTs, allowFreezeMask: 0b10 })], [keeper]), /InvalidAllowMask/);
      await expectFail(send([await commitIx(r, { expiryTs: (await chainNow()) - 10 })], [keeper]), /ExpiryTooSoon/);
      await expectFail(send([await commitIx(r, { expiryTs, secret: Buffer.alloc(32, 1) })], [keeper]), /SecretMismatch/);
      await send([await commitIx(r, { expiryTs })], [keeper]);
      expect(await nextRoundId(main)).to.equal(r.roundId + 1n);
      await expectFail(send([await commitIx(r, { expiryTs })], [keeper]), /InvalidRoundId|already in use/);
    });
  });

  describe("30-coin basket", () => {
    it("a 30-asset round opens and pays its first and last assets", async () => {
      const mint = await legacyMint();
      const person = Keypair.generate();
      const specs: AssetSpec[] = Array.from({ length: 30 }, () => ({
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        leaves: [{ recipient: person.publicKey, amount: 5n }],
      }));
      const r = await commitRound(specs, { allowFreezeMask: 1 << 29 });
      const [first, last] = [r.assets[0], r.assets[29]];
      expect(last.assetProof.length).to.be.at.most(5);

      await openFundActivate(r, first);
      await openFundActivate(r, last);
      await push(r, first, 0);
      await push(r, last, 0);
      expect(await tokenBalance(ata(mint, person.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)).to.equal(10n);
      const header = await program.account.roundHeader.fetch(r.round);
      expect(header.openedMask).to.equal((1 | (1 << 29)) >>> 0);
      await expectFail(send([await openIx(r, first)]), /already in use|AssetAlreadyOpened/);
    });
  });

  describe("payouts (legacy spl-token)", () => {
    let mint: PublicKey;
    let r: BuiltRound;
    let a: BuiltAsset;
    const people = recipients(3);

    before(async () => {
      mint = await legacyMint();
      r = await commitRound([
        {
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          leaves: people.map((p, i) => ({ recipient: p.publicKey, amount: BigInt(1_000 * (i + 1)) })),
        },
      ]);
      a = r.assets[0];
    });

    it("activation fails when the vault is underfunded (whole open+fund+activate reverts)", async () => {
      await expectFail(openFundActivate(r, a, a.allocated - 1n), /Underfunded/);
      expect(await connection.getAccountInfo(a.roundAsset)).to.be.null;
    });

    it("opens, funds, activates, and pushes to the canonical ATA with no delay", async () => {
      await openFundActivate(r, a);
      await push(r, a, 0);
      expect(await tokenBalance(ata(mint, people[0].publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)).to.equal(1_000n);
      const asset = await program.account.roundAsset.fetch(a.roundAsset);
      expect(asset.claimed.toNumber()).to.equal(1_000);
      expect(asset.funded.toNumber()).to.equal(Number(a.allocated));
      expect(asset.distributor.equals(main.pda)).to.be.true;
    });

    it("an opened asset can't be opened again", async () => {
      await expectFail(send([await openIx(r, a)]), /already in use|AssetAlreadyOpened/);
    });

    it("rejects a double push, a tampered amount, a mismatched leaf index, and an out-of-range index", async () => {
      await expectFail(push(r, a, 0), /AlreadyClaimed/);
      await expectFail(push(r, a, 1, { amount: 2_001n }), /InvalidProof/);
      await expectFail(push(r, a, 1, { leafIdx: 2 }), /InvalidProof/);
      await expectFail(push(r, a, 1, { leafIdx: a.leaves.length }), /LeafIndexOutOfRange/);
    });

    it("push destination must be the recipient's canonical ATA, still owned by the recipient", async () => {
      const recipient = people[1];
      const attackerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, attacker.publicKey, false, "confirmed", CONFIRM);
      await expectFail(push(r, a, 1, { destination: attackerAta.address }), /DestinationNotCanonicalAta/);
      const side = await createAccount(connection, payer, mint, recipient.publicKey, Keypair.generate(), CONFIRM, TOKEN_PROGRAM_ID);
      await expectFail(push(r, a, 1, { destination: side }), /DestinationNotCanonicalAta/);
      const otherMint = await legacyMint();
      await expectFail(push(r, a, 1, { mint: otherMint }), /MintMismatch/);

      // legacy ATA whose owner was reassigned after creation
      const moved = people[2];
      const movedAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, moved.publicKey, false, "confirmed", CONFIRM);
      await setAuthority(connection, payer, movedAta.address, moved, AuthorityType.AccountOwner, attacker.publicKey, [], CONFIRM);
      await expectFail(push(r, a, 2, { destination: movedAta.address }), /ClaimDestinationMismatch/);
    });

    it("self_claim needs the recipient's signature, pays any account they own, and blocks a later push", async () => {
      const recipient = people[1];
      const attackerAccount = await createAccount(connection, payer, mint, attacker.publicKey, Keypair.generate(), CONFIRM, TOKEN_PROGRAM_ID);
      await expectFail(selfClaim(r, a, 1, attacker, attackerAccount), /InvalidProof/);
      await expectFail(selfClaim(r, a, 1, recipient, attackerAccount), /ClaimDestinationMismatch/);

      const side = await createAccount(connection, payer, mint, recipient.publicKey, Keypair.generate(), CONFIRM, TOKEN_PROGRAM_ID);
      await selfClaim(r, a, 1, recipient, side);
      expect(await tokenBalance(side, TOKEN_PROGRAM_ID)).to.equal(2_000n);
      await expectFail(push(r, a, 1), /AlreadyClaimed/);
      await expectFail(selfClaim(r, a, 1, recipient, side), /AlreadyClaimed/);
    });
  });

  describe("replay and allocation caps", () => {
    let mint: PublicKey;
    const people = recipients(2);
    const leaves = () => people.map((p) => ({ recipient: p.publicKey, amount: 500n }));

    before(async () => {
      mint = await legacyMint();
    });

    it("proofs don't replay across assets or rounds; asset proofs are bound to their index", async () => {
      const r1 = await commitRound([{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: leaves() }]);
      await openFundActivate(r1, r1.assets[0]);

      const r2 = await commitRound([
        { mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: leaves() },
        { mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: leaves() },
      ]);
      const [a0, a1] = r2.assets;
      await expectFail(send([await openIx(r2, a1, a0.assetProof)]), /InvalidAssetProof/);
      await openFundActivate(r2, a0);
      await openFundActivate(r2, a1);

      await expectFail(push(r2, a1, 0, { proof: a0.tree.proof(0) }), /InvalidProof/);
      await expectFail(push(r2, a0, 0, { proof: r1.assets[0].tree.proof(0) }), /InvalidProof/);
      await push(r2, a0, 0);
      await push(r2, a1, 0);
      await push(r1, r1.assets[0], 0);
    });

    it("caps total payouts at the committed allocation", async () => {
      const r = await commitRound([
        { mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: people.map((p) => ({ recipient: p.publicKey, amount: 60n })), allocated: 100n },
      ]);
      const a = r.assets[0];
      await openFundActivate(r, a);
      await push(r, a, 0);
      await expectFail(push(r, a, 1), /ExceedsAllocation/);
    });

    it("pays every leaf of 1-, 7-, 8- and 9-leaf trees", async () => {
      const sizes = [1, 7, 8, 9];
      const r = await commitRound(
        sizes.map((n) => ({
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          leaves: recipients(n).map((p, i) => ({ recipient: p.publicKey, amount: BigInt(10 + i) })),
        }))
      );
      for (const a of r.assets) {
        await openFundActivate(r, a);
        for (let i = 0; i < a.leaves.length; i++) await push(r, a, i);
        const asset = await program.account.roundAsset.fetch(a.roundAsset);
        expect(BigInt(asset.claimed.toString())).to.equal(a.allocated);
      }
    });

    it("a 65,536-leaf asset opens and pays at proof depth 16 under 200k compute units", async () => {
      const target = Keypair.generate();
      const filler = Keypair.generate().publicKey;
      const specLeaves: LeafSpec[] = Array.from({ length: 65_536 }, (_, i) => ({
        recipient: i === 40_000 ? target.publicKey : filler,
        amount: 1n,
      }));
      const r = await commitRound([{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: specLeaves }]);
      const a = r.assets[0];
      await openFundActivate(r, a);
      expect(a.tree.proof(40_000).length).to.equal(16);

      const targetAta = ata(mint, target.publicKey, TOKEN_PROGRAM_ID);
      await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, targetAta, target.publicKey, mint, TOKEN_PROGRAM_ID)]);
      const sig = await send([await pushIx(r, a, 40_000)]);
      const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const units = tx?.meta?.computeUnitsConsumed ?? Number.MAX_SAFE_INTEGER;
      console.log(`      push_payout at depth 16 with a 65,536-leaf bitmap: ${units} CU`);
      expect(units).to.be.lessThan(200_000);
      expect(await tokenBalance(targetAta, TOKEN_PROGRAM_ID)).to.equal(1n);
    });
  });

  describe("sweep and expiry", () => {
    let mint: PublicKey;
    before(async () => {
      mint = await legacyMint();
    });

    it("sweep_excess only returns what is not still owed, and only to the keeper", async () => {
      const people = recipients(2);
      const r = await commitRound([
        { mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: [{ recipient: people[0].publicKey, amount: 40n }, { recipient: people[1].publicKey, amount: 60n }] },
      ]);
      const a = r.assets[0];
      await openFundActivate(r, a, 130n);
      await push(r, a, 0);

      const attackerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, attacker.publicKey, false, "confirmed", CONFIRM);
      await expectFail(send([await sweepIx(r, a, attackerAta.address)]), /RolloverMismatch/);

      await send([rolloverAtaIx(r, a), await sweepIx(r, a)]);
      expect(await tokenBalance(ata(mint, keeper.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)).to.equal(30n);
      expect(await tokenBalance(a.vault, TOKEN_PROGRAM_ID)).to.equal(60n);
      await expectFail(send([await sweepIx(r, a)]), /NothingToSweep/);
      await push(r, a, 1);
      expect(await tokenBalance(a.vault, TOKEN_PROGRAM_ID)).to.equal(0n);
    });

    it("nobody can close early; after expiry payouts stop and close returns the unclaimed balance to the keeper", async () => {
      const people = recipients(2);
      const r = await commitRound(
        [{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: people.map((p) => ({ recipient: p.publicKey, amount: 7n })) }],
        { expiresInSecs: 15 }
      );
      const a = r.assets[0];
      await openFundActivate(r, a);
      await push(r, a, 0);
      await expectFail(send([rolloverAtaIx(r, a), await closeIx(r, a)]), /RoundNotExpired/);

      const header = await program.account.roundHeader.fetch(r.round);
      await waitForChainTime(header.expiryTs.toNumber() + 1);
      await expectFail(push(r, a, 1), /RoundExpired/);
      const side = await createAccount(connection, payer, mint, people[1].publicKey, Keypair.generate(), CONFIRM, TOKEN_PROGRAM_ID);
      await expectFail(selfClaim(r, a, 1, people[1], side), /RoundExpired/);

      const rolloverAta = ata(mint, keeper.publicKey, TOKEN_PROGRAM_ID);
      const before = await tokenBalance(rolloverAta, TOKEN_PROGRAM_ID).catch(() => 0n);
      const lamportsBefore = await connection.getBalance(keeper.publicKey);
      await send([rolloverAtaIx(r, a), await closeIx(r, a)]);
      expect(await tokenBalance(rolloverAta, TOKEN_PROGRAM_ID)).to.equal(before + 7n);
      expect(await connection.getAccountInfo(a.roundAsset)).to.be.null;
      expect(await connection.getAccountInfo(a.vault)).to.be.null;
      expect(await connection.getBalance(keeper.publicKey)).to.be.greaterThan(lamportsBefore);
      const closed = await program.account.roundHeader.fetch(r.round); // header is the permanent record
      expect(closed.closedMask & 0b1).to.equal(0b1);
      await expectFail(send([await openIx(r, a)]), /RoundExpired|AssetAlreadyOpened/);
    });
  });

  describe("mint vetting", () => {
    it("rejects unsafe Token-2022 extensions, authorities that could change a mint later, and unapproved freeze authorities", async () => {
      const hookProgram = Keypair.generate().publicKey;
      const permanentDelegate = await token2022Mint([ExtensionType.PermanentDelegate], (m) => [
        createInitializePermanentDelegateInstruction(m, attacker.publicKey, TOKEN_2022_PROGRAM_ID),
      ]);
      const nonTransferable = await token2022Mint([ExtensionType.NonTransferable], (m) => [
        createInitializeNonTransferableMintInstruction(m, TOKEN_2022_PROGRAM_ID),
      ]);
      const hooked = await token2022Mint([ExtensionType.TransferHook], (m) => [
        createInitializeTransferHookInstruction(m, payer.publicKey, hookProgram, TOKEN_2022_PROGRAM_ID),
      ]);
      const defaultFrozen = await token2022Mint(
        [ExtensionType.DefaultAccountState],
        (m) => [createInitializeDefaultAccountStateInstruction(m, AccountState.Frozen, TOKEN_2022_PROGRAM_ID)],
        payer.publicKey
      );
      const freezeNotAllowed = await legacyMint(payer.publicKey);
      const freezeAllowed = await legacyMint(payer.publicKey);
      // No hook program yet, but its authority could add one after the asset opens.
      const hookAuthorityOnly = await token2022Mint([ExtensionType.TransferHook], (m) => [
        createInitializeTransferHookInstruction(m, payer.publicKey, PublicKey.default, TOKEN_2022_PROGRAM_ID),
      ]);
      // StonkFun's reward-coin shape: a 3% fee whose authority can still change it. Accepted.
      const feeAuthority = await token2022Mint([ExtensionType.TransferFeeConfig], (m) => [
        createInitializeTransferFeeConfigInstruction(m, payer.publicKey, payer.publicKey, 300, 1_000_000n, TOKEN_2022_PROGRAM_ID),
      ]);
      const closeAuthority = await token2022Mint([ExtensionType.MintCloseAuthority], (m) => [
        createInitializeMintCloseAuthorityInstruction(m, payer.publicKey, TOKEN_2022_PROGRAM_ID),
      ]);
      const inert = await token2022Mint([ExtensionType.MintCloseAuthority, ExtensionType.TransferFeeConfig], (m) => [
        createInitializeMintCloseAuthorityInstruction(m, null, TOKEN_2022_PROGRAM_ID),
        createInitializeTransferFeeConfigInstruction(m, null, payer.publicKey, 100, 1_000_000n, TOKEN_2022_PROGRAM_ID),
      ]);
      const highFee = await token2022Mint([ExtensionType.TransferFeeConfig], (m) => [
        createInitializeTransferFeeConfigInstruction(m, null, payer.publicKey, 301, 1_000_000n, TOKEN_2022_PROGRAM_ID),
      ]);
      // 1% today, but a 5% fee scheduled before the authority was dropped still takes effect two epochs later.
      const scheduledFee = await token2022Mint([ExtensionType.TransferFeeConfig], (m) => [
        createInitializeTransferFeeConfigInstruction(m, payer.publicKey, payer.publicKey, 100, 1_000_000n, TOKEN_2022_PROGRAM_ID),
      ]);
      await send([
        createSetTransferFeeInstruction(scheduledFee, payer.publicKey, [], 500, 1_000_000n, TOKEN_2022_PROGRAM_ID),
        createSetAuthorityInstruction(scheduledFee, payer.publicKey, AuthorityType.TransferFeeConfig, null, [], TOKEN_2022_PROGRAM_ID),
      ]);

      const leaf = [{ recipient: attacker.publicKey, amount: 1n }];
      const r = await commitRound(
        [
          { mint: permanentDelegate, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
          { mint: nonTransferable, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
          { mint: hooked, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
          { mint: defaultFrozen, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
          { mint: freezeNotAllowed, tokenProgram: TOKEN_PROGRAM_ID, leaves: leaf },
          { mint: freezeAllowed, tokenProgram: TOKEN_PROGRAM_ID, leaves: leaf },
          { mint: hookAuthorityOnly, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
          { mint: feeAuthority, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
          { mint: closeAuthority, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
          { mint: inert, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
          { mint: highFee, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
          { mint: scheduledFee, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: leaf },
        ],
        { allowFreezeMask: (1 << 3) | (1 << 5) }
      );
      const [pd, nt, hk, df, fna, fa, hao, fee, close, ok, high, scheduled] = r.assets;
      await expectFail(send([await openIx(r, pd)]), /MintExtensionNotAllowed/);
      await expectFail(send([await openIx(r, nt)]), /MintExtensionNotAllowed/);
      await expectFail(send([await openIx(r, hk)]), /MintHasTransferHook/);
      await expectFail(send([await openIx(r, df)]), /MintDefaultFrozen/);
      await expectFail(send([await openIx(r, fna)]), /MintHasFreezeAuthority/);
      await send([await openIx(r, fa)]);
      await expectFail(send([await openIx(r, hao)]), /MintHasTransferHook/);
      await send([await openIx(r, fee)]); // a fee authority is accepted, and 3% is within the cap
      await expectFail(send([await openIx(r, close)]), /MintHasCloseAuthority/);
      await expectFail(send([await openIx(r, high)]), /MintTransferFeeTooHigh/);
      await expectFail(send([await openIx(r, scheduled)]), /MintTransferFeeTooHigh/);
      await send([await openIx(r, ok)]);
    });

    it("rejects a token program that doesn't own the mint", async () => {
      const mint = await legacyMint();
      const r = await commitRound([{ mint, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: [{ recipient: attacker.publicKey, amount: 1n }] }]);
      await expectFail(send([await openIx(r, r.assets[0])]), /InvalidTokenProgram/);
    });
  });

  describe("Token-2022 recipients and fees", () => {
    it("transfer-fee mint: funded is measured, pushes are gross, close harvests withheld fees", async () => {
      const mint = await token2022Mint([ExtensionType.TransferFeeConfig], (m) => [
        createInitializeTransferFeeConfigInstruction(m, null, payer.publicKey, 100, 1_000_000_000n, TOKEN_2022_PROGRAM_ID),
      ]);
      const people = recipients(2);
      const r = await commitRound(
        [{ mint, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: [{ recipient: people[0].publicKey, amount: 1_000_000n }, { recipient: people[1].publicKey, amount: 2_000_000n }] }],
        { expiresInSecs: 20 }
      );
      const a = r.assets[0];
      await openFundActivate(r, a, 3_100_000n); // 1% fee withheld in the vault → 3,069,000 usable
      const asset = await program.account.roundAsset.fetch(a.roundAsset);
      expect(asset.funded.toNumber()).to.equal(3_069_000);

      await push(r, a, 0);
      expect(await tokenBalance(ata(mint, people[0].publicKey, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID)).to.equal(990_000n);
      expect(await tokenBalance(a.vault, TOKEN_2022_PROGRAM_ID)).to.equal(2_069_000n);

      const header = await program.account.roundHeader.fetch(r.round);
      await waitForChainTime(header.expiryTs.toNumber() + 1);
      await send([rolloverAtaIx(r, a), await closeIx(r, a)]);
      expect(await connection.getAccountInfo(a.vault)).to.be.null;
      // 2,069,000 gross leaves the vault; 1% is withheld on arrival
      expect(await tokenBalance(ata(mint, keeper.publicKey, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID)).to.equal(2_048_310n);
    });

    it("a memo-required destination fails the push; the recipient self-claims elsewhere", async () => {
      const mint = await token2022Mint([], () => []);
      const person = Keypair.generate();
      const r = await commitRound([{ mint, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: [{ recipient: person.publicKey, amount: 123n }] }]);
      const a = r.assets[0];
      await openFundActivate(r, a);

      const personAta = ata(mint, person.publicKey, TOKEN_2022_PROGRAM_ID);
      await send(
        [
          createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, personAta, person.publicKey, mint, TOKEN_2022_PROGRAM_ID),
          createReallocateInstruction(personAta, payer.publicKey, [ExtensionType.MemoTransfer], person.publicKey, [], TOKEN_2022_PROGRAM_ID),
          createEnableRequiredMemoTransfersInstruction(personAta, person.publicKey, [], TOKEN_2022_PROGRAM_ID),
        ],
        [person]
      );
      await expectFail(push(r, a, 0), /memo/i);

      const side = await createAccount(connection, payer, mint, person.publicKey, Keypair.generate(), CONFIRM, TOKEN_2022_PROGRAM_ID);
      await selfClaim(r, a, 0, person, side);
      expect(await tokenBalance(side, TOKEN_2022_PROGRAM_ID)).to.equal(123n);
      await expectFail(push(r, a, 0), /AlreadyClaimed/);
    });
  });

  describe("batched pushes (push_payouts)", () => {
    let mint: PublicKey;
    before(async () => {
      mint = await legacyMint();
    });

    interface BlockOptions {
      destinations?: PublicKey[];
      amounts?: Map<number, bigint>;
      leaves?: object[];
      proof?: Buffer[];
    }

    /** A push_payouts instruction for `pushes` within the block; other leaves in it are sent as skips. */
    async function blockIx(r: BuiltRound, a: BuiltAsset, firstLeaf: number, level: number, pushes: number[], o: BlockOptions = {}) {
      const destinations: PublicKey[] = [];
      const encoded = a.leaves.slice(firstLeaf, firstLeaf + 2 ** level).map((leaf) => {
        const amount = bn(o.amounts?.get(leaf.leafIdx) ?? leaf.amount);
        if (!pushes.includes(leaf.leafIdx)) return { skip: { recipient: leaf.recipient, amount } };
        destinations.push(ata(a.mint, leaf.recipient, a.tokenProgram));
        return { push: { amount } };
      });
      return program.methods
        .pushPayouts({ firstLeaf, level, leaves: (o.leaves ?? encoded) as any, proof: (o.proof ?? a.tree.blockProof(firstLeaf, level)).map(bytes) })
        .accountsStrict({ payer: payer.publicKey, round: r.round, roundAsset: a.roundAsset, mint: a.mint, vault: a.vault, tokenProgram: a.tokenProgram })
        .remainingAccounts((o.destinations ?? destinations).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
        .instruction();
    }

    const createAtas = (a: BuiltAsset, owners: PublicKey[]) =>
      owners.map((owner) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(a.mint, owner, a.tokenProgram), owner, a.mint, a.tokenProgram));
    const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

    async function createInChunks(a: BuiltAsset, owners: PublicKey[]) {
      for (let i = 0; i < owners.length; i += 5) await send(createAtas(a, owners.slice(i, i + 5)));
    }

    it("pays whole blocks and the short last block, each with one shared proof", async () => {
      const people = recipients(20);
      const r = await commitRound([{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: people.map((p, i) => ({ recipient: p.publicKey, amount: BigInt(100 + i) })) }]);
      const a = r.assets[0];
      await openFundActivate(r, a);
      await createInChunks(a, people.map((p) => p.publicKey));

      const signature = await send([limit, await blockIx(r, a, 0, 3, range(0, 8))]);
      await send([limit, await blockIx(r, a, 8, 3, range(8, 16))]);
      await send([limit, await blockIx(r, a, 16, 3, range(16, 20))]); // the tree's last block holds 4 leaves
      for (const [i, person] of people.entries()) {
        expect(await tokenBalance(ata(mint, person.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)).to.equal(BigInt(100 + i));
      }
      const asset = await program.account.roundAsset.fetch(a.roundAsset);
      expect(BigInt(asset.claimed.toString())).to.equal(a.allocated);

      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      console.log(`      8-payout block: ${tx?.transaction.message.serialize().length} byte message, ${tx?.meta?.computeUnitsConsumed} CU`);
    });

    it("skips leaves already paid or not pushed, and pays into accounts it creates in the same transaction", async () => {
      const people = recipients(8);
      const r = await commitRound([{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: people.map((p, i) => ({ recipient: p.publicKey, amount: BigInt(1_000 + i) })) }]);
      const a = r.assets[0];
      await openFundActivate(r, a);
      await push(r, a, 1); // leaf 1 already paid by a single push

      await send([limit, ...createAtas(a, [0, 2, 3].map((i) => people[i].publicKey)), await blockIx(r, a, 0, 2, [0, 1, 2, 3])]);
      await send([limit, ...createAtas(a, [4, 6].map((i) => people[i].publicKey)), await blockIx(r, a, 4, 2, [4, 6])]);

      for (const [i, person] of people.entries()) {
        const expected = i === 5 || i === 7 ? 0n : BigInt(1_000 + i);
        const balance = await tokenBalance(ata(mint, person.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID).catch(() => 0n);
        expect(balance, `leaf ${i}`).to.equal(expected);
      }
      const asset = await program.account.roundAsset.fetch(a.roundAsset);
      expect(asset.claimed.toNumber()).to.equal(1_000 + 1_001 + 1_002 + 1_003 + 1_004 + 1_006);
    });

    it("rejects misaligned or wrong-sized blocks, tampered amounts, and destinations other than the recipient's canonical account", async () => {
      const people = recipients(8);
      const r = await commitRound([{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: people.map((p) => ({ recipient: p.publicKey, amount: 50n })) }]);
      const a = r.assets[0];
      await openFundActivate(r, a);
      await createInChunks(a, people.map((p) => p.publicKey));
      const good = (await blockIx(r, a, 0, 2, [0, 1])).keys;

      // no proof exists for a misaligned block, so send a valid proof of another block's shape
      await expectFail(send([limit, await blockIx(r, a, 1, 1, [1, 2], { proof: a.tree.blockProof(0, 1) })]), /InvalidBlock/);
      await expectFail(send([limit, await blockIx(r, a, 0, 6, [0])]), /InvalidBlock/);
      const threeLeaves = a.leaves.slice(0, 3).map((l) => ({ skip: { recipient: l.recipient, amount: bn(l.amount) } }));
      await expectFail(send([limit, await blockIx(r, a, 0, 2, [], { leaves: threeLeaves })]), /InvalidBlock/);
      await expectFail(send([limit, await blockIx(r, a, 0, 2, [0, 1], { amounts: new Map([[1, 51n]]) })]), /InvalidProof/);
      await expectFail(send([limit, await blockIx(r, a, 0, 2, [0, 1], { destinations: [good[6].pubkey] })]), /InvalidBlock/);
      await expectFail(
        send([limit, await blockIx(r, a, 0, 2, [0, 1], { destinations: [good[6].pubkey, good[7].pubkey, ata(mint, people[2].publicKey, TOKEN_PROGRAM_ID)] })]),
        /InvalidBlock/
      );

      // the attacker's own ATA for leaf 0: its owner isn't the committed recipient
      const attackerAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, attacker.publicKey, false, "confirmed", CONFIRM);
      await expectFail(send([limit, await blockIx(r, a, 0, 2, [0], { destinations: [attackerAta.address] })]), /InvalidProof/);
      // an account the recipient owns, but not their canonical ATA
      const side = await createAccount(connection, payer, mint, people[0].publicKey, Keypair.generate(), CONFIRM, TOKEN_PROGRAM_ID);
      await expectFail(send([limit, await blockIx(r, a, 0, 2, [0], { destinations: [side] })]), /DestinationNotCanonicalAta/);

      await send([limit, await blockIx(r, a, 0, 2, [0, 1, 2, 3])]);
      expect((await program.account.roundAsset.fetch(a.roundAsset)).claimed.toNumber()).to.equal(200);
    });

    it("refuses a leaf that names the asset account itself, so a bad tree can't mark tokens paid without moving them", async () => {
      // A fresh distributor, so the round and asset addresses are known before the tree is built.
      const dist = await createDistributor(await legacyMint(), keeper);
      const assetAccount = roundAssetPda(roundPda(dist.pda, 0n), 0);
      const [alice] = recipients(1);
      const r = await commitRound(
        [{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: [{ recipient: assetAccount, amount: 100n }, { recipient: alice.publicKey, amount: 50n }] }],
        { dist }
      );
      const a = r.assets[0];
      expect(a.roundAsset.equals(assetAccount)).to.be.true;
      await openFundActivate(r, a);
      // the asset account's canonical ATA is the vault itself
      expect(ata(mint, assetAccount, TOKEN_PROGRAM_ID).equals(a.vault)).to.be.true;

      await expectFail(push(r, a, 0, { destination: a.vault }), /DestinationIsVault/);
      await createInChunks(a, [alice.publicKey]);
      await expectFail(send([limit, await blockIx(r, a, 0, 1, [0, 1])]), /DestinationIsVault/);
      expect((await program.account.roundAsset.fetch(a.roundAsset)).claimed.toNumber()).to.equal(0);

      // the honest leaf in the same block still pays on its own
      await send([limit, await blockIx(r, a, 0, 1, [1])]);
      expect(await tokenBalance(ata(mint, alice.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)).to.equal(50n);
      expect((await program.account.roundAsset.fetch(a.roundAsset)).claimed.toNumber()).to.equal(50);
    });

    it("pays an 8-leaf block of a 65,536-leaf asset at proof depth 16 in one transaction", async () => {
      const people = recipients(8);
      const filler = Keypair.generate().publicKey;
      const r = await commitRound([
        { mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: Array.from({ length: 65_536 }, (_, i) => ({ recipient: i >= 40_000 && i < 40_008 ? people[i - 40_000].publicKey : filler, amount: 1n })) },
      ]);
      const a = r.assets[0];
      await openFundActivate(r, a);
      await createInChunks(a, people.map((p) => p.publicKey));
      expect(a.tree.blockProof(40_000, 3)).to.have.length(13);

      const signature = await send([limit, await blockIx(r, a, 40_000, 3, range(40_000, 40_008))]);
      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const units = tx?.meta?.computeUnitsConsumed ?? Number.MAX_SAFE_INTEGER;
      console.log(`      8-payout block at depth 16: ${tx?.transaction.message.serialize().length} byte message, ${units} CU`);
      expect(units).to.be.lessThan(600_000);
      for (const person of people) expect(await tokenBalance(ata(mint, person.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)).to.equal(1n);
    });

    /** A v0 transaction reading its extra accounts from a fresh lookup table — how a 16- or 32-destination block fits. */
    async function sendWithLookupTable(ixs: TransactionInstruction[], addresses: PublicKey[]): Promise<string> {
      const [createIx, table] = AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: await connection.getSlot("finalized"),
      });
      await send([createIx]);
      for (let i = 0; i < addresses.length; i += 20) {
        await send([AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: addresses.slice(i, i + 20) })]);
      }
      // addresses added to a table become usable from the next slot
      const extendedAt = await connection.getSlot("confirmed");
      while ((await connection.getSlot("confirmed")) <= extendedAt) await sleep(400);
      const lookup = (await connection.getAddressLookupTable(table, { commitment: "confirmed" })).value!;

      const unique = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ++txNonce });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [unique, ...ixs] }).compileToV0Message([lookup]);
      const tx = new VersionedTransaction(message);
      tx.sign([payer]);
      const signature = await connection.sendTransaction(tx);
      const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (result.value.err) throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
      return signature;
    }

    it("pays full 32- and 16-leaf blocks, the largest the program accepts, through a lookup table", async () => {
      const people = recipients(64);
      const r = await commitRound([{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: people.map((p, i) => ({ recipient: p.publicKey, amount: BigInt(10 + i) })) }]);
      const a = r.assets[0];
      await openFundActivate(r, a);
      await createInChunks(a, people.map((p) => p.publicKey));
      const destinations = people.map((p) => ata(mint, p.publicKey, TOKEN_PROGRAM_ID));

      const signature = await sendWithLookupTable([limit, await blockIx(r, a, 0, 5, range(0, 32))], destinations.slice(0, 32));
      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const units = tx?.meta?.computeUnitsConsumed ?? Number.MAX_SAFE_INTEGER;
      console.log(`      32-payout block via lookup table: ${tx?.transaction.message.serialize().length} byte message, ${units} CU`);
      expect(units).to.be.lessThan(1_000_000);
      await sendWithLookupTable([limit, await blockIx(r, a, 32, 4, range(32, 48))], destinations.slice(32, 48));
      await sendWithLookupTable([limit, await blockIx(r, a, 48, 4, range(48, 64))], destinations.slice(48, 64));

      for (const [i, person] of people.entries()) {
        expect(await tokenBalance(ata(mint, person.publicKey, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID)).to.equal(BigInt(10 + i));
      }
      const asset = await program.account.roundAsset.fetch(a.roundAsset);
      expect(asset.claimed.toNumber()).to.equal(people.reduce((sum, _, i) => sum + 10 + i, 0));
    });

    it("pays a block of a transfer-fee Token-2022 asset: claimed counts the gross amount, recipients get it less the fee", async () => {
      const feeMint = await token2022Mint([ExtensionType.TransferFeeConfig], (m) => [
        createInitializeTransferFeeConfigInstruction(m, null, payer.publicKey, 100, 1_000_000_000n, TOKEN_2022_PROGRAM_ID),
      ]);
      const people = recipients(8);
      const r = await commitRound([
        { mint: feeMint, tokenProgram: TOKEN_2022_PROGRAM_ID, leaves: people.map((p) => ({ recipient: p.publicKey, amount: 1_000_000n })) },
      ]);
      const a = r.assets[0];
      await openFundActivate(r, a, 8_100_000n); // 1% withheld on arrival → 8,019,000 usable
      await createInChunks(a, people.map((p) => p.publicKey));

      const signature = await send([limit, await blockIx(r, a, 0, 3, range(0, 8))]);
      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      console.log(`      8-payout Token-2022 block: ${tx?.transaction.message.serialize().length} byte message, ${tx?.meta?.computeUnitsConsumed} CU`);
      for (const person of people) {
        expect(await tokenBalance(ata(feeMint, person.publicKey, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID)).to.equal(990_000n);
      }
      expect((await program.account.roundAsset.fetch(a.roundAsset)).claimed.toNumber()).to.equal(8_000_000);
    });
  });

  describe("keeper key rotation", () => {
    it("only the current keeper can propose, only the proposed key can accept", async () => {
      const next = Keypair.generate();
      const proposeIx = (from: Keypair, to: PublicKey) =>
        program.methods
          .proposeRootAuthority(to)
          .accountsStrict({ rootAuthority: from.publicKey, distributor: main.pda })
          .instruction();
      const acceptIx = (who: Keypair) =>
        program.methods
          .acceptRootAuthority()
          .accountsStrict({ newRootAuthority: who.publicKey, distributor: main.pda })
          .instruction();

      // the deployer / fee payer has no power over the distributor
      await expectFail(send([await proposeIx(payer, payer.publicKey)]), /Unauthorized/);
      await expectFail(send([await proposeIx(attacker, attacker.publicKey)], [attacker]), /Unauthorized/);
      // a default or unchanged key could never be accepted, but would overwrite a real pending proposal
      await expectFail(send([await proposeIx(keeper, PublicKey.default)], [keeper]), /InvalidRootAuthority/);
      await expectFail(send([await proposeIx(keeper, keeper.publicKey)], [keeper]), /InvalidRootAuthority/);
      await send([await proposeIx(keeper, next.publicKey)], [keeper]);
      await expectFail(send([await acceptIx(attacker)], [attacker]), /NoPendingRootAuthority/);
      await send([await acceptIx(next)], [next]);

      await expectFail(send([await openRoundIx(main, await nextRoundId(main), sha256(randomBytes(32)), keeper)], [keeper]), /Unauthorized/);
      const mint = await legacyMint();
      const r = buildRound(main, await seededIntent(main, next), [{ mint, tokenProgram: TOKEN_PROGRAM_ID, leaves: [{ recipient: attacker.publicKey, amount: 1n }] }]);
      await expectFail(send([await commitIx(r, { expiryTs: (await chainNow()) + 3600 })], [keeper]), /Unauthorized/);
      await send([await commitIx(r, { expiryTs: (await chainNow()) + 3600, rootAuthority: next })], [next]);

      const account = await program.account.distributor.fetch(main.pda);
      expect(account.rootAuthority.equals(next.publicKey)).to.be.true;
      expect(account.creator.equals(keeper.publicKey)).to.be.true;
      expect(account.pendingRootAuthority).to.be.null;
    });
  });
});
