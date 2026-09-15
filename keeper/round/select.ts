/**
 * Which snapshots count toward a round. The seed mixes the hash of a block the
 * distributor program picked after the window closed (unknowable while holders
 * could still react) with the keeper's secret, committed on-chain when the
 * round opened (so the keeper can't grind secrets after seeing the block).
 */
import { createHash } from "crypto";
import { Sha256Rng, shuffled } from "../../lib/rng";
import { u64le } from "../../lib/merkle";

export const SAMPLE_SEED_DOMAIN = "stonkfolio-samples";

export function deriveSampleSeed(roundId: bigint, seedHash: Buffer, secret: Buffer): Buffer {
  if (seedHash.length !== 32) throw new Error("seed hash must be 32 bytes");
  if (secret.length < 16) throw new Error("sampling secret must be at least 16 bytes");
  return createHash("sha256").update(SAMPLE_SEED_DOMAIN).update(u64le(roundId)).update(seedHash).update(secret).digest();
}

export interface SnapshotRef {
  index: number;
  slot: number;
}

export interface SlotWindow {
  startSlot: number;
  endSlot: number;
}

/**
 * Picks up to `k` candidates inside the window [startSlot, endSlot], returned
 * as snapshot indices in slot order. Takes every candidate if there are k or
 * fewer.
 */
export function selectSampleIndices(candidates: SnapshotRef[], window: SlotWindow, k: number, seed: Buffer): number[] {
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer");
  if (window.startSlot > window.endSlot) throw new Error("window start is after its end");
  if (new Set(candidates.map((c) => c.index)).size !== candidates.length) throw new Error("duplicate snapshot index");

  const bySlot = (a: SnapshotRef, b: SnapshotRef) => a.slot - b.slot || a.index - b.index;
  const inWindow = candidates.filter((c) => c.slot >= window.startSlot && c.slot <= window.endSlot).sort(bySlot);
  const picked = inWindow.length <= k ? inWindow : shuffled(inWindow, new Sha256Rng(seed)).slice(0, k);
  return picked.sort(bySlot).map((c) => c.index);
}
