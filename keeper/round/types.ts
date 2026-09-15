/** Shared shapes for the round pipeline. All token and lamport amounts are bigint. */

/** A non-negative rational number; `den` is always positive. */
export interface Rational {
  num: bigint;
  den: bigint;
}

export interface TokenAccountRow {
  /** Token account address. */
  address: string;
  /** Wallet that owns the token account. */
  owner: string;
  /** Raw index-coin amount. */
  amount: bigint;
}

export interface Snapshot {
  /** Position in the round's snapshot sequence; unique per round. */
  index: number;
  slot: number;
  /** Unix seconds. */
  timestamp: number;
  /** Index-coin price at this slot, in lamports per raw token unit. */
  poolPrice: Rational;
  accounts: TokenAccountRow[];
}

export interface ExclusionEntry {
  owner: string;
  reason: string;
}

export interface AssetInput {
  mint: string;
  tokenProgram: string;
  /** Raw amount available to allocate (what the vault will hold after funding). */
  allocatable: bigint;
  /** Leaves below this raw amount are dropped and their share redistributed. */
  minLeafAmount: bigint;
}

export interface AllocationParams {
  /** Minimum time-weighted holding value, in micro-USD (50_000_000 = $50). */
  minEligibleUsdMicro: bigint;
  maxLeavesPerAsset: number;
  /** How many drop-below-minimum-and-reallocate passes to run per asset. */
  maxMinLeafPasses: number;
}

export interface AllocationInput {
  /** The selected samples only. */
  snapshots: Snapshot[];
  exclusions: ExclusionEntry[];
  assets: AssetInput[];
  /** SOL price in micro-USD per 1 SOL. */
  solUsdMicro: bigint;
  params: AllocationParams;
}

export interface HolderRow {
  owner: string;
  /** Balance at each selected sample, in slot order. */
  sampleBalances: bigint[];
  /** floor(sum of sample balances / sample count). */
  twab: bigint;
  valueUsdMicro: bigint;
  eligible: boolean;
}

export interface PayoutLeafRow {
  leafIdx: number;
  recipient: string;
  amount: bigint;
}

export interface AssetAllocation {
  assetIdx: number;
  mint: string;
  tokenProgram: string;
  allocatable: bigint;
  allocated: bigint;
  /** allocatable - allocated; stays in the keeper and rolls into the next round. */
  dust: bigint;
  droppedBelowMin: number;
  truncated: number;
  leaves: PayoutLeafRow[];
}

export interface SkippedAsset {
  mint: string;
  reason: string;
}

export interface AllocationResult {
  medianPoolPrice: Rational;
  holders: HolderRow[];
  excluded: ExclusionEntry[];
  assets: AssetAllocation[];
  skipped: SkippedAsset[];
}
