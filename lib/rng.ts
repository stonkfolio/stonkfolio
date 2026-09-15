/**
 * Deterministic randomness from a public seed: sha256(seed ‖ counter u64LE)
 * blocks, read 8 bytes at a time. Anyone holding the seed reproduces exactly
 * the same draws, which is what lets round sample selection be re-checked.
 */
import { createHash } from "crypto";

const TWO_POW_64 = 1n << 64n;

export class Sha256Rng {
  private counter = 0n;
  private pool: Buffer = Buffer.alloc(0);

  constructor(private readonly seed: Buffer) {
    if (seed.length === 0) throw new Error("Sha256Rng needs a non-empty seed");
  }

  private refill(): void {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64LE(this.counter);
    this.counter += 1n;
    const block = createHash("sha256").update(this.seed).update(counter).digest();
    this.pool = Buffer.concat([this.pool, block]);
  }

  nextU64(): bigint {
    while (this.pool.length < 8) this.refill();
    const value = this.pool.readBigUInt64LE(0);
    this.pool = this.pool.subarray(8);
    return value;
  }

  /** Uniform integer in [0, n), by rejection sampling so there is no modulo bias. */
  below(n: bigint): bigint {
    if (n <= 0n || n > TWO_POW_64) throw new Error(`below: n out of range (${n})`);
    const limit = (TWO_POW_64 / n) * n;
    for (;;) {
      const value = this.nextU64();
      if (value < limit) return value % n;
    }
  }
}

/** Fisher–Yates shuffle into a new array; the input is not modified. */
export function shuffled<T>(items: readonly T[], rng: Sha256Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Number(rng.below(BigInt(i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
