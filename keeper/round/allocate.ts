/**
 * Deterministic round allocation: selected snapshots in, per-asset payout
 * leaves out. Pure bigint arithmetic with every tie broken by public key
 * bytes, so anyone re-running it on the published inputs gets identical
 * output regardless of row order.
 *
 * 1. Aggregate each wallet's balance per sample; excluded and program-owned
 *    (off-curve) wallets never count.
 * 2. TWAB = floor(sum of sample balances / sample count); a missing sample is 0.
 * 3. Eligible if TWAB × median pool price × SOL/USD ≥ the USD minimum.
 * 4. Each asset is split pro-rata by TWAB with largest-remainder rounding, so
 *    the whole allocatable amount is assigned.
 * 5. Leaves below the asset's minimum are dropped and their share
 *    redistributed, for at most `maxMinLeafPasses` passes.
 */
import { PublicKey } from "@solana/web3.js";
import {
  AllocationInput,
  AllocationParams,
  AllocationResult,
  AssetAllocation,
  AssetInput,
  ExclusionEntry,
  HolderRow,
  Rational,
  Snapshot,
  SkippedAsset,
} from "./types";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Mirrors the distributor's MAX_ASSETS_PER_ROUND and MAX_LEAVES_PER_ASSET. */
export const MAX_ASSETS_PER_ROUND = 30;
export const MAX_LEAVES_PER_ASSET = 65_536;

export function compareRational(a: Rational, b: Rational): number {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Lower median, so an even count still picks an observed price rather than an average. */
export function medianRational(values: Rational[]): Rational {
  if (values.length === 0) throw new Error("median of no values");
  for (const v of values) {
    if (v.den <= 0n || v.num < 0n) throw new Error("price must be non-negative with a positive denominator");
  }
  const sorted = [...values].sort(compareRational);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

class PubkeyOrder {
  private readonly bytes = new Map<string, Buffer>();
  private readonly onCurve = new Map<string, boolean>();

  private buffer(key: string): Buffer {
    let buf = this.bytes.get(key);
    if (!buf) {
      buf = new PublicKey(key).toBuffer();
      this.bytes.set(key, buf);
    }
    return buf;
  }

  compare(a: string, b: string): number {
    return Buffer.compare(this.buffer(a), this.buffer(b));
  }

  isOnCurve(key: string): boolean {
    let result = this.onCurve.get(key);
    if (result === undefined) {
      result = PublicKey.isOnCurve(this.buffer(key));
      this.onCurve.set(key, result);
    }
    return result;
  }
}

function validateParams(params: AllocationParams): void {
  if (params.minEligibleUsdMicro < 0n) throw new Error("minEligibleUsdMicro must be non-negative");
  if (!Number.isInteger(params.maxLeavesPerAsset) || params.maxLeavesPerAsset < 1 || params.maxLeavesPerAsset > MAX_LEAVES_PER_ASSET) {
    throw new Error(`maxLeavesPerAsset must be between 1 and ${MAX_LEAVES_PER_ASSET}`);
  }
  if (!Number.isInteger(params.maxMinLeafPasses) || params.maxMinLeafPasses < 0) {
    throw new Error("maxMinLeafPasses must be a non-negative integer");
  }
}

function computeHolders(
  snapshots: Snapshot[],
  exclusions: ExclusionEntry[],
  solUsdMicro: bigint,
  params: AllocationParams,
  order: PubkeyOrder
): { holders: HolderRow[]; excluded: ExclusionEntry[]; medianPoolPrice: Rational } {
  if (snapshots.length === 0) throw new Error("allocation needs at least one snapshot");
  if (solUsdMicro <= 0n) throw new Error("solUsdMicro must be positive");
  const indices = new Set(snapshots.map((s) => s.index));
  if (indices.size !== snapshots.length) throw new Error("duplicate snapshot index");

  const ordered = [...snapshots].sort((a, b) => a.slot - b.slot || a.index - b.index);
  const sampleCount = ordered.length;
  const explicit = new Map(exclusions.map((e) => [e.owner, e.reason]));
  const excluded = new Map<string, string>();
  const balances = new Map<string, bigint[]>();

  ordered.forEach((snapshot, sample) => {
    const addresses = new Set<string>();
    for (const row of snapshot.accounts) {
      if (row.amount < 0n) throw new Error(`negative balance for ${row.address}`);
      if (addresses.has(row.address)) throw new Error(`token account ${row.address} listed twice in snapshot ${snapshot.index}`);
      addresses.add(row.address);

      const reason = explicit.get(row.owner);
      if (reason !== undefined) {
        excluded.set(row.owner, reason);
        continue;
      }
      if (!order.isOnCurve(row.owner)) {
        excluded.set(row.owner, "program-owned (off-curve) wallet");
        continue;
      }
      let perSample = balances.get(row.owner);
      if (!perSample) {
        perSample = new Array<bigint>(sampleCount).fill(0n);
        balances.set(row.owner, perSample);
      }
      perSample[sample] += row.amount;
    }
  });

  const medianPoolPrice = medianRational(ordered.map((s) => s.poolPrice));
  const threshold = params.minEligibleUsdMicro * medianPoolPrice.den * LAMPORTS_PER_SOL;
  const holders: HolderRow[] = [...balances.entries()].map(([owner, sampleBalances]) => {
    const twab = sampleBalances.reduce((sum, b) => sum + b, 0n) / BigInt(sampleCount);
    const scaled = twab * medianPoolPrice.num * solUsdMicro;
    return {
      owner,
      sampleBalances,
      twab,
      valueUsdMicro: scaled / (medianPoolPrice.den * LAMPORTS_PER_SOL),
      eligible: twab > 0n && scaled >= threshold,
    };
  });
  holders.sort((a, b) => order.compare(a.owner, b.owner));

  return {
    holders,
    excluded: [...excluded.entries()]
      .map(([owner, reason]) => ({ owner, reason }))
      .sort((a, b) => order.compare(a.owner, b.owner)),
    medianPoolPrice,
  };
}

interface Weighted {
  owner: string;
  weight: bigint;
}

/** Pool must be sorted by public key; ties in remainder go to the lower key. */
function largestRemainder(total: bigint, pool: Weighted[]): bigint[] {
  const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0n);
  if (totalWeight === 0n) return pool.map(() => 0n);
  const amounts = pool.map((p) => (total * p.weight) / totalWeight);
  const remainders = pool.map((p) => (total * p.weight) % totalWeight);
  let left = total - amounts.reduce((sum, a) => sum + a, 0n);
  const byRemainder = pool
    .map((_, i) => i)
    .sort((i, j) => (remainders[i] === remainders[j] ? i - j : remainders[i] > remainders[j] ? -1 : 1));
  for (const i of byRemainder) {
    if (left === 0n) break;
    amounts[i] += 1n;
    left -= 1n;
  }
  return amounts;
}

function allocateAsset(
  asset: AssetInput,
  eligible: Weighted[],
  params: AllocationParams,
  order: PubkeyOrder
): Omit<AssetAllocation, "assetIdx"> | { skipped: string } {
  if (asset.allocatable < 0n || asset.minLeafAmount < 0n) throw new Error(`negative amounts for asset ${asset.mint}`);
  if (asset.allocatable === 0n) return { skipped: "nothing to allocate" };

  let pool = eligible;
  let truncated = 0;
  if (pool.length > params.maxLeavesPerAsset) {
    // Keep the largest holders; ties go to the lower key.
    const ranked = [...pool].sort((a, b) =>
      a.weight === b.weight ? order.compare(a.owner, b.owner) : a.weight > b.weight ? -1 : 1
    );
    const kept = new Set(ranked.slice(0, params.maxLeavesPerAsset).map((p) => p.owner));
    truncated = pool.length - kept.size;
    pool = pool.filter((p) => kept.has(p.owner));
  }

  let amounts = largestRemainder(asset.allocatable, pool);
  let droppedBelowMin = 0;
  for (let pass = 0; pass < params.maxMinLeafPasses && pool.length > 0; pass++) {
    const keep = amounts.map((amount) => amount >= asset.minLeafAmount);
    if (keep.every(Boolean)) break;
    const next = pool.filter((_, i) => keep[i]);
    droppedBelowMin += pool.length - next.length;
    pool = next;
    amounts = largestRemainder(asset.allocatable, pool);
  }

  const leaves = pool
    .map((p, i) => ({ recipient: p.owner, amount: amounts[i] }))
    .filter((leaf) => leaf.amount > 0n)
    .map((leaf, leafIdx) => ({ leafIdx, ...leaf }));
  if (leaves.length === 0) return { skipped: "no eligible recipients at or above the minimum payout" };

  const allocated = leaves.reduce((sum, leaf) => sum + leaf.amount, 0n);
  return {
    mint: asset.mint,
    tokenProgram: asset.tokenProgram,
    allocatable: asset.allocatable,
    allocated,
    dust: asset.allocatable - allocated,
    droppedBelowMin,
    truncated,
    leaves,
  };
}

export function allocate(input: AllocationInput): AllocationResult {
  validateParams(input.params);
  if (input.assets.length > MAX_ASSETS_PER_ROUND) throw new Error(`at most ${MAX_ASSETS_PER_ROUND} assets per round`);
  const mints = new Set(input.assets.map((a) => a.mint));
  if (mints.size !== input.assets.length) throw new Error("duplicate asset mint");

  const order = new PubkeyOrder();
  const { holders, excluded, medianPoolPrice } = computeHolders(
    input.snapshots,
    input.exclusions,
    input.solUsdMicro,
    input.params,
    order
  );
  const eligible = holders.filter((h) => h.eligible).map((h) => ({ owner: h.owner, weight: h.twab }));

  const assets: AssetAllocation[] = [];
  const skipped: SkippedAsset[] = [];
  for (const asset of input.assets) {
    const result = allocateAsset(asset, eligible, input.params, order);
    if ("skipped" in result) skipped.push({ mint: asset.mint, reason: result.skipped });
    else assets.push({ assetIdx: assets.length, ...result });
  }
  return { medianPoolPrice, holders, excluded, assets, skipped };
}
