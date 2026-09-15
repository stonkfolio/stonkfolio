/**
 * Pyth pull-oracle `PriceUpdateV2` accounts: decoding, encoding (for test
 * fixtures), and conversion to micro-USD. The distributor program reads the
 * same account itself when a round's window closes; this mirror lets the
 * keeper and verifier interpret what it recorded.
 */
import { PublicKey } from "@solana/web3.js";

export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

/** The push oracle's shard-0 account for a feed — the only price account a distributor accepts (pyth.rs). */
export function sponsoredFeedAccount(feedIdHex: string): PublicKey {
  const shard = Buffer.alloc(2); // u16 LE shard 0
  return PublicKey.findProgramAddressSync([shard, Buffer.from(feedIdHex, "hex")], PYTH_PUSH_ORACLE_PROGRAM_ID)[0];
}

/** Sponsored SOL/USD price feed account (shard 0). */
export const PYTH_SOL_USD_PRICE_ACCOUNT = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PRICE_UPDATE_V2_DISCRIMINATOR = Buffer.from("22f123639d7ef4cd", "hex");

export interface PythPrice {
  feedIdHex: string;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: number;
  postedSlot: bigint;
  fullyVerified: boolean;
}

/**
 * Layout: discriminator(8), write_authority(32), verification_level (enum:
 * Partial{num_signatures: u8} = 2 bytes, Full = 1 byte), then the price
 * message: feed_id(32), price i64, conf u64, exponent i32, publish_time i64,
 * prev_publish_time i64, ema_price i64, ema_conf u64; then posted_slot u64.
 */
export function decodePriceUpdateV2(data: Buffer): PythPrice {
  if (data.length < 8 || !data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR)) throw new Error("not a Pyth PriceUpdateV2 account");
  let offset = 40;
  let fullyVerified: boolean;
  if (data[offset] === 0) {
    fullyVerified = false;
    offset += 2;
  } else if (data[offset] === 1) {
    fullyVerified = true;
    offset += 1;
  } else {
    throw new Error(`unknown Pyth verification level ${data[offset]}`);
  }
  if (data.length < offset + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8) throw new Error("Pyth price account is truncated");
  return {
    feedIdHex: data.subarray(offset, offset + 32).toString("hex"),
    price: data.readBigInt64LE(offset + 32),
    conf: data.readBigUInt64LE(offset + 40),
    exponent: data.readInt32LE(offset + 48),
    publishTime: Number(data.readBigInt64LE(offset + 52)),
    postedSlot: data.readBigUInt64LE(offset + 84),
    fullyVerified,
  };
}

/** Builds a fully verified PriceUpdateV2 account body (test fixtures). */
export function encodePriceUpdateV2(update: {
  feedIdHex: string;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: number;
  postedSlot: bigint;
}): Buffer {
  const message = Buffer.alloc(32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
  Buffer.from(update.feedIdHex, "hex").copy(message, 0);
  message.writeBigInt64LE(update.price, 32);
  message.writeBigUInt64LE(update.conf, 40);
  message.writeInt32LE(update.exponent, 48);
  message.writeBigInt64LE(BigInt(update.publishTime), 52);
  message.writeBigInt64LE(BigInt(update.publishTime - 1), 60);
  message.writeBigInt64LE(update.price, 68);
  message.writeBigUInt64LE(update.conf, 76);
  message.writeBigUInt64LE(update.postedSlot, 84);
  return Buffer.concat([PRICE_UPDATE_V2_DISCRIMINATOR, Buffer.alloc(32, 1), Buffer.from([1]), message]);
}

/** Converts price × 10^exponent USD into micro-USD, rounding down. */
export function toMicroUsd(price: bigint, exponent: number): bigint {
  if (price <= 0n) throw new Error("price must be positive");
  const shift = exponent + 6;
  return shift >= 0 ? price * 10n ** BigInt(shift) : price / 10n ** BigInt(-shift);
}
