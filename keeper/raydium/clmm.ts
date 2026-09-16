/**
 * The few Raydium CLMM reads the keeper needs: StonkFun launches a coin into a
 * CLMM pool, so this is where the coin's price and the accounts a fee claim
 * touches come from. Only the fields we use are decoded, at offsets taken from
 * the program's own on-chain IDL (raydium_clmm, read 2026-09-15); everything
 * else is left alone so a layout addition at the end can't break us.
 */
import { Connection, PublicKey } from "@solana/web3.js";

export const CLMM_PROGRAM_ID = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
/** Ticks per tick-array account, fixed in the program. */
export const TICK_ARRAY_SIZE = 60;

export interface ClmmPool {
  address: PublicKey;
  ammConfig: PublicKey;
  tokenMint0: PublicKey;
  tokenMint1: PublicKey;
  tokenVault0: PublicKey;
  tokenVault1: PublicKey;
  mintDecimals0: number;
  mintDecimals1: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  status: number;
}

const key = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32));
const u128 = (data: Buffer, offset: number) => data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);

export function decodeClmmPool(address: PublicKey, data: Buffer): ClmmPool {
  if (data.length < 390) throw new Error(`${address.toBase58()} is too short for a CLMM pool (${data.length} bytes)`);
  return {
    address,
    ammConfig: key(data, 9),
    tokenMint0: key(data, 73),
    tokenMint1: key(data, 105),
    tokenVault0: key(data, 137),
    tokenVault1: key(data, 169),
    mintDecimals0: data[233],
    mintDecimals1: data[234],
    tickSpacing: data.readUInt16LE(235),
    liquidity: u128(data, 237),
    sqrtPriceX64: u128(data, 253),
    tickCurrent: data.readInt32LE(269),
    status: data[389],
  };
}

export interface ClmmPosition {
  address: PublicKey;
  nftMint: PublicKey;
  poolId: PublicKey;
  tickLowerIndex: number;
  tickUpperIndex: number;
  liquidity: bigint;
}

export function decodeClmmPosition(address: PublicKey, data: Buffer): ClmmPosition {
  if (data.length < 97) throw new Error(`${address.toBase58()} is too short for a CLMM position (${data.length} bytes)`);
  return {
    address,
    nftMint: key(data, 9),
    poolId: key(data, 41),
    tickLowerIndex: data.readInt32LE(73),
    tickUpperIndex: data.readInt32LE(77),
    liquidity: u128(data, 81),
  };
}

export async function readClmmPool(connection: Connection, address: PublicKey): Promise<ClmmPool> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`CLMM pool ${address.toBase58()} not found`);
  if (!info.owner.equals(CLMM_PROGRAM_ID)) throw new Error(`${address.toBase58()} is not owned by the CLMM program`);
  return decodeClmmPool(address, info.data);
}

const i32be = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};

// The protocol-position PDA seeds ticks little-endian while tick arrays use
// big-endian. Both are checked against a real transaction in tests/raydiumClaim.ts.
const i32le = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
};

export function personalPositionAddress(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), nftMint.toBuffer()], CLMM_PROGRAM_ID)[0];
}

export function protocolPositionAddress(pool: PublicKey, tickLower: number, tickUpper: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), pool.toBuffer(), i32le(tickLower), i32le(tickUpper)],
    CLMM_PROGRAM_ID
  )[0];
}

/** The tick array holding `tick`, floor-divided so negative ticks round down like the program does. */
export function tickArrayStartIndex(tick: number, tickSpacing: number): number {
  const ticksPerArray = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

export function tickArrayAddress(pool: PublicKey, startIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), i32be(startIndex)], CLMM_PROGRAM_ID)[0];
}

export function tickArrayBitmapExtensionAddress(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pool_tick_array_bitmap_extension"), pool.toBuffer()], CLMM_PROGRAM_ID)[0];
}

/**
 * The pool's price as an exact rational: how many raw units of the quote mint
 * one raw unit of the base mint is worth. sqrt_price_x64 is sqrt(token1 per
 * token0) in Q64.64, so the price is its square over 2^128 — kept as a
 * fraction rather than a float so the $50 eligibility check stays exact.
 */
export function poolPrice(pool: ClmmPool, baseMint: PublicKey): { num: bigint; den: bigint } {
  const squared = pool.sqrtPriceX64 * pool.sqrtPriceX64;
  const q128 = 1n << 128n;
  if (baseMint.equals(pool.tokenMint0)) return { num: squared, den: q128 };
  if (baseMint.equals(pool.tokenMint1)) return { num: q128, den: squared };
  throw new Error(`${baseMint.toBase58()} is not in pool ${pool.address.toBase58()}`);
}
