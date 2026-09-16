/**
 * The keeper's persistent state for one launched coin: fee buckets, basket
 * inventory, and its payout rounds. Every round step saves before the next
 * begins, so a restarted keeper resumes exactly where it stopped. The file
 * holds sampling secrets and swap-wallet keys, so it is written owner-only.
 */
import * as fs from "fs";
import * as path from "path";

export interface Ledger {
  basketLamports: bigint;
  flywheelLamports: bigint;
  platformBuybackLamports: bigint;
  platformRevenueLamports: bigint;
  /** Set aside from the basket pot for rounds' rent and fees; settled when each round finishes. */
  operationsLamports: bigint;
}

export type RoundStatus = "OPEN" | "CLOSED" | "SEEDED" | "FUNDED" | "PREPARED" | "COMMITTED" | "ACTIVE";

export interface CandidateRecord {
  index: number;
  slot: number;
  sha256: string;
}

export interface PurchaseRecord {
  mint: string;
  tokenProgram: string;
  status: "pending" | "bought" | "skipped";
  /** SOL the swap spent (its exact input). */
  lamportsSpent: bigint;
  /** Tokens the swap delivered to its wallet. */
  received: bigint;
  signatures: string[];
  /** The throwaway wallet that made the purchase. */
  buyer?: string;
  attempts: number;
  lastError?: string;
  reason?: string;
  /** Secret key (hex) of the current attempt's swap wallet, saved before any SOL reaches it. */
  swapWalletSecretHex?: string;
  funding?: { signature: string; lastValidBlockHeight: number; lamports: bigint };
  /** The current sweep, saved before it's sent: a restart books it from here instead of re-sweeping an emptied wallet. */
  sweep?: { signature: string; lastValidBlockHeight: number; tokens: bigint; lamportsReturned: bigint };
  /** The keeper's own sweeps of the current wallet, so they aren't mistaken for its swap. */
  sweepSignatures?: string[];
  /** Times a landed swap's output was looked for and not yet visible. */
  outputChecks?: number;
}

export interface FundedAsset {
  mint: string;
  tokenProgram: string;
  /** Tokens reserved from this coin's inventory for the round. */
  fundAmount: bigint;
  /** What the vault holds if all of `fundAmount` is sent (net of any transfer fee). */
  allocatable: bigint;
  minLeafAmount: bigint;
  /** "released": the reservation went back to inventory (not allocated, abandoned, or the round ended first). */
  status: "pending" | "active" | "abandoned" | "released";
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number;
}

export interface PayoutFailure {
  assetIdx: number;
  leafIdx: number;
  recipient: string;
  attempts: number;
  /** Permanent failures are left for the recipient to self-claim. */
  permanent: boolean;
  reason: string;
  nextAttemptAt?: number;
}

/**
 * The on-chain RoundIntent is the source of truth for the window, snapshot
 * chain head, price and seed; this only tracks what the keeper alone knows.
 */
export interface ActiveRound {
  roundId: bigint;
  status: RoundStatus;
  secretHex: string;
  commitmentHex: string;
  /** The intent's open slot: snapshots indexed before it can't count. */
  windowStartSlot: number;
  windowStartTs: number;
  windowEndSlot?: number;
  nextSnapshotAt: number;
  candidates: CandidateRecord[];
  chainHeadHex: string;
  /** Owners whose latest balance already cleared the threshold; sizes the cost estimate. */
  latestEligibleCount: number;
  seededAt?: number;
  basketBudgetLamports?: bigint;
  operationsReserveLamports?: bigint;
  /** Fees and rent this round's own transactions actually cost, less refunds. */
  operationsSpentLamports: bigint;
  purchases?: PurchaseRecord[];
  assets?: FundedAsset[];
  manifestHashHex?: string;
  assetsRootHex?: string;
  commitSignature?: string;
  expiryTs?: number;
  failures: PayoutFailure[];
}

export interface ExpiringAsset {
  assetIdx: number;
  mint: string;
  tokenProgram: string;
  attempts?: number;
  nextAttemptAt?: number;
}

export interface ExpiringRound {
  roundId: bigint;
  expiryTs: number;
  /** Assets still to close. */
  assets: ExpiringAsset[];
}

/** A journaled SOL movement: applied to the ledger only once its transaction is known to have landed. */
export interface PendingAction {
  /**
   * Both kinds are booked from the landed transaction's measured effect on
   * the keeper's SOL, fees and account rent included. "claim": revenue to
   * split. "spend": a debit from `bucket` (any excess over it comes from the
   * basket pot). `lamports` is what was planned, for the log.
   */
  kind: "claim" | "spend";
  label: string;
  bucket?: keyof Ledger;
  lamports: bigint;
  signature: string;
  lastValidBlockHeight: number;
}

export interface InventoryEntry {
  tokenProgram: string;
  amount: bigint;
}

export const KEEPER_STATE_VERSION = 3;

export interface KeeperState {
  version: typeof KEEPER_STATE_VERSION;
  ledger: Ledger;
  /** Basket tokens the keeper wallet holds for this coin, by mint. Coins share the wallet, never these amounts. */
  inventory: Record<string, InventoryEntry>;
  /** The round whose window is open or being prepared. */
  round?: ActiveRound;
  /** Committed rounds still activating assets or pushing payouts. */
  paying: ActiveRound[];
  expiring: ExpiringRound[];
  pending: PendingAction[];
  /** Set once the post-migration partner surplus has been withdrawn (or found empty). */
  surplusWithdrawn?: boolean;
  surplusRefusals?: number;
  /** The locked partner position from migration, pinned when first seen so a position sent to the keeper later can't replace it. */
  lockedPosition?: { position: string; positionNftAccount: string };
  /** The graduated pool's fee and status as last seen; Meteora operators can change both without an upgrade. */
  poolWatch?: { cliffFeeNumerator: string; poolStatus: number };
}

export function emptyLedger(): Ledger {
  return {
    basketLamports: 0n,
    flywheelLamports: 0n,
    platformBuybackLamports: 0n,
    platformRevenueLamports: 0n,
    operationsLamports: 0n,
  };
}

export function creditInventory(state: KeeperState, mint: string, tokenProgram: string, amount: bigint): void {
  if (amount <= 0n) return;
  state.inventory[mint] = { tokenProgram, amount: (state.inventory[mint]?.amount ?? 0n) + amount };
}

const BIGINT_TAG = "$bigint";

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === BIGINT_TAG && typeof record[BIGINT_TAG] === "string") return BigInt(record[BIGINT_TAG]);
  }
  return value;
}

export class KeeperStore {
  readonly statePath: string;

  constructor(readonly dir: string) {
    this.statePath = path.join(dir, "state.json");
  }

  load(): KeeperState {
    if (!fs.existsSync(this.statePath)) {
      return { version: KEEPER_STATE_VERSION, ledger: emptyLedger(), inventory: {}, paying: [], expiring: [], pending: [] };
    }
    const state = JSON.parse(fs.readFileSync(this.statePath, "utf-8"), reviver) as KeeperState;
    if (state.version !== KEEPER_STATE_VERSION) throw new Error(`unsupported keeper state version ${state.version}`);
    return state;
  }

  /** Write-then-rename, owner-only, so a crash mid-write never leaves a torn or readable-by-others state file. */
  save(state: KeeperState): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, replacer, 2), { mode: 0o600 });
    fs.renameSync(temp, this.statePath);
  }

  roundDir(roundId: bigint): string {
    return path.join(this.dir, "rounds", roundId.toString());
  }

  snapshotDir(roundId: bigint): string {
    return path.join(this.roundDir(roundId), "snapshots");
  }

  snapshotPath(roundId: bigint, index: number): string {
    return path.join(this.snapshotDir(roundId), `${index}.json`);
  }

  bundleDir(roundId: bigint): string {
    return path.join(this.roundDir(roundId), "bundle");
  }
}
