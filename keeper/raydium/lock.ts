/**
 * Claiming a StonkFun launch's creator fees.
 *
 * A "standard" StonkFun launch puts the pool's liquidity in a position owned by
 * Raydium's liquidity-locking program and hands the launcher a fee NFT. Whoever
 * holds that NFT can collect the position's fees, and nobody else can — no
 * platform signature is involved. StonkFun's API builds this same instruction;
 * we build it ourselves so a claim never depends on their API being up.
 *
 * Account order and the instruction's discriminator come from the lock
 * program's own on-chain IDL (raydium_liquidity_locking 0.1.0, vendored in
 * lock-idl.json); tests/raydiumClaim.ts checks the result against a real
 * transaction StonkFun prepared.
 */
import { AccountMeta, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ClmmPool,
  ClmmPosition,
  CLMM_PROGRAM_ID,
  decodeClmmPosition,
  personalPositionAddress,
  protocolPositionAddress,
  readClmmPool,
  tickArrayAddress,
  tickArrayBitmapExtensionAddress,
  tickArrayStartIndex,
} from "./clmm";

export const LOCK_PROGRAM_ID = new PublicKey("LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE");
/**
 * The lock program's single authority PDA. It is program-global (no per-pool
 * seeds) and holds no data, so it is pinned here and checked in the tests
 * against what the program itself is handed in a real claim.
 */
export const LOCK_AUTHORITY = new PublicKey("kN1kEznaF5Xbd8LYuqtEFcxzWSBk5Fv6ygX6SqEGJVy");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Anchor discriminator for collect_clmm_fees_and_rewards. */
export const COLLECT_CLMM_FEES_AND_REWARDS = Buffer.from("1048fac60ea2d413", "hex");

/** LockedClmmPositionState: 8 disc, 1 bump, then five pubkeys. */
export interface LockedClmmPosition {
  address: PublicKey;
  positionOwner: PublicKey;
  poolId: PublicKey;
  /** The CLMM personal-position account whose fees this claims. */
  positionId: PublicKey;
  lockedNftAccount: PublicKey;
  feeNftMint: PublicKey;
}

const key = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32));

export function decodeLockedPosition(address: PublicKey, data: Buffer): LockedClmmPosition {
  if (data.length < 169) throw new Error(`${address.toBase58()} is too short for a locked CLMM position (${data.length} bytes)`);
  return {
    address,
    positionOwner: key(data, 9),
    poolId: key(data, 41),
    positionId: key(data, 73),
    lockedNftAccount: key(data, 105),
    feeNftMint: key(data, 137),
  };
}

/**
 * Every locked position on `pool`. Looked up by the pool it belongs to rather
 * than derived, so a change in how the lock program seeds its PDAs can't make
 * the keeper miss its own position.
 */
export async function findLockedPositions(connection: Connection, pool: PublicKey): Promise<LockedClmmPosition[]> {
  const accounts = await connection.getProgramAccounts(LOCK_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 41, bytes: pool.toBase58() } }],
  });
  return accounts
    .filter(({ account }) => account.data.length >= 169)
    .map(({ pubkey, account }) => decodeLockedPosition(pubkey, account.data));
}

export interface CollectFeesAccounts {
  locked: LockedClmmPosition;
  pool: ClmmPool;
  position: ClmmPosition;
  /** The token account holding the fee NFT; its owner signs. */
  feeNftAccount: PublicKey;
  feeNftOwner: PublicKey;
  /** Where the pool's token_0 and token_1 fees are paid. */
  recipientToken0: PublicKey;
  recipientToken1: PublicKey;
  /** Passed as a trailing account when the pool has one. */
  tickArrayBitmapExtension?: PublicKey;
}

/** Pure account list, in the IDL's order, so it can be checked without a chain. */
export function collectFeesAccountMetas(input: CollectFeesAccounts): AccountMeta[] {
  const { locked, pool, position } = input;
  if (!position.poolId.equals(pool.address)) throw new Error("position is not in this pool");
  if (!locked.poolId.equals(pool.address)) throw new Error("locked position is not in this pool");
  if (!locked.positionId.equals(position.address)) throw new Error("locked position points at a different position");
  const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const writable = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  const metas: AccountMeta[] = [
    readonly(LOCK_AUTHORITY),
    { pubkey: input.feeNftOwner, isSigner: true, isWritable: true },
    // Writable: the program touches the NFT account, as its own API-built claims do.
    writable(input.feeNftAccount),
    readonly(locked.address),
    readonly(CLMM_PROGRAM_ID),
    writable(locked.lockedNftAccount),
    writable(position.address),
    writable(pool.address),
    writable(protocolPositionAddress(pool.address, position.tickLowerIndex, position.tickUpperIndex)),
    writable(pool.tokenVault0),
    writable(pool.tokenVault1),
    writable(tickArrayAddress(pool.address, tickArrayStartIndex(position.tickLowerIndex, pool.tickSpacing))),
    writable(tickArrayAddress(pool.address, tickArrayStartIndex(position.tickUpperIndex, pool.tickSpacing))),
    writable(input.recipientToken0),
    writable(input.recipientToken1),
    readonly(TOKEN_PROGRAM_ID),
    readonly(TOKEN_2022_PROGRAM_ID),
    readonly(MEMO_PROGRAM_ID),
    readonly(pool.tokenMint0),
    readonly(pool.tokenMint1),
  ];
  if (input.tickArrayBitmapExtension) metas.push(writable(input.tickArrayBitmapExtension));
  return metas;
}

export function collectFeesInstruction(input: CollectFeesAccounts): TransactionInstruction {
  return new TransactionInstruction({
    programId: LOCK_PROGRAM_ID,
    keys: collectFeesAccountMetas(input),
    data: COLLECT_CLMM_FEES_AND_REWARDS,
  });
}

/** Reads what the instruction needs and builds it. */
export async function buildCollectFees(
  connection: Connection,
  input: { locked: LockedClmmPosition; feeNftAccount: PublicKey; feeNftOwner: PublicKey; recipientToken0: PublicKey; recipientToken1: PublicKey }
): Promise<TransactionInstruction> {
  const pool = await readClmmPool(connection, input.locked.poolId);
  const positionInfo = await connection.getAccountInfo(input.locked.positionId, "confirmed");
  if (!positionInfo) throw new Error(`CLMM position ${input.locked.positionId.toBase58()} not found`);
  const position = decodeClmmPosition(input.locked.positionId, positionInfo.data);
  const bitmap = tickArrayBitmapExtensionAddress(pool.address);
  const bitmapInfo = await connection.getAccountInfo(bitmap, "confirmed");
  return collectFeesInstruction({
    locked: input.locked,
    pool,
    position,
    feeNftAccount: input.feeNftAccount,
    feeNftOwner: input.feeNftOwner,
    recipientToken0: input.recipientToken0,
    recipientToken1: input.recipientToken1,
    tickArrayBitmapExtension: bitmapInfo ? bitmap : undefined,
  });
}
