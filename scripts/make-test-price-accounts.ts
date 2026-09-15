/**
 * Writes Pyth-shaped price accounts for the local distributor validator
 * (loaded with `solana-test-validator --account`), since the real Pyth
 * receiver isn't there:
 *
 *   node dist/scripts/make-test-price-accounts.js <out-dir>
 *
 * Each account sits at the push oracle's shard-0 address for its feed id, the
 * only address a distributor accepts. Publish times are "now" (except the
 * future-dated one), so a distributor with a short `max_price_age_secs` sees
 * the price go stale seconds into the run.
 */
import * as fs from "fs";
import * as path from "path";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { PYTH_RECEIVER_PROGRAM_ID, PYTH_SOL_USD_FEED_ID, encodePriceUpdateV2, sponsoredFeedAccount } from "../lib/pyth";

/** $100.00 SOL/USD with a ±$0.05 confidence (5 bps). */
export const TEST_SOL_USD = { price: 10_000_000_000n, conf: 5_000_000n, exponent: -8 };

const fakeFeedId = (n: number) => Buffer.alloc(32, n).toString("hex");

export const TEST_FEED_IDS = {
  sol: PYTH_SOL_USD_FEED_ID,
  partial: fakeFeedId(202),
  wrongOwner: fakeFeedId(203),
  mismatched: fakeFeedId(204),
  future: fakeFeedId(205),
};

export const TEST_PRICE_ACCOUNTS = {
  /** Fully verified SOL/USD owned by the Pyth receiver, at SOL/USD's real feed address. */
  fresh: sponsoredFeedAccount(TEST_FEED_IDS.sol),
  /** Only partially verified. */
  partial: sponsoredFeedAccount(TEST_FEED_IDS.partial),
  /** Valid layout owned by the system program instead of the receiver. */
  wrongOwner: sponsoredFeedAccount(TEST_FEED_IDS.wrongOwner),
  /** At one feed's address but carrying SOL/USD's feed id. */
  mismatched: sponsoredFeedAccount(TEST_FEED_IDS.mismatched),
  /** Stamped 40 days ahead, beyond the tests' 30-day age limit. */
  future: sponsoredFeedAccount(TEST_FEED_IDS.future),
};

function accountJson(pubkey: PublicKey, owner: PublicKey, data: Buffer) {
  return {
    pubkey: pubkey.toBase58(),
    account: {
      lamports: 1_000_000_000,
      data: [data.toString("base64"), "base64"],
      owner: owner.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
}

function main(): void {
  const outDir = process.argv[2];
  if (!outDir) throw new Error("usage: make-test-price-accounts <out-dir>");
  fs.mkdirSync(outDir, { recursive: true });

  const now = Math.floor(Date.now() / 1000);
  const update = (feedIdHex: string, publishTime = now) => encodePriceUpdateV2({ feedIdHex, ...TEST_SOL_USD, publishTime, postedSlot: 1n });
  // Partial { num_signatures } is two bytes where Full is one.
  const partially = (full: Buffer) => Buffer.concat([full.subarray(0, 40), Buffer.from([0, 3]), full.subarray(41)]);

  const accounts = [
    accountJson(TEST_PRICE_ACCOUNTS.fresh, PYTH_RECEIVER_PROGRAM_ID, update(TEST_FEED_IDS.sol)),
    accountJson(TEST_PRICE_ACCOUNTS.partial, PYTH_RECEIVER_PROGRAM_ID, partially(update(TEST_FEED_IDS.partial))),
    accountJson(TEST_PRICE_ACCOUNTS.wrongOwner, SystemProgram.programId, update(TEST_FEED_IDS.wrongOwner)),
    accountJson(TEST_PRICE_ACCOUNTS.mismatched, PYTH_RECEIVER_PROGRAM_ID, update(TEST_FEED_IDS.sol)),
    accountJson(TEST_PRICE_ACCOUNTS.future, PYTH_RECEIVER_PROGRAM_ID, update(TEST_FEED_IDS.future, now + 40 * 24 * 60 * 60)),
  ];
  for (const account of accounts) {
    fs.writeFileSync(path.join(outDir, `${account.pubkey}.json`), JSON.stringify(account));
    console.log(account.pubkey);
  }
}

if (require.main === module) main();
