/**
 * The autonomous payout rounds for one coin, one resumable step at a time.
 * The distributor program's RoundIntent account records every sampling
 * commitment, so the keeper can't revise them once made.
 *
 * A collecting round moves through:
 *   OPEN      open_round commits sha256(secret); take holder snapshots at
 *             jittered times until the cost-based trigger fires; close_window
 *             then records the snapshot chain head and reads SOL/USD from Pyth
 *   CLOSED    record_seed takes the hash of a block after the window from
 *             SlotHashes (if that block ages out first, the round is abandoned)
 *   SEEDED    buy the basket, one coin per step, each from a throwaway wallet
 *   FUNDED    reserve this coin's inventory, allocate, publish the artifacts
 *   PREPARED  commit the round, revealing the secret
 *
 * Committing hands the round to the paying list and immediately opens the
 * next window, so time spent paying out never goes unsampled. A paying round:
 *   COMMITTED open, fund and activate each asset (abandoning one that keeps failing)
 *   ACTIVE    push payouts; small first-time payouts and undeliverable ones
 *             are left for self-claim
 *
 * Nothing waits forever: failing buys are skipped, failing activations and
 * closes back off and give up or retry slowly, RPC trouble pauses pushes
 * without blaming holders, and expired rounds are closed without blocking
 * the next one. Each step saves state, and on-chain actions check chain state
 * first, so a restarted keeper never commits, funds or pays twice.
 */
import { createHash, createHmac, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccountLenForMint, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { canonicalJson } from "../../lib/canonicalJson";
import { readArtifacts, writeArtifacts } from "../../lib/artifacts";
import { u32le } from "../../lib/merkle";
import { decodePriceUpdateV2, toMicroUsd } from "../../lib/pyth";
import { lamportChange, resolveSignature, sendTransaction } from "../../lib/send";
import { vetMintData } from "../../lib/tokens";
import {
  DistributorClient,
  EXPIRED_SEED_ABANDON_DELAY_SECS,
  IntentView,
  SEEDED_ABANDON_DELAY_SECS,
  intentRecord,
  isLeafClaimed,
} from "../distributor/client";
import { HolderSource } from "../holders/source";
import { ActiveRound, ExpiringAsset, ExpiringRound, FundedAsset, KeeperState, KeeperStore, PayoutFailure, PurchaseRecord, creditInventory } from "../state";
import { backoffSecs, countLikelyEligible, debit, isTransientError, reconcileReserve, shouldAutoPush } from "./operations";
import { RoundPolicy } from "./policy";
import {
  PreparedRound,
  PurchaseEvidence,
  RoundInputs,
  expectedMinLeafAmount,
  extendSnapshotChain,
  parseRoundInputs,
  parseSnapshot,
  prepareRound,
  roundExclusions,
  snapshotChainGenesis,
  snapshotHash,
} from "./prepare";
import { ArtifactPublisher } from "./publisher";
import { deriveSampleSeed, selectSampleIndices } from "./select";
import { SweepResult, sweepSwapWallet } from "./swapWallet";
import { LAMPORTS_PER_SIGNATURE, estimateRoundCost, estimateTransactions, shouldTriggerRound } from "./trigger";
import { PayoutLeafRow, Rational, Snapshot, TokenAccountRow } from "./types";

/** Operating knobs that don't change who gets paid (those live in the RoundPolicy). */
export interface RoundParams {
  meanSnapshotIntervalSecs: number;
  /** A window that still hasn't triggered after this long is abandoned and restarted, bounding snapshot storage. */
  maxWindowSecs: number;
  roundCostMaxBps: number;
  expectedBasketSize: number;
  priorityFeeLamportsPerTx: bigint;
  /** Basket-buy price impact assumed by the cost model, in bps of the pot. */
  swapImpactBps: number;
  /** SOL sent to each swap wallet beyond the buy itself, for fees and temporary accounts; swept back after. */
  swapOverheadLamports: bigint;
  maxBuyAttempts: number;
  /** Coins still unbought this long after seeding are skipped. */
  maxBuyPhaseSecs: number;
  /** Coins charging a higher transfer fee than this are held back from a round. */
  maxTransferFeeBps: number;
  maxActivationAttempts: number;
  maxPushesPerStep: number;
  maxPushAttempts: number;
}

export interface BasketCandidate {
  mint: PublicKey;
  tokenProgram: PublicKey;
}

export type SwapResult = { signature: string } | { skipped: string };

export interface BasketSource {
  select(): Promise<BasketCandidate[]>;
  /**
   * Swaps exactly `lamports` of SOL for the candidate from `wallet`, a
   * throwaway wallet funded only for this buy. Whatever lands in the wallet is
   * swept to the keeper afterwards, so the swap needn't report amounts.
   */
  swap(candidate: BasketCandidate, wallet: Keypair, lamports: bigint): Promise<SwapResult>;
}

export interface PriceSource {
  /** Index-coin price in lamports per raw token unit. */
  poolPrice(): Promise<Rational>;
}

export interface RoundEngineDeps {
  connection: Connection;
  keeper: Keypair;
  client: DistributorClient;
  indexMint: PublicKey;
  holders: HolderSource;
  price: PriceSource;
  basket: BasketSource;
  publisher: ArtifactPublisher;
  store: KeeperStore;
  /** Must be the policy the distributor was created with; checked whenever a round opens. */
  policy: RoundPolicy;
  params: RoundParams;
  now: () => number;
}

const MAX_ASSETS_PER_ROUND = 30;
/** Payouts go out in aligned blocks of 2^3 = 8 leaves, one push_payouts transaction each. */
const PUSH_BLOCK_LEVEL = 3;
const PUSH_BLOCK_SIZE = 2 ** PUSH_BLOCK_LEVEL;

type RoundTree = PreparedRound["trees"]["assets"][number];
/** A payout chosen for pushing this step; `rent` is nonzero when its token account must be created. */
interface PushPlan {
  leaf: PayoutLeafRow;
  failure?: PayoutFailure;
  rent: bigint;
}
/** Account sizes from programs/stonkfolio-distributor/src/state.rs, for rent reserves. */
const ROUND_HEADER_SPACE = 158;
const ROUND_INTENT_SPACE = 226;
const roundAssetSpace = (leaves: number) => 243 + Math.ceil(leaves / 8);
const VAULT_SPACE_ESTIMATE = 200; // a token account, with room for Token-2022 extensions

/** Push errors a retry can't fix: the recipient has to self-claim into another account. */
const PERMANENT_PAYOUT_ERROR =
  /memo|AccountFrozen|custom program error: 0x11\b|ClaimDestinationMismatch|DestinationNotCanonicalAta|InvalidAccountData|MintMismatch/i;

/** close_window rejections that clear up on their own as the window ages or Pyth updates. */
const TRANSIENT_CLOSE_ERROR = /WindowTooShort|PriceTooOld|PriceConfidenceTooWide/;

function errorText(err: unknown): string {
  const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
  return `${e?.message ?? String(err)} ${(e?.logs ?? e?.transactionLogs ?? []).join(" ")}`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0].slice(0, 200);
}

function jitteredIntervalSecs(secret: Buffer, index: number, meanSecs: number): number {
  const draw = createHmac("sha256", secret).update("snapshot").update(u32le(index)).digest().readBigUInt64LE(0);
  const unit = Number(draw >> 11n) / 2 ** 53; // [0, 1)
  return Math.max(1, Math.round(meanSecs * (0.5 + unit)));
}

export class RoundEngine {
  private readonly prepared = new Map<string, PreparedRound>();
  private readonly rents = new Map<string, bigint>();
  /** The collecting round whose on-chain intent this process has already confirmed is open. */
  private confirmedOpen?: bigint;

  constructor(private readonly deps: RoundEngineDeps) {}

  /** Performs at most one unit of work, saves, and describes what happened. */
  async step(): Promise<string> {
    const state = this.deps.store.load();
    const report = await this.advance(state);
    this.deps.store.save(state);
    return report;
  }

  private async advance(state: KeeperState): Promise<string> {
    const now = this.deps.now();
    const close = this.dueClose(state, now);
    if (close) return this.closeExpired(state, close.round, close.asset, now);

    // The collecting round goes first so its snapshots stay on schedule while earlier rounds pay out.
    const collecting = state.round ? await this.advanceCollecting(state, state.round, now) : await this.openRound(state, now);
    if (!/^(collecting|waiting)/.test(collecting) || state.paying.length === 0) return collecting;
    return (await this.advancePaying(state, now)) ?? collecting;
  }

  private get distributorKey(): string {
    return this.deps.client.distributor.toBase58();
  }

  // --- costs -----------------------------------------------------------------

  /** Books a transaction's lamport cost (fees and rent, less refunds) to a round, or to the basket when no round owns it. */
  private async chargeTx(state: KeeperState, round: ActiveRound | undefined, signature: string | undefined): Promise<void> {
    if (!signature) return;
    const change = await lamportChange(this.deps.connection, signature, this.deps.keeper.publicKey);
    const cost = change ? -change.delta : LAMPORTS_PER_SIGNATURE;
    if (round) round.operationsSpentLamports += cost;
    else if (cost > 0n) debit(state.ledger, "basketLamports", cost);
    else state.ledger.basketLamports -= cost;
  }

  private async estimateCost(potLamports: bigint, eligible: number): Promise<bigint> {
    const { params } = this.deps;
    const payouts = eligible * params.expectedBasketSize;
    return estimateRoundCost({
      // Conservative: assumes every eligible holder needs a new token account for every coin.
      newTokenAccounts: payouts,
      tokenAccountRentLamports: await this.rent(165),
      transactions: estimateTransactions(payouts, 1, params.expectedBasketSize),
      signaturesPerTransaction: 1,
      priorityFeeLamportsPerTransaction: params.priorityFeeLamportsPerTx,
      swapImpactLamports: (potLamports * BigInt(params.swapImpactBps)) / 10_000n,
    });
  }

  /**
   * Lamports a round consumes beyond basket purchases: recipient token-account
   * rent and transaction fees, the intent's permanent rent, plus round-account
   * rent that only comes back when the round's assets close after expiry.
   */
  private async estimateOperatingCost(eligible: number, assets: number): Promise<bigint> {
    const { params } = this.deps;
    const payouts = eligible * assets;
    const perRound = estimateRoundCost({
      newTokenAccounts: payouts,
      tokenAccountRentLamports: await this.rent(165),
      transactions: estimateTransactions(payouts, 1, assets),
      signaturesPerTransaction: 1,
      priorityFeeLamportsPerTransaction: params.priorityFeeLamportsPerTx,
      swapImpactLamports: 0n,
    });
    const roundAccounts =
      (await this.rent(ROUND_HEADER_SPACE)) +
      (await this.rent(ROUND_INTENT_SPACE)) +
      BigInt(assets) * ((await this.rent(roundAssetSpace(eligible))) + (await this.rent(VAULT_SPACE_ESTIMATE)));
    return perRound + roundAccounts;
  }

  private async rent(bytes: number): Promise<bigint> {
    const key = `bytes:${bytes}`;
    let rent = this.rents.get(key);
    if (rent === undefined) {
      rent = BigInt(await this.deps.connection.getMinimumBalanceForRentExemption(bytes));
      this.rents.set(key, rent);
    }
    return rent;
  }

  private async tokenAccountRent(mint: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return this.rent(165);
    const key = `mint:${mint.toBase58()}`;
    let rent = this.rents.get(key);
    if (rent === undefined) {
      const space = getAccountLenForMint(await getMint(this.deps.connection, mint, "confirmed", tokenProgram));
      rent = await this.rent(space);
      this.rents.set(key, rent);
    }
    return rent;
  }

  // --- collecting --------------------------------------------------------------

  private async advanceCollecting(state: KeeperState, round: ActiveRound, now: number): Promise<string> {
    switch (round.status) {
      case "OPEN":
        return this.collect(state, round, now);
      case "CLOSED":
        return this.seed(state, round);
      case "SEEDED":
        return this.buyBasket(state, round, now);
      case "FUNDED":
        return this.prepare(round);
      case "PREPARED":
        return this.commit(state, round, now);
      default:
        throw new Error(`round ${round.roundId} is ${round.status} but is still the collecting round`);
    }
  }

  private async openRound(state: KeeperState, now: number): Promise<string> {
    const { client, policy, store } = this.deps;
    await this.chargeTx(state, undefined, await client.ensureDistributor(policy));
    const roundId = await client.nextRoundId();
    const orphan = await client.fetchIntent(roundId);
    if (orphan) return this.abandonOrphan(state, orphan);

    const secret = randomBytes(32);
    const commitmentHex = createHash("sha256").update(secret).digest("hex");
    const round: ActiveRound = {
      roundId,
      status: "OPEN",
      secretHex: secret.toString("hex"),
      commitmentHex,
      windowStartSlot: 0,
      windowStartTs: now,
      nextSnapshotAt: now,
      candidates: [],
      chainHeadHex: snapshotChainGenesis(this.distributorKey, roundId),
      latestEligibleCount: 0,
      operationsSpentLamports: 0n,
      failures: [],
    };
    state.round = round;
    // Saved before the commitment is sent, so a crash after it lands can't lose the secret.
    store.save(state);
    await this.chargeTx(state, round, await client.openRound(roundId, Buffer.from(commitmentHex, "hex")));
    return `round ${roundId} opened (commitment ${commitmentHex.slice(0, 16)}…)`;
  }

  /** An intent at the next round id with no saved secret (e.g. a lost state file) can only be abandoned. */
  private async abandonOrphan(state: KeeperState, intent: IntentView): Promise<string> {
    let signature: string;
    try {
      signature = await this.deps.client.abandonRound(intent.roundId);
    } catch (err) {
      if (!/CannotAbandon/.test(errorText(err))) throw err;
      const when =
        intent.status === "seeded"
          ? `at ${intent.seedTs + SEEDED_ABANDON_DELAY_SECS}`
          : `once its seed block has aged out of SlotHashes, and not before ${intent.closeTs + EXPIRED_SEED_ABANDON_DELAY_SECS}`;
      return `waiting: round ${intent.roundId} is ${intent.status} on-chain but its secret isn't in this keeper's state; it can be abandoned ${when}`;
    }
    await this.chargeTx(state, undefined, signature);
    return `round ${intent.roundId} abandoned: it was ${intent.status} on-chain with no saved secret`;
  }

  private async abandonCollecting(state: KeeperState, round: ActiveRound, reason: string, alreadyAbandoned = false): Promise<string> {
    const { client, store } = this.deps;
    if (!alreadyAbandoned) await this.chargeTx(state, round, await client.abandonRound(round.roundId));
    reconcileReserve(state.ledger, round.operationsReserveLamports ?? 0n, round.operationsSpentLamports);
    fs.rmSync(store.roundDir(round.roundId), { recursive: true, force: true });
    this.confirmedOpen = undefined;
    state.round = undefined;
    return `round ${round.roundId} abandoned: ${reason}`;
  }

  private async collect(state: KeeperState, round: ActiveRound, now: number): Promise<string> {
    const { client, params, policy } = this.deps;
    if (this.confirmedOpen !== round.roundId) {
      const intent = await client.fetchIntent(round.roundId);
      if (!intent) {
        await this.chargeTx(state, round, await client.openRound(round.roundId, Buffer.from(round.commitmentHex, "hex")));
        return `round ${round.roundId} opened (commitment ${round.commitmentHex.slice(0, 16)}…)`;
      }
      if (intent.secretCommitmentHex !== round.commitmentHex) {
        throw new Error(`round ${round.roundId} intent holds a different secret commitment than this keeper saved`);
      }
      round.windowStartSlot = intent.openSlot;
      round.windowStartTs = intent.openTs;
      // A close that landed before a crash is adopted as-is, before any new snapshot.
      if (intent.status !== "open") return this.adoptClosedWindow(round, intent);
      this.confirmedOpen = round.roundId;
    }

    if (now >= round.nextSnapshotAt) return this.takeSnapshot(round, now);
    if (round.candidates.length < policy.samplesPerRound) return `collecting snapshots (${round.candidates.length}/${policy.samplesPerRound})`;

    const pot = state.ledger.basketLamports;
    if (round.latestEligibleCount === 0) {
      // A round with nobody to pay would only spend rent; keep sampling until someone qualifies.
      if (now - round.windowStartTs >= params.maxWindowSecs) {
        return this.abandonCollecting(state, round, `no holder qualified within ${params.maxWindowSecs}s; restarting the window`);
      }
      return "waiting: no holder is eligible yet";
    }
    const decision = shouldTriggerRound({
      potLamports: pot,
      estimatedCostLamports: await this.estimateCost(pot, round.latestEligibleCount),
      maxCostBps: params.roundCostMaxBps,
      windowStartTs: round.windowStartTs,
      nowTs: now,
      minWindowSecs: policy.minWindowSecs,
    });
    if (!decision.trigger) {
      if (now - round.windowStartTs >= params.maxWindowSecs) {
        return this.abandonCollecting(state, round, `the pot didn't cover a round's costs within ${params.maxWindowSecs}s; restarting the window`);
      }
      return `waiting: ${decision.reason}`;
    }

    try {
      await this.chargeTx(state, round, await client.closeWindow(round.roundId, Buffer.from(round.chainHeadHex, "hex"), round.candidates.length));
    } catch (err) {
      const reason = errorText(err).match(TRANSIENT_CLOSE_ERROR);
      if (reason) return `waiting: round ${round.roundId} window can't close yet (${reason[0]})`;
      throw err;
    }
    this.confirmedOpen = undefined;
    const closed = await client.fetchIntent(round.roundId);
    return this.adoptClosedWindow(round, closed!);
  }

  private adoptClosedWindow(round: ActiveRound, intent: IntentView): string {
    if (intent.status === "open") throw new Error(`round ${round.roundId} window close did not land`);
    if (intent.snapshotChainHeadHex !== round.chainHeadHex || intent.snapshotCount !== round.candidates.length) {
      throw new Error(`round ${round.roundId} window was closed with a snapshot chain this keeper doesn't have`);
    }
    round.windowEndSlot = intent.closeSlot;
    round.status = "CLOSED";
    const { price, exponent } = intent.solUsd;
    return `round ${round.roundId} window closed with ${round.candidates.length} snapshots (SOL/USD ${price}e${exponent})`;
  }

  private async takeSnapshot(round: ActiveRound, now: number): Promise<string> {
    const { holders, price, store, indexMint, params } = this.deps;
    const rows = await holders.fetch(indexMint);
    if (rows.slot < round.windowStartSlot) {
      return `waiting: holder index is at slot ${rows.slot}, before round ${round.roundId} opened at slot ${round.windowStartSlot}`;
    }
    const snapshot: Snapshot = {
      index: round.candidates.length,
      slot: rows.slot,
      timestamp: now,
      poolPrice: await price.poolPrice(),
      accounts: rows.accounts,
    };
    const file = store.snapshotPath(round.roundId, snapshot.index);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, canonicalJson(snapshot));

    const hash = snapshotHash(snapshot);
    round.candidates.push({ index: snapshot.index, slot: snapshot.slot, sha256: hash });
    round.chainHeadHex = extendSnapshotChain(round.chainHeadHex, hash);
    round.latestEligibleCount =
      (await this.likelyEligible(rows.accounts, snapshot.poolPrice)) ??
      Math.min(new Set(rows.accounts.map((a) => a.owner)).size, this.deps.policy.maxLeavesPerAsset);
    round.nextSnapshotAt = now + jitteredIntervalSecs(Buffer.from(round.secretHex, "hex"), snapshot.index + 1, params.meanSnapshotIntervalSecs);
    return `snapshot ${snapshot.index} at slot ${snapshot.slot}: ${rows.accounts.length} token accounts, ~${round.latestEligibleCount} eligible`;
  }

  /** Holders already worth the threshold, priced with Pyth read off-chain; undefined if the price can't be read. */
  private async likelyEligible(accounts: TokenAccountRow[], poolPrice: Rational): Promise<number | undefined> {
    const { policy, connection, keeper } = this.deps;
    let solUsdMicro: bigint;
    try {
      const info = await connection.getAccountInfo(new PublicKey(policy.priceFeedAccount), "confirmed");
      if (!info) return undefined;
      const update = decodePriceUpdateV2(info.data);
      solUsdMicro = toMicroUsd(update.price, update.exponent);
    } catch {
      return undefined;
    }
    const excluded = new Set(roundExclusions({ policy, rootAuthority: keeper.publicKey.toBase58() }).map((e) => e.owner));
    return countLikelyEligible(accounts, poolPrice, solUsdMicro, {
      minEligibleUsdMicro: policy.minEligibleUsdMicro,
      excluded,
      excludeOffCurve: policy.excludeOffCurveOwners,
      cap: policy.maxLeavesPerAsset,
    });
  }

  private async seed(state: KeeperState, round: ActiveRound): Promise<string> {
    const { client, connection, policy } = this.deps;
    let intent = await client.fetchIntent(round.roundId);
    if (intent?.status === "closed") {
      const target = intent.closeSlot + policy.seedSlotOffset;
      const slot = await connection.getSlot("confirmed");
      // SlotHashes holds parent slots, so the target block is listed from the slot after it.
      if (slot <= target) return `waiting for slot ${target + 1} to seed round ${round.roundId} (at ${slot})`;
      try {
        await this.chargeTx(state, round, await client.recordSeed(round.roundId));
      } catch (err) {
        const text = errorText(err);
        if (/SeedNotYetAvailable/.test(text)) return `waiting: round ${round.roundId} seed block isn't in SlotHashes yet`;
        if (!/SeedExpired/.test(text)) throw err;
        // The program only lets a round with an expired seed be abandoned a day after its window closed.
        const abandonAt = intent.closeTs + EXPIRED_SEED_ABANDON_DELAY_SECS;
        if (this.deps.now() < abandonAt) {
          return `waiting: round ${round.roundId}'s seed block aged out before it was recorded; it can be abandoned at ${new Date(abandonAt * 1000).toISOString()}`;
        }
        return this.abandonCollecting(state, round, "its seed block aged out of SlotHashes before it was recorded");
      }
      intent = await client.fetchIntent(round.roundId);
    }
    if (intent?.status === "abandoned") return this.abandonCollecting(state, round, "it was abandoned on-chain", true);
    if (intent?.status !== "seeded") throw new Error(`round ${round.roundId} intent is ${intent?.status ?? "missing"}, expected seeded`);
    round.status = "SEEDED";
    return `round ${round.roundId} seeded from slot ${intent.seedSlot}`;
  }

  // --- buying ----------------------------------------------------------------

  private async buyBasket(state: KeeperState, round: ActiveRound, now: number): Promise<string> {
    const { basket, params } = this.deps;
    if (!round.purchases) {
      const seen = new Set<string>();
      const candidates = (await basket.select()).filter((c) => !seen.has(c.mint.toBase58()) && seen.add(c.mint.toBase58()));
      const pot = state.ledger.basketLamports;
      // Round costs come out of the coin's own fees, set aside before anything is bought.
      const reserve = candidates.length > 0 ? await this.estimateOperatingCost(round.latestEligibleCount, candidates.length) : 0n;
      const perCoin = candidates.length > 0 && pot > reserve ? (pot - reserve) / BigInt(candidates.length) : 0n;
      round.seededAt = now;
      if (perCoin <= params.swapOverheadLamports) {
        // A seeded round can't be abandoned; it goes ahead with whatever inventory this coin already holds.
        round.purchases = [];
        return `round ${round.roundId}: pot of ${pot} lamports can't fund buys after ${reserve} lamports of round costs; paying out held inventory only`;
      }
      state.ledger.basketLamports -= reserve;
      state.ledger.operationsLamports += reserve;
      round.operationsReserveLamports = reserve;
      round.basketBudgetLamports = perCoin;
      round.purchases = candidates.map((c) => ({
        mint: c.mint.toBase58(),
        tokenProgram: c.tokenProgram.toBase58(),
        status: "pending",
        lamportsSpent: 0n,
        received: 0n,
        signatures: [],
        attempts: 0,
      }));
      return `basket of ${candidates.length} coins selected, ${perCoin} lamports each (${reserve} reserved for round costs)`;
    }

    const next = round.purchases.find((p) => p.status === "pending");
    if (next) {
      if (next.swapWalletSecretHex) return this.settlePurchase(state, round, next);
      if (now >= (round.seededAt ?? now) + params.maxBuyPhaseSecs) {
        const skipped = round.purchases.filter((p) => p.status === "pending");
        for (const purchase of skipped) {
          purchase.status = "skipped";
          purchase.reason = `buying window of ${params.maxBuyPhaseSecs}s elapsed`;
        }
        return `round ${round.roundId}: buying window elapsed; skipped ${skipped.length} coin(s)`;
      }
      return this.buyOne(state, round, next);
    }
    return this.reserveAssets(state, round);
  }

  private async buyOne(state: KeeperState, round: ActiveRound, purchase: PurchaseRecord): Promise<string> {
    const { connection, keeper, basket, store, params } = this.deps;
    const wallet = Keypair.generate();
    const lamports = round.basketBudgetLamports!;
    purchase.swapWalletSecretHex = Buffer.from(wallet.secretKey).toString("hex");
    purchase.lastError = undefined;
    purchase.reason = undefined;
    purchase.sweepSignatures = [];
    purchase.outputChecks = 0;
    store.save(state); // the wallet's key is on disk before any SOL can reach it

    const funding = lamports + params.swapOverheadLamports;
    await sendTransaction(
      connection,
      [SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: wallet.publicKey, lamports: funding })],
      keeper,
      [],
      undefined,
      (signature, lastValidBlockHeight) => {
        purchase.funding = { signature, lastValidBlockHeight, lamports: funding };
        store.save(state);
      }
    );
    try {
      const result = await basket.swap({ mint: new PublicKey(purchase.mint), tokenProgram: new PublicKey(purchase.tokenProgram) }, wallet, lamports);
      if ("skipped" in result) {
        purchase.reason = result.skipped;
      } else {
        purchase.signatures = [result.signature];
        purchase.lamportsSpent = lamports;
      }
    } catch (err) {
      purchase.lastError = firstLine(errorText(err));
    }
    store.save(state);
    return this.settlePurchase(state, round, purchase);
  }

  /** Sweeps the current attempt's swap wallet back to the keeper and records what the attempt bought. */
  private async settlePurchase(state: KeeperState, round: ActiveRound, purchase: PurchaseRecord): Promise<string> {
    const { connection, keeper, client, params } = this.deps;
    const wallet = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(purchase.swapWalletSecretHex!, "hex")));
    let funded = false;
    if (purchase.funding) {
      const outcome = await resolveSignature(connection, purchase.funding.signature, purchase.funding.lastValidBlockHeight);
      if (outcome === "pending") return `waiting: funding of the swap wallet for ${purchase.mint} is unconfirmed`;
      funded = outcome === "landed";
    }
    const mint = new PublicKey(purchase.mint);
    const tokenProgram = new PublicKey(purchase.tokenProgram);
    // The sweep is journaled before it's sent, so a crash after it lands replays from the record
    // rather than re-sweeping an emptied wallet (which would book the buy twice and strand its tokens).
    let sweep: SweepResult;
    const recorded = purchase.sweep;
    const sweepOutcome = recorded ? await resolveSignature(connection, recorded.signature, recorded.lastValidBlockHeight) : undefined;
    if (sweepOutcome === "pending") return `waiting: sweep of the swap wallet for ${purchase.mint} is unconfirmed`;
    if (recorded && sweepOutcome === "landed") {
      sweep = { tokens: recorded.tokens, lamportsReturned: recorded.lamportsReturned, signature: recorded.signature };
    } else {
      purchase.sweep = undefined;
      sweep = await sweepSwapWallet(connection, keeper, wallet, mint, tokenProgram, (signature, lastValidBlockHeight, plan) => {
        purchase.sweep = { signature, lastValidBlockHeight, ...plan };
        this.deps.store.save(state);
      });
    }

    // The keeper's real SOL cost for this attempt, fees included, net of everything swept back.
    let cost = 0n;
    if (funded) {
      const change = await lamportChange(connection, purchase.funding!.signature, keeper.publicKey);
      cost += change ? -change.delta : purchase.funding!.lamports + LAMPORTS_PER_SIGNATURE;
    }
    if (sweep.signature) {
      const change = await lamportChange(connection, sweep.signature, keeper.publicKey);
      cost -= change ? change.delta : sweep.lamportsReturned - LAMPORTS_PER_SIGNATURE;
    }
    if (cost > 0n) debit(state.ledger, "basketLamports", cost);
    else state.ledger.basketLamports -= cost;
    // Both costs are booked; a later pass over this wallet only books its own sweep.
    purchase.funding = undefined;
    purchase.sweep = undefined;
    if (sweep.signature) purchase.sweepSignatures = [...(purchase.sweepSignatures ?? []), sweep.signature];

    if (sweep.tokens === 0n && !purchase.reason) {
      // A swap that landed may not show its output yet on a lagging RPC; keep the wallet and look again.
      const swaps = purchase.signatures.length > 0 ? purchase.signatures : await this.walletSwaps(wallet.publicKey, purchase.sweepSignatures ?? []);
      if (swaps.length > 0 && (purchase.outputChecks ?? 0) < 5) {
        purchase.signatures = swaps;
        purchase.outputChecks = (purchase.outputChecks ?? 0) + 1;
        return `waiting: output of the ${purchase.mint} swap isn't visible in its wallet yet (check ${purchase.outputChecks})`;
      }
    }
    purchase.swapWalletSecretHex = undefined;

    if (sweep.tokens > 0n) {
      purchase.status = "bought";
      purchase.buyer = wallet.publicKey.toBase58();
      purchase.received = sweep.tokens;
      if (purchase.lamportsSpent === 0n) purchase.lamportsSpent = round.basketBudgetLamports!;
      // The swap landed but its signature wasn't saved (a crash or timeout): recover it from the wallet's history.
      if (purchase.signatures.length === 0) purchase.signatures = await this.walletSwaps(wallet.publicKey, purchase.sweepSignatures ?? []);
      creditInventory(state, purchase.mint, purchase.tokenProgram, await client.netAfterTransferFee(mint, tokenProgram, sweep.tokens));
      return `bought ${sweep.tokens} of ${purchase.mint} for ${purchase.lamportsSpent} lamports (${cost} lamports with fees)`;
    }

    purchase.signatures = [];
    purchase.lamportsSpent = 0n;
    if (purchase.reason) {
      purchase.status = "skipped";
      return `skipped ${purchase.mint}: ${purchase.reason}`;
    }
    purchase.attempts += 1;
    const why = purchase.lastError ?? "no tokens arrived";
    if (purchase.attempts >= params.maxBuyAttempts) {
      purchase.status = "skipped";
      purchase.reason = `failed ${purchase.attempts} times: ${why}`;
      return `skipped ${purchase.mint} after ${purchase.attempts} failed buys: ${why}`;
    }
    return `buy of ${purchase.mint} failed (attempt ${purchase.attempts}): ${why}`;
  }

  /** Successful transactions a swap wallet signed, other than the keeper's sweeps of it: its swaps. */
  private async walletSwaps(wallet: PublicKey, sweeps: string[]): Promise<string[]> {
    const { connection } = this.deps;
    const history = await connection.getSignaturesForAddress(wallet, { limit: 20 }, "confirmed");
    const swaps: string[] = [];
    for (const entry of history) {
      if (entry.err || sweeps.includes(entry.signature)) continue;
      const tx = await connection.getTransaction(entry.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const signers = tx.transaction.message.staticAccountKeys.slice(0, tx.transaction.message.header.numRequiredSignatures);
      if (signers.some((key) => key.equals(wallet))) swaps.push(entry.signature);
    }
    return swaps;
  }

  /**
   * Reserves this coin's inventory for the round: coins bought this round
   * first, then leftovers carried from earlier rounds, re-vetted now in case a
   * mint changed since it was bought.
   */
  private async reserveAssets(state: KeeperState, round: ActiveRound): Promise<string> {
    const { connection, client, policy, params } = this.deps;
    const bought = round.purchases!.filter((p) => p.status === "bought");
    const held = Object.entries(state.inventory)
      .sort(([, a], [, b]) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
      .map(([mint]) => mint);
    const mints = [...new Set([...bought.map((p) => p.mint), ...held])].slice(0, 100);
    const infos = mints.length > 0 ? await connection.getMultipleAccountsInfo(mints.map((m) => new PublicKey(m)), "confirmed") : [];

    round.assets = [];
    const heldBack: string[] = [];
    for (const [i, mint] of mints.entries()) {
      if (round.assets.length === MAX_ASSETS_PER_ROUND) break;
      const entry = state.inventory[mint];
      if (!entry || entry.amount === 0n) continue;
      const info = infos[i];
      const vet = !info
        ? { ok: false as const, reason: "mint not found" }
        : !info.owner.equals(new PublicKey(entry.tokenProgram))
          ? { ok: false as const, reason: "owned by a different token program" }
          : vetMintData(info.data, info.owner, { allowFreezeAuthority: false, maxTransferFeeBps: params.maxTransferFeeBps });
      if (!vet.ok) {
        heldBack.push(`${mint} (${vet.reason})`);
        continue;
      }
      const tokenProgram = new PublicKey(entry.tokenProgram);
      round.assets.push({
        mint,
        tokenProgram: entry.tokenProgram,
        fundAmount: entry.amount,
        allocatable: await client.netAfterTransferFee(new PublicKey(mint), tokenProgram, entry.amount),
        minLeafAmount: expectedMinLeafAmount(policy, bought.find((p) => p.mint === mint)),
        status: "pending",
        attempts: 0,
      });
      delete state.inventory[mint];
    }
    round.status = "FUNDED";
    const note = heldBack.length > 0 ? `; held back ${heldBack.join(", ")}` : "";
    return `round ${round.roundId} funded with ${round.assets.length} coin(s)${note}`;
  }

  private releaseReservation(state: KeeperState, asset: FundedAsset, status: "abandoned" | "released"): void {
    if (asset.status === "pending") creditInventory(state, asset.mint, asset.tokenProgram, asset.fundAmount);
    asset.status = status;
  }

  // --- preparing and committing ----------------------------------------------

  private purchaseEvidence(round: ActiveRound): PurchaseEvidence[] {
    return (round.purchases ?? [])
      .filter((p) => p.status === "bought")
      .map((p) => ({
        mint: p.mint,
        tokenProgram: p.tokenProgram,
        buyer: p.buyer ?? this.deps.keeper.publicKey.toBase58(),
        lamportsSpent: p.lamportsSpent,
        received: p.received,
        signatures: p.signatures,
      }));
  }

  private async buildInputs(round: ActiveRound): Promise<RoundInputs> {
    const { store, policy, client, keeper, indexMint } = this.deps;
    const intent = await client.fetchIntent(round.roundId);
    if (intent?.status !== "seeded" && intent?.status !== "committed") throw new Error(`round ${round.roundId} intent is not seeded`);
    const record = intentRecord(intent);
    const seed = deriveSampleSeed(round.roundId, Buffer.from(record.seedHashHex, "hex"), Buffer.from(round.secretHex, "hex"));
    const selected = selectSampleIndices(round.candidates, { startSlot: record.openSlot, endSlot: record.closeSlot }, policy.samplesPerRound, seed);
    return {
      version: 2,
      programId: client.program.programId.toBase58(),
      distributor: this.distributorKey,
      indexMint: indexMint.toBase58(),
      rootAuthority: keeper.publicKey.toBase58(),
      roundId: round.roundId,
      policy,
      intent: record,
      secretHex: round.secretHex,
      candidates: round.candidates,
      selectedSnapshots: selected.map((index) =>
        parseSnapshot(JSON.parse(fs.readFileSync(store.snapshotPath(round.roundId, index), "utf-8")), `snapshot ${index}`)
      ),
      purchases: this.purchaseEvidence(round),
      assets: round.assets!.map((a) => ({ mint: a.mint, tokenProgram: a.tokenProgram, allocatable: a.allocatable, minLeafAmount: a.minLeafAmount })),
    };
  }

  private async prepare(round: ActiveRound): Promise<string> {
    const { store, publisher } = this.deps;
    const prepared = prepareRound(await this.buildInputs(round));
    const bundle = store.bundleDir(round.roundId);
    fs.rmSync(bundle, { recursive: true, force: true });
    writeArtifacts(bundle, prepared.meta, prepared.files);
    const manifestHashHex = prepared.manifestHash.toString("hex");
    await publisher.publish(bundle, round.roundId, manifestHashHex);

    round.manifestHashHex = manifestHashHex;
    round.assetsRootHex = prepared.trees.assetsRoot.toString("hex");
    this.prepared.set(round.roundId.toString(), prepared);
    round.status = "PREPARED";
    const empty = prepared.trees.assets.length === 0 ? " (nothing payable; committing an empty round)" : "";
    return `round ${round.roundId} prepared and published: artifact hash ${manifestHashHex}${empty}`;
  }

  private loadPrepared(round: ActiveRound): PreparedRound {
    const cached = this.prepared.get(round.roundId.toString());
    if (cached) return cached;
    const { files } = readArtifacts(this.deps.store.bundleDir(round.roundId));
    const prepared = prepareRound(parseRoundInputs(files.get("inputs.json")!));
    if (prepared.manifestHash.toString("hex") !== round.manifestHashHex) {
      throw new Error(`round ${round.roundId} bundle no longer reproduces its recorded artifact hash`);
    }
    this.prepared.set(round.roundId.toString(), prepared);
    return prepared;
  }

  private async commit(state: KeeperState, round: ActiveRound, now: number): Promise<string> {
    const { client, policy, store } = this.deps;
    const prepared = this.loadPrepared(round);
    if (!(await client.fetchRound(round.roundId))) {
      round.commitSignature = await client.commitRound({
        roundId: round.roundId,
        secret: Buffer.from(round.secretHex, "hex"),
        assetsRoot: prepared.trees.assetsRoot,
        artifactHash: prepared.manifestHash,
        assetCount: prepared.trees.assets.length,
        expiryTs: now + policy.roundExpirySecs,
        allowFreezeAuthorityMask: 0,
      });
      await this.chargeTx(state, round, round.commitSignature);
    }
    const header = await client.fetchRound(round.roundId);
    if (!header) throw new Error(`round ${round.roundId} commit did not land`);
    if (Buffer.from(header.assetsRoot).toString("hex") !== round.assetsRootHex) {
      throw new Error(`round ${round.roundId} is committed with a different assets root`);
    }
    round.expiryTs = header.expiryTs.toNumber();
    round.status = "COMMITTED";

    // Coins the allocation left out (no eligible recipients) go back to inventory.
    const allocated = new Set(prepared.trees.assets.map((a) => a.mint.toBase58()));
    for (const asset of round.assets ?? []) if (!allocated.has(asset.mint)) this.releaseReservation(state, asset, "released");
    // The bundle carries the selected snapshots; the raw candidates aren't needed any more.
    fs.rmSync(store.snapshotDir(round.roundId), { recursive: true, force: true });
    state.round = undefined;

    if (prepared.trees.assets.length === 0) return this.finishPaying(state, round, "committed with nothing to pay");
    // Tracked from commit onward, so leftovers are always recovered after expiry.
    state.expiring.push({
      roundId: round.roundId,
      expiryTs: round.expiryTs,
      assets: prepared.trees.assets.map((a) => ({ assetIdx: a.assetIdx, mint: a.mint.toBase58(), tokenProgram: a.tokenProgram.toBase58() })),
    });
    state.paying.push(round);
    return `round ${round.roundId} committed (expires ${round.expiryTs}); the next window opens now`;
  }

  // --- paying ----------------------------------------------------------------

  /** One unit of payout work on the oldest paying round that has any; undefined if all are backing off. */
  private async advancePaying(state: KeeperState, now: number): Promise<string | undefined> {
    for (const round of [...state.paying]) {
      if (round.expiryTs !== undefined && now >= round.expiryTs) {
        return this.finishPaying(state, round, "expired before every payout landed; unpaid holders can no longer claim it");
      }
      const report = round.status === "COMMITTED" ? await this.activate(state, round, now) : await this.push(state, round, now);
      if (report) return report;
    }
    return undefined;
  }

  private async activate(state: KeeperState, round: ActiveRound, now: number): Promise<string | undefined> {
    const { client, params } = this.deps;
    const prepared = this.loadPrepared(round);
    let backingOff = false;
    for (const asset of prepared.trees.assets) {
      const mint = asset.mint.toBase58();
      const funded = round.assets!.find((a) => a.mint === mint);
      if (!funded) throw new Error(`round ${round.roundId} has no reservation for ${mint}`);
      if (funded.status !== "pending") continue;

      const account = await client.fetchRoundAsset(round.roundId, asset.assetIdx);
      if (account && "active" in account.status) {
        // Activated before a crash: return whatever the transfer didn't need.
        const used = await client.grossForNet(asset.mint, asset.tokenProgram, BigInt(account.funded.toString()));
        funded.status = "active";
        if (funded.fundAmount > used) creditInventory(state, mint, funded.tokenProgram, funded.fundAmount - used);
        continue;
      }
      if ((funded.nextAttemptAt ?? 0) > now) {
        backingOff = true;
        continue;
      }
      try {
        const { signature, transferred } = await client.openFundActivate(round.roundId, asset, prepared.trees.assetsTree!.proof(asset.assetIdx), funded.fundAmount);
        await this.chargeTx(state, round, signature);
        funded.status = "active";
        if (funded.fundAmount > transferred) creditInventory(state, mint, funded.tokenProgram, funded.fundAmount - transferred);
        return `asset ${asset.assetIdx} (${mint}) active`;
      } catch (err) {
        const text = errorText(err);
        funded.lastError = firstLine(text);
        if (isTransientError(text)) {
          funded.nextAttemptAt = now + 30;
          return `waiting: activation of asset ${asset.assetIdx} hit an RPC error (${funded.lastError})`;
        }
        funded.attempts += 1;
        if (funded.attempts >= params.maxActivationAttempts) {
          this.releaseReservation(state, funded, "abandoned");
          return `asset ${asset.assetIdx} (${mint}) abandoned after ${funded.attempts} failed activations: ${funded.lastError}`;
        }
        funded.nextAttemptAt = now + backoffSecs(funded.attempts);
        return `activation of asset ${asset.assetIdx} (${mint}) failed (attempt ${funded.attempts}): ${funded.lastError}`;
      }
    }
    if (backingOff) return undefined;
    round.status = "ACTIVE";
    const active = round.assets!.filter((a) => a.status === "active").length;
    return `round ${round.roundId}: ${active} of ${prepared.trees.assets.length} assets active`;
  }

  private recordFailure(round: ActiveRound, assetIdx: number, leaf: PayoutLeafRow, fields: Omit<PayoutFailure, "assetIdx" | "leafIdx" | "recipient">): void {
    const record: PayoutFailure = { assetIdx, leafIdx: leaf.leafIdx, recipient: leaf.recipient, ...fields, reason: fields.reason.slice(0, 500) };
    const existing = round.failures.find((f) => f.assetIdx === assetIdx && f.leafIdx === leaf.leafIdx);
    if (existing) Object.assign(existing, record);
    else round.failures.push(record);
  }

  /**
   * Pushes a step's worth of payouts in aligned blocks of 8 leaves, each block
   * one `push_payouts` transaction with a single shared proof (smaller when a
   * block's new token accounts don't fit).
   */
  private async push(state: KeeperState, round: ActiveRound, now: number): Promise<string | undefined> {
    const { client, params, policy, connection } = this.deps;
    const prepared = this.loadPrepared(round);
    const blocks: { asset: RoundTree; firstLeaf: number; candidates: { leaf: PayoutLeafRow; failure?: PayoutFailure }[] }[] = [];
    let queued = 0;
    let deferred = 0;
    for (const asset of prepared.trees.assets) {
      if (round.assets!.find((a) => a.mint === asset.mint.toBase58())?.status !== "active") continue;
      const account = await client.fetchRoundAsset(round.roundId, asset.assetIdx);
      if (!account) continue;
      const bitmap = Buffer.from(account.bitmap);
      const leaves = prepared.allocation.assets[asset.assetIdx].leaves;
      for (let firstLeaf = 0; firstLeaf < leaves.length; firstLeaf += PUSH_BLOCK_SIZE) {
        const candidates: { leaf: PayoutLeafRow; failure?: PayoutFailure }[] = [];
        for (const leaf of leaves.slice(firstLeaf, firstLeaf + PUSH_BLOCK_SIZE)) {
          if (isLeafClaimed(bitmap, leaf.leafIdx)) continue;
          const failure = round.failures.find((f) => f.assetIdx === asset.assetIdx && f.leafIdx === leaf.leafIdx);
          if (failure?.permanent) continue;
          if ((failure?.nextAttemptAt ?? 0) > now) {
            deferred++;
            continue;
          }
          candidates.push({ leaf, failure });
        }
        if (candidates.length === 0) continue;
        if (queued >= params.maxPushesPerStep) {
          deferred += candidates.length;
          continue;
        }
        blocks.push({ asset, firstLeaf, candidates });
        queued += candidates.length;
      }
    }
    if (blocks.length === 0) return deferred > 0 ? undefined : this.finishPaying(state, round, "complete");

    // Whether each destination exists decides both the rent rule and whether the push must create it.
    const all = blocks.flatMap((block) => block.candidates.map(({ leaf }) => ({ asset: block.asset, leaf })));
    const destinations = all.map(({ asset, leaf }) => getAssociatedTokenAddressSync(asset.mint, new PublicKey(leaf.recipient), true, asset.tokenProgram));
    const existing = new Set<string>();
    for (let i = 0; i < destinations.length; i += 100) {
      const infos = await connection.getMultipleAccountsInfo(destinations.slice(i, i + 100), "confirmed");
      infos.forEach((info, j) => info && existing.add(destinations[i + j].toBase58()));
    }
    const prices = new Map(prepared.inputs.purchases.map((p) => [p.mint, { lamports: p.lamportsSpent, tokens: p.received }]));

    let pushed = 0;
    let transactions = 0;
    let leftForSelfClaim = 0;
    for (const block of blocks) {
      const { asset } = block;
      const plan: PushPlan[] = [];
      for (const { leaf, failure } of block.candidates) {
        const destination = getAssociatedTokenAddressSync(asset.mint, new PublicKey(leaf.recipient), true, asset.tokenProgram);
        const accountExists = existing.has(destination.toBase58());
        const rent = accountExists ? 0n : await this.tokenAccountRent(asset.mint, asset.tokenProgram);
        const worthPushing = shouldAutoPush({
          accountExists,
          amount: leaf.amount,
          price: prices.get(asset.mint.toBase58()),
          rentLamports: rent,
          minRentMultiple: policy.autoPushMinRentMultiple,
        });
        if (!worthPushing) {
          this.recordFailure(round, asset.assetIdx, leaf, {
            attempts: failure?.attempts ?? 0,
            permanent: true,
            reason: `left for self-claim: worth less than ${policy.autoPushMinRentMultiple}x the rent of a new token account`,
          });
          leftForSelfClaim++;
          continue;
        }
        plan.push({ leaf, failure, rent });
      }
      if (plan.length === 0) continue;
      const allLeaves = prepared.allocation.assets[asset.assetIdx].leaves;
      const outcome = await this.pushBlock(round, asset, allLeaves, block.firstLeaf, PUSH_BLOCK_LEVEL, plan, now);
      pushed += outcome.pushed;
      transactions += outcome.transactions;
      if (outcome.paused) return `waiting: payouts paused after an RPC error (${outcome.paused}); ${pushed} pushed this step`;
    }
    const small = leftForSelfClaim > 0 ? `, ${leftForSelfClaim} too small to push (left for self-claim)` : "";
    return `round ${round.roundId}: pushed ${pushed} payouts in ${transactions} transaction(s)${small}, ${deferred} still queued`;
  }

  /**
   * Pushes the planned leaves inside one aligned block, halving the block
   * until each part fits a transaction. If the program refuses a part with
   * several pushes, its leaves are retried one at a time, so a single
   * undeliverable destination (memo-required, frozen) doesn't hold up the rest.
   */
  private async pushBlock(
    round: ActiveRound,
    asset: RoundTree,
    allLeaves: PayoutLeafRow[],
    firstLeaf: number,
    level: number,
    plan: PushPlan[],
    now: number
  ): Promise<{ pushed: number; transactions: number; paused?: string }> {
    const { client, params } = this.deps;
    const end = firstLeaf + 2 ** level;
    const inBlock = plan.filter((p) => p.leaf.leafIdx >= firstLeaf && p.leaf.leafIdx < end);
    if (inBlock.length === 0) return { pushed: 0, transactions: 0 };

    const planned = new Map(inBlock.map((p) => [p.leaf.leafIdx, p]));
    const instructions = await client.pushPayoutBlockInstructions(
      round.roundId,
      asset,
      firstLeaf,
      level,
      allLeaves.slice(firstLeaf, end).map((leaf) => ({ leaf, push: planned.has(leaf.leafIdx), createAccount: (planned.get(leaf.leafIdx)?.rent ?? 0n) > 0n }))
    );
    if (level > 0 && !client.fitsInOneTransaction(instructions)) {
      const half = level - 1;
      const left = await this.pushBlock(round, asset, allLeaves, firstLeaf, half, inBlock, now);
      if (left.paused) return left;
      const right = await this.pushBlock(round, asset, allLeaves, firstLeaf + 2 ** half, half, inBlock, now);
      return { pushed: left.pushed + right.pushed, transactions: left.transactions + right.transactions, paused: right.paused };
    }

    try {
      await client.sendPushBlock(instructions);
    } catch (err) {
      const reason = errorText(err);
      if (isTransientError(reason)) {
        // Not the holders' fault: pause without counting an attempt against them.
        for (const p of inBlock) {
          this.recordFailure(round, asset.assetIdx, p.leaf, { attempts: p.failure?.attempts ?? 0, permanent: false, reason, nextAttemptAt: now + 30 });
        }
        return { pushed: 0, transactions: 1, paused: firstLine(reason) };
      }
      if (inBlock.length > 1) {
        let pushed = 0;
        let transactions = 1;
        for (const p of inBlock) {
          const single = await this.pushBlock(round, asset, allLeaves, p.leaf.leafIdx, 0, [p], now);
          pushed += single.pushed;
          transactions += single.transactions;
          if (single.paused) return { pushed, transactions, paused: single.paused };
        }
        return { pushed, transactions };
      }
      const [p] = inBlock;
      const attempts = (p.failure?.attempts ?? 0) + 1;
      const permanent = PERMANENT_PAYOUT_ERROR.test(reason) || attempts >= params.maxPushAttempts;
      this.recordFailure(round, asset.assetIdx, p.leaf, { attempts, permanent, reason, nextAttemptAt: now + backoffSecs(attempts, 30) });
      return { pushed: 0, transactions: 1 };
    }
    round.operationsSpentLamports += LAMPORTS_PER_SIGNATURE + inBlock.reduce((sum, p) => sum + p.rent, 0n);
    const done = new Set(inBlock.map((p) => p.failure));
    round.failures = round.failures.filter((f) => !done.has(f));
    return { pushed: inBlock.length, transactions: 1 };
  }

  private finishPaying(state: KeeperState, round: ActiveRound, outcome: string): string {
    const { store } = this.deps;
    // Assets never activated (the round expired first) give their reservation back.
    for (const asset of round.assets ?? []) if (asset.status === "pending") this.releaseReservation(state, asset, "released");
    fs.mkdirSync(store.roundDir(round.roundId), { recursive: true });
    fs.writeFileSync(path.join(store.roundDir(round.roundId), "payout-failures.json"), canonicalJson(round.failures));
    const { returned, overrun } = reconcileReserve(state.ledger, round.operationsReserveLamports ?? 0n, round.operationsSpentLamports);
    state.paying = state.paying.filter((r) => r.roundId !== round.roundId);
    this.prepared.delete(round.roundId.toString());
    const unpaid = round.failures.filter((f) => f.permanent).length;
    const costs = overrun > 0n ? `costs ran ${overrun} lamports over reserve` : `${returned} lamports of unused reserve back to the pot`;
    return `round ${round.roundId} ${outcome}; ${unpaid} payout(s) left for self-claim; ${costs}`;
  }

  // --- expiry ----------------------------------------------------------------

  private dueClose(state: KeeperState, now: number): { round: ExpiringRound; asset: ExpiringAsset } | undefined {
    for (const round of state.expiring) {
      if (round.expiryTs > now) continue;
      const asset = round.assets.find((a) => (a.nextAttemptAt ?? 0) <= now);
      if (asset) return { round, asset };
    }
    return undefined;
  }

  /** Returns an expired asset's leftovers and rent to the keeper; a failing close backs off instead of blocking. */
  private async closeExpired(state: KeeperState, expiring: ExpiringRound, asset: ExpiringAsset, now: number): Promise<string> {
    const { client } = this.deps;
    const mint = new PublicKey(asset.mint);
    const tokenProgram = new PublicKey(asset.tokenProgram);
    if (await client.fetchRoundAsset(expiring.roundId, asset.assetIdx)) {
      const vault = getAssociatedTokenAddressSync(mint, client.roundAsset(expiring.roundId, asset.assetIdx), true, tokenProgram);
      const remaining = await client.tokenBalance(vault, tokenProgram);
      try {
        const signature = await client.closeAsset(expiring.roundId, asset.assetIdx, mint, tokenProgram);
        await this.chargeTx(state, undefined, signature); // the rent refund goes back to the pot
      } catch (err) {
        const text = errorText(err);
        asset.attempts = (asset.attempts ?? 0) + 1;
        asset.nextAttemptAt = now + (/RoundNotExpired/.test(text) ? 30 : backoffSecs(asset.attempts));
        return `close of round ${expiring.roundId} asset ${asset.assetIdx} deferred (attempt ${asset.attempts}): ${firstLine(text)}`;
      }
      if (remaining > 0n) creditInventory(state, asset.mint, asset.tokenProgram, await client.netAfterTransferFee(mint, tokenProgram, remaining));
    }
    expiring.assets = expiring.assets.filter((a) => a !== asset);
    if (expiring.assets.length === 0) state.expiring = state.expiring.filter((r) => r !== expiring);
    return `closed round ${expiring.roundId} asset ${asset.assetIdx}; leftovers returned to this coin's inventory`;
  }
}
