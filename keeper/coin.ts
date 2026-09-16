/**
 * One launched coin's keeper tick. Each sub-step runs on its own, so a
 * failing pool, swap or RPC call never stops the others — above all, never
 * the payout rounds, which step on every tick:
 *
 *   settle journaled transactions → migrate (if the curve is full) → claim
 *   curve and pool fees → partner surplus → watch the pool → round steps →
 *   platform revenue → both buybacks → burn held index coins → liquidity
 *
 * Round steps (and so holder snapshots, which record the pool price) run
 * before the keeper's own buys, so those buys can't lift a snapshot's price.
 *
 * Every SOL movement that changes the ledger is journaled before it's sent
 * and applied only once its transaction is known to have landed, so a
 * confirmation timeout can neither lose a fee claim nor spend a bucket twice.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  createBurnCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { DynamicBondingCurveClient, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { OnSigned, lamportChange, resolveSignature, sendTransaction } from "../lib/send";
import { FeeSplitBps, splitRevenue } from "./feeSplit";
import { transferSol } from "./payouts";
import { DAMM_V2_CUSTOMIZABLE_CONFIG, DbcPoolView, claimCurveFees, curveSwap, migrateToDammV2, readDbcPool } from "./meteora/dbc";
import {
  DammPoolView,
  OwnedPosition,
  claimPositionFees,
  dammSwap,
  findLockedPosition,
  readDammPool,
  unclaimedPositionFees,
} from "./meteora/dammv2";
import { debit } from "./round/operations";
import { RoundEngine } from "./round/engine";
import { KeeperState, KeeperStore, Ledger, PendingAction } from "./state";

export interface CoinThresholds {
  minFeeClaimLamports: bigint;
  minBuybackLamports: bigint;
  minPlatformPayoutLamports: bigint;
  liquidityTargetLamports: bigint;
  minLiquidityAddLamports: bigint;
  slippageBps: number;
  maxRoundStepsPerTick: number;
  /** Round steps stop once a tick has run this long, so one busy coin can't stall the others. */
  maxTickMs: number;
}

export interface CoinKeeperDeps {
  connection: Connection;
  keeper: Keypair;
  dbc: DynamicBondingCurveClient;
  cpAmm: CpAmm;
  /** This coin's DBC pool (it stays the coin's identity after migration). */
  pool: PublicKey;
  /** $STONKFOLIO's DBC pool, where the platform buyback share is spent. */
  platformTokenPool: PublicKey;
  store: KeeperStore;
  engine: RoundEngine;
  shares: FeeSplitBps;
  platformRevenueAddress: PublicKey;
  thresholds: CoinThresholds;
  log: (message: string) => void;
  /** Checked between round steps, so a shutdown finishes the current step and stops. */
  shouldStop?: () => boolean;
}

/** Program refusals of the partner surplus withdrawal before it's treated as nothing to withdraw. */
const SURPLUS_REFUSALS_BEFORE_DONE = 3;
/** DBC's SurplusHasBeenWithdraw (6025): the surplus is already out. */
const SURPLUS_ALREADY_WITHDRAWN = /0x1789\b|SurplusHasBeenWithdraw/;

function errorText(err: unknown): string {
  const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
  return `${e?.message ?? String(err)} ${(e?.logs ?? e?.transactionLogs ?? []).join(" ")}`;
}

function firstLine(err: unknown): string {
  return errorText(err).trim().split("\n")[0].slice(0, 300);
}

export class CoinKeeper {
  private warnedNoRevenueWallet = false;

  constructor(private readonly deps: CoinKeeperDeps) {}

  async tick(): Promise<void> {
    const { dbc, pool, platformTokenPool, thresholds } = this.deps;
    const started = Date.now();
    const view = await this.attempt("read pool", () => readDbcPool(dbc, pool));
    await this.attempt("settle journaled transactions", () => this.settlePending());
    if (view?.phase === "AWAITING_MIGRATION") {
      await this.attempt("migrate", () => this.migrate());
    } else if (view) {
      await this.attempt("claim curve fees", () => this.claimCurve(view));
      if (view.phase === "GRADUATED") {
        await this.attempt("claim pool fees", () => this.claimPool(view));
        await this.attempt("partner surplus", () => this.withdrawSurplus(view));
        await this.attempt("watch pool", () => this.watchPool(view));
      }
    }

    await this.stepRounds(started + thresholds.maxTickMs);

    if (view && view.phase !== "AWAITING_MIGRATION") {
      await this.attempt("platform revenue", () => this.payPlatformRevenue());
      await this.attempt("$FOLIO buyback", () => this.buyback("platformBuybackLamports", platformTokenPool, "$FOLIO buyback"));
      // Until other indexes launch, the flywheel's "top coins by market cap" is $FOLIO alone.
      await this.attempt("Stonkfolio flywheel", () => this.buyback("flywheelLamports", platformTokenPool, "Stonkfolio flywheel"));
    }
  }

  private async stepRounds(deadline: number): Promise<void> {
    const { engine, thresholds, log } = this.deps;
    for (let i = 0; i < thresholds.maxRoundStepsPerTick; i++) {
      if (this.deps.shouldStop?.() || Date.now() > deadline) break;
      let report: string;
      try {
        report = await engine.step();
      } catch (err) {
        log(`round step failed: ${firstLine(err)}`);
        break;
      }
      log(`round: ${report}`);
      if (/^(collecting|waiting)/.test(report)) break;
    }
  }

  private async attempt<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (err) {
      this.deps.log(`${label} failed: ${firstLine(err)}`);
      return undefined;
    }
  }

  private dammPoolOf(view: DbcPoolView): PublicKey {
    return deriveDammV2PoolAddress(DAMM_V2_CUSTOMIZABLE_CONFIG, view.baseMint, view.quoteMint);
  }

  /** The migrated partner position, pinned the first time it's found. */
  private async lockedPosition(damm: DammPoolView): Promise<OwnedPosition> {
    const { cpAmm, keeper, store } = this.deps;
    const pinned = store.load().lockedPosition;
    if (pinned) {
      const position = new PublicKey(pinned.position);
      return { position, positionNftAccount: new PublicKey(pinned.positionNftAccount), state: await cpAmm.fetchPositionState(position) };
    }
    const found = await findLockedPosition(cpAmm, damm.pool, keeper.publicKey);
    const state = store.load();
    state.lockedPosition = { position: found.position.toBase58(), positionNftAccount: found.positionNftAccount.toBase58() };
    store.save(state);
    return found;
  }

  // --- journal -----------------------------------------------------------------

  private journal(action: Omit<PendingAction, "signature" | "lastValidBlockHeight">): OnSigned {
    return (signature, lastValidBlockHeight) => {
      const state = this.deps.store.load();
      state.pending.push({ ...action, signature, lastValidBlockHeight });
      this.deps.store.save(state);
    };
  }

  /** An action with a transaction still in flight isn't started again until that one resolves. */
  private isPending(label: string): boolean {
    return this.deps.store.load().pending.some((p) => p.label === label);
  }

  private creditRevenue(state: KeeperState, lamports: bigint, description: string): void {
    const split = splitRevenue(lamports, this.deps.shares);
    state.ledger.basketLamports += split.basketLamports;
    state.ledger.flywheelLamports += split.flywheelLamports;
    state.ledger.platformBuybackLamports += split.platformBuybackLamports;
    state.ledger.platformRevenueLamports += split.platformRevenueLamports;
    this.deps.log(
      `${description} → basket ${split.basketLamports}, flywheel ${split.flywheelLamports}, platform buyback ${split.platformBuybackLamports}, platform revenue ${split.platformRevenueLamports}`
    );
  }

  /** Takes a cost from its bucket; anything beyond the bucket (a fee on a bucket spent to zero) comes from the basket pot. */
  private chargeLedger(state: KeeperState, bucket: keyof Ledger, cost: bigint): void {
    const taken = debit(state.ledger, bucket, cost);
    if (cost > taken) debit(state.ledger, "basketLamports", cost - taken);
  }

  /** Charges an unjournaled transaction's measured cost to the bucket that caused it. */
  private async chargeTransaction(signature: string, bucket: keyof Ledger): Promise<void> {
    const { connection, keeper, store } = this.deps;
    const change = await lamportChange(connection, signature, keeper.publicKey);
    const cost = change ? -change.delta : 5_000n;
    if (cost <= 0n) return;
    const state = store.load();
    this.chargeLedger(state, bucket, cost);
    store.save(state);
  }

  /** Applies every journaled transaction that landed and drops the ones that never will. */
  private async settlePending(): Promise<void> {
    const { connection, store, keeper, log } = this.deps;
    const state = store.load();
    if (state.pending.length === 0) return;
    let changed = false;
    for (const action of [...state.pending]) {
      const outcome = await resolveSignature(connection, action.signature, action.lastValidBlockHeight);
      if (outcome === "pending") continue;
      if (outcome === "landed") {
        // Booked as the transaction's net effect on the keeper's SOL — fees and account rent included — so
        // the wallet never drifts below the ledger. SOL a spend didn't use stays in its bucket.
        const change = await lamportChange(connection, action.signature, keeper.publicKey);
        if (!change) continue; // not indexed yet: settled on a later tick
        if (action.kind === "spend") {
          const cost = -change.delta > 0n ? -change.delta : 0n;
          this.chargeLedger(state, action.bucket!, cost);
          log(`${action.label}: spent ${cost} lamports including fees (${action.lamports} planned; ${action.signature})`);
        } else {
          const received = change.delta > 0n ? change.delta : 0n;
          this.creditRevenue(state, received, `claimed ${received} lamports of ${action.label} after fees`);
          if (action.label === "partner surplus") state.surplusWithdrawn = true;
        }
      } else {
        log(`${action.label}: transaction ${action.signature} ${outcome}; nothing applied`);
      }
      state.pending = state.pending.filter((p) => p.signature !== action.signature);
      changed = true;
    }
    if (changed) store.save(state);
  }

  // --- sub-steps ---------------------------------------------------------------

  private async migrate(): Promise<void> {
    const { connection, dbc, keeper, pool, log } = this.deps;
    const { signature, dammPool } = await migrateToDammV2(connection, dbc, keeper, pool);
    log(`migrated to DAMM v2 pool ${dammPool.toBase58()} (${signature})`);
  }

  private async claimCurve(view: DbcPoolView): Promise<void> {
    const { connection, dbc, keeper, pool, thresholds } = this.deps;
    const label = "curve fees";
    if (this.isPending(label)) return;
    // After graduation, sweep any last curve fees regardless of size.
    const graduated = view.phase === "GRADUATED";
    if (view.partnerQuoteFee < thresholds.minFeeClaimLamports && !(graduated && view.partnerQuoteFee > 0n)) return;
    await claimCurveFees(connection, dbc, keeper, pool, (signature, height, lamports) =>
      this.journal({ kind: "claim", label, lamports })(signature, height)
    );
    await this.settlePending();
  }

  private async claimPool(view: DbcPoolView): Promise<void> {
    const { connection, cpAmm, keeper, thresholds } = this.deps;
    const label = "pool fees";
    if (this.isPending(label)) return;
    const damm = await readDammPool(connection, cpAmm, this.dammPoolOf(view));
    const position = await this.lockedPosition(damm);
    if (unclaimedPositionFees(damm, position).quoteLamports < thresholds.minFeeClaimLamports) return;
    // DAMM v2 pays out everything pending when the claim lands; the credit is measured when it settles.
    await claimPositionFees(connection, cpAmm, keeper, damm, position, (signature, height, lamports) =>
      this.journal({ kind: "claim", label, lamports })(signature, height)
    );
    await this.settlePending();
  }

  /** After migration the partner may hold surplus SOL from the final curve fill; withdrawn once. */
  private async withdrawSurplus(view: DbcPoolView): Promise<void> {
    const { connection, dbc, keeper, pool, store, log } = this.deps;
    const label = "partner surplus";
    const state = store.load();
    if (state.surplusWithdrawn || state.pending.some((p) => p.label === label)) return;
    if (view.partnerSurplusWithdrawn) {
      state.surplusWithdrawn = true;
      store.save(state);
      return;
    }
    try {
      const tx = await dbc.partner.partnerWithdrawSurplus({ feeClaimer: keeper.publicKey, pool });
      await sendTransaction(connection, tx, keeper, [], undefined, this.journal({ kind: "claim", label, lamports: 0n }));
    } catch (err) {
      const text = errorText(err);
      const latest = store.load();
      if (SURPLUS_ALREADY_WITHDRAWN.test(text)) {
        latest.surplusWithdrawn = true;
        store.save(latest);
        log("partner surplus was already withdrawn");
        return;
      }
      // Only an outright program refusal counts; RPC trouble is retried next tick.
      if (!/custom program error|Error Code:/i.test(text)) throw err;
      latest.surplusRefusals = (latest.surplusRefusals ?? 0) + 1;
      if (latest.surplusRefusals >= SURPLUS_REFUSALS_BEFORE_DONE) {
        latest.surplusWithdrawn = true;
        log(`partner surplus refused ${latest.surplusRefusals} times (${firstLine(err)}); treating it as nothing to withdraw`);
      }
      store.save(latest);
      return;
    }
    await this.settlePending();
  }

  /**
   * Meteora's operators can change a DAMM v2 pool's fee or pause it without
   * any program upgrade. The keeper can't prevent that, so it records both and
   * raises an alert when either changes.
   */
  private async watchPool(view: DbcPoolView): Promise<void> {
    const { connection, cpAmm, store, log } = this.deps;
    const damm = await readDammPool(connection, cpAmm, this.dammPoolOf(view));
    const fees = await cpAmm.fetchPoolFees(damm.pool);
    const seen = { cliffFeeNumerator: fees?.cliffFeeNumerator?.toString() ?? "unknown", poolStatus: Number(damm.state.poolStatus) };
    const state = store.load();
    const before = state.poolWatch;
    if (before && (before.cliffFeeNumerator !== seen.cliffFeeNumerator || before.poolStatus !== seen.poolStatus)) {
      log(
        `ALERT: DAMM v2 pool ${damm.pool.toBase58()} changed outside our control: fee numerator ${before.cliffFeeNumerator} → ${seen.cliffFeeNumerator}, status ${before.poolStatus} → ${seen.poolStatus}`
      );
    }
    if (!before || before.cliffFeeNumerator !== seen.cliffFeeNumerator || before.poolStatus !== seen.poolStatus) {
      state.poolWatch = seen;
      store.save(state);
    }
  }

  private async payPlatformRevenue(): Promise<void> {
    const { connection, keeper, store, thresholds, platformRevenueAddress } = this.deps;
    const label = "platform revenue";
    const revenue = store.load().ledger.platformRevenueLamports;
    if (platformRevenueAddress.equals(PublicKey.default)) {
      if (!this.warnedNoRevenueWallet) {
        this.deps.log(`platform revenue: PLATFORM_REVENUE_ADDRESS is not set; the share keeps accumulating in the ledger (${revenue} lamports so far)`);
        this.warnedNoRevenueWallet = true;
      }
      return;
    }
    if (revenue < thresholds.minPlatformPayoutLamports || this.isPending(label)) return;
    // Sent net of the transfer's fee, so the fee comes out of this share rather than the basket.
    const payout = revenue - 5_000n;
    await transferSol(connection, keeper, platformRevenueAddress, payout, this.journal({ kind: "spend", bucket: "platformRevenueLamports", label, lamports: revenue }));
    await this.settlePending();
  }

  /** Buys a coin on its own pool with a bucket, then burns every unit the keeper holds. */
  private async buyback(bucket: keyof Ledger, target: PublicKey, label: string): Promise<void> {
    const { connection, dbc, cpAmm, keeper, store, thresholds } = this.deps;
    if (this.isPending(label)) return;
    let amount = store.load().ledger[bucket];
    if (amount < thresholds.minBuybackLamports) return;
    const view = await readDbcPool(dbc, target);
    if (view.phase === "AWAITING_MIGRATION") return;
    if (view.phase === "CURVE") {
      // A buy that fills the curve reverts, so stay well under the migration threshold.
      const room = ((view.migrationQuoteThreshold - view.quoteReserve) * 9n) / 10n;
      if (amount > room) amount = room;
      if (amount < thresholds.minBuybackLamports) return;
      await curveSwap(connection, dbc, keeper, target, amount, false, thresholds.slippageBps, this.journal({ kind: "spend", bucket, label, lamports: amount }));
    } else {
      const damm = await readDammPool(connection, cpAmm, this.dammPoolOf(view));
      await dammSwap(connection, cpAmm, keeper, damm, NATIVE_MINT, amount, thresholds.slippageBps, this.journal({ kind: "spend", bucket, label, lamports: amount }));
    }
    await this.settlePending();
    await this.burnHeld(view.baseMint, bucket);
  }

  /** The keeper never means to hold index coins: whatever a buyback or liquidity add left behind is burned, its fee charged to `bucket`. */
  private async burnHeld(mint: PublicKey, bucket: keyof Ledger): Promise<void> {
    const { connection, keeper, log } = this.deps;
    const account = getAssociatedTokenAddressSync(mint, keeper.publicKey);
    let balance: bigint;
    try {
      balance = (await getAccount(connection, account, "confirmed", TOKEN_PROGRAM_ID)).amount;
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) return;
      throw err;
    }
    if (balance === 0n) return;
    const { decimals } = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
    const signature = await sendTransaction(connection, [createBurnCheckedInstruction(account, mint, keeper.publicKey, balance, decimals, [], TOKEN_PROGRAM_ID)], keeper);
    await this.chargeTransaction(signature, bucket);
    log(`burned ${balance} of ${mint.toBase58()}`);
  }

}
