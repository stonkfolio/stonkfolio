import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { PYTH_SOL_USD_FEED_ID, PYTH_SOL_USD_PRICE_ACCOUNT } from "../lib/pyth";
import type { RoundParams } from "./round/engine";
import type { RoundPolicy } from "./round/policy";

export const RPC_URL = process.env.STONKFOLIO_RPC_URL ?? "https://api.devnet.solana.com";
// Deliberately NOT the admin wallet (~/.config/solana/id.json) by default.
// The keeper runs unattended on a schedule and is the thing most exposed to
// compromise, so it only ever holds the narrow powers its role needs (see the
// custody table in the rebuild plan). .keys/ is gitignored.
export const KEEPER_KEYPAIR_PATH =
  process.env.STONKFOLIO_KEEPER_KEYPAIR ?? path.join(process.cwd(), ".keys/keeper-devnet.json");

// The STONKFOLIO mint is created by the Meteora DBC pool at launch
// (scripts/launch/create-pool.ts) — there is no compiled-in default, so a
// missing value fails loudly instead of silently targeting a stale mint.
export function requireStonkfolioMint(): PublicKey {
  const value = process.env.STONKFOLIO_MINT;
  if (!value) throw new Error("STONKFOLIO_MINT is not set");
  return new PublicKey(value);
}

// Wrapped SOL's mint — imported from spl-token's own constant rather than
// hand-typed.
export const SOL_MINT = NATIVE_MINT;

// --- StonkFun -----------------------------------------------------------
export const STONKFUN_API_BASE = "https://www.stonkfun.xyz/api/public/v1";
export const BASKET_SIZE = 30;

// --- risk / execution knobs ------------------------------------------------
// These exist because "top by market cap" on a bonding-curve platform is
// gameable (thin liquidity can produce an inflated paper market cap). Every
// one of these is a real dollar figure standing between the keeper and buying
// into a manipulated token; tune conservatively and re-check before raising
// them, not after something looks wrong.
export const MAX_PRICE_IMPACT_BPS = 150; // refuse a buy priced above 1.5% impact
export const SLIPPAGE_BPS = 100;
// Verified against a live /tokens response (2026-09-13): `market.liquidityUsd`
// is absent on most graduated tokens in practice, so this floor only applies
// when the field is actually present. It is NOT the primary safety gate; the
// price-impact check on each basket buy is.
export const MIN_QUOTE_LIQUIDITY_USD = 25_000;
export const MAX_NEW_BASKET_ENTRIES_PER_TICK = 3; // rate-limit how fast the basket changes per run

// --- Jupiter and HTTP ------------------------------------------------------
// Every outside HTTP call gives up after this long, so a stalled API can't stall the keeper.
export const FETCH_TIMEOUT_MS = 20_000;
// Most a basket swap may pay in priority fees; it comes out of the swap wallet's overhead.
export const MAX_SWAP_PRIORITY_FEE_LAMPORTS = 2_000_000n; // 0.002 SOL
// Free, unauthenticated tier as of the Dec-2024 API restructuring. Switch to
// https://api.jup.ag/swap/v1 with an `x-api-key` header for the paid tier if
// this keeper needs higher rate limits than lite-api provides.
export const JUPITER_API_BASE = "https://lite-api.jup.ag/swap/v1";

// --- fee split (bps of a coin's fee revenue actually received, i.e. after
// Meteora's protocol share) — must sum to 10_000, enforced at runtime by
// feeSplit.ts's splitByBps. Platform takes 20% (half buys back $FOLIO,
// half is revenue); the rest is holders-first. At a 5% tier, ~$4.00 received
// per $100 of volume: basket $2.80, coin buyback $0.20, liquidity $0.20,
// $FOLIO buyback $0.40, platform revenue $0.40. For Stonkfolio itself
// both buyback buckets buy $FOLIO.
export const BASKET_SHARE_BPS = 7_000;
export const COIN_BUYBACK_SHARE_BPS = 500;
export const LIQUIDITY_SHARE_BPS = 500;
export const PLATFORM_BUYBACK_SHARE_BPS = 1_000;
export const PLATFORM_REVENUE_SHARE_BPS = 1_000;
// The platform coin's symbol (project owner, 2026-09-14). The keeper finds the
// platform buyback's pool in the deployment file by this symbol.
export const PLATFORM_TOKEN_SYMBOL = "FOLIO";

// Platform revenue wallet, chosen by the project owner (2026-09-13). The env
// variable can override it; if it's ever set to PublicKey.default the keeper
// logs a warning once and lets the share accumulate in the ledger.
export const PLATFORM_REVENUE_WALLET = "EkARrDbTFynVpxQAxY11URkdxznccbzhEaexuX4GVw63";
export const PLATFORM_REVENUE_ADDRESS = new PublicKey(process.env.PLATFORM_REVENUE_ADDRESS || PLATFORM_REVENUE_WALLET);

// --- liquidity share -------------------------------------------------------
// Added to a graduated coin's locked pool only while its SOL depth is below
// the target (2× the 85 SOL migration threshold); above it, holders get it.
export const LIQUIDITY_TARGET_LAMPORTS = 170_000_000_000n;
export const MIN_LIQUIDITY_ADD_LAMPORTS = 50_000_000n; // 0.05 SOL

// --- payout rounds (defaults; see the rebuild plan's open parameters) ------
export const MIN_ELIGIBLE_USD_MICRO = 50_000_000n; // $50 time-weighted holding
export const SAMPLES_PER_ROUND = 24;
export const MIN_ROUND_WINDOW_SECS = 6 * 60 * 60;
export const ROUND_COST_MAX_BPS = 500; // round costs at most 5% of the pot
export const ROUND_EXPIRY_SECS = 90 * 24 * 60 * 60;
export const MAX_LEAVES_PER_ASSET = 65_536;
export const MAX_MIN_LEAF_PASSES = 3;
// A payout worth less than this (priced at the basket buy) is dropped and
// redistributed, so recipients aren't sent dust.
export const MIN_LEAF_VALUE_LAMPORTS = 1_000_000n; // 0.001 SOL
// StonkFun's reward coins charge 1-3% on every transfer; the program accepts up to 300 bps (state.rs).
// The fee isn't counted as a round cost: it scales with the pot, so waiting for a bigger pot never shrinks it.
export const MAX_BASKET_TRANSFER_FEE_BPS = 300;
export const MEAN_SNAPSHOT_INTERVAL_SECS = 15 * 60; // ~24 candidates over the 6h minimum window
export const MIN_EXPIRY_SECS = 30 * 24 * 60 * 60; // fixed per distributor at creation
export const PRIORITY_FEE_LAMPORTS_PER_TX = 10_000n;
export const SWAP_IMPACT_ESTIMATE_BPS = 100;
export const MAX_PUSHES_PER_STEP = 25;
export const MAX_PUSH_ATTEMPTS = 5;
// A window the trigger never fires on is abandoned and restarted after this, bounding snapshot storage.
export const MAX_ROUND_WINDOW_SECS = 7 * 24 * 60 * 60;
export const MAX_BUY_ATTEMPTS = 3;
export const MAX_BUY_PHASE_SECS = 60 * 60;
export const MAX_ACTIVATION_ATTEMPTS = 5;

// --- keeper loop -------------------------------------------------------------
export const TICK_INTERVAL_MS = 15_000;
// How often the keeper checks Meteora's programs and migration config against the pin.
export const METEORA_MONITOR_INTERVAL_MS = 60 * 60 * 1000;
export const METEORA_PIN_PATH = process.env.STONKFOLIO_METEORA_PIN ?? path.join(process.cwd(), "deployments/meteora-programs.json");
export const MAX_ROUND_STEPS_PER_TICK = 50;
export const MAX_TICK_MS = 120_000;
export const MIN_FEE_CLAIM_LAMPORTS = 10_000_000n; // 0.01 SOL
export const MIN_BUYBACK_LAMPORTS = 10_000_000n;
export const MIN_PLATFORM_PAYOUT_LAMPORTS = 10_000_000n;
export const POOL_SWAP_SLIPPAGE_BPS = 100;
// Sent to each throwaway swap wallet on top of the buy, for fees and temporary
// account rent (≤ 0.002 SOL priority fee plus ~0.004 SOL of refundable rent).
// Whatever isn't used is swept back.
export const SWAP_OVERHEAD_LAMPORTS = 10_000_000n;

// Seeds from a block ~32 slots (≈ finality depth) after the window closes.
export const SEED_SLOT_OFFSET = 32;
// A window can't close on a price older than 5 minutes or with a confidence
// wider than 2%. Measured on mainnet (2026-09-14, 10 minutes): the sponsored
// SOL/USD account updated every 52–53 s, was never older than 55 s, and its
// confidence never exceeded 2 bps — so these limits leave room for a few
// missed updates without letting a stale or wide price through.
export const MAX_PRICE_AGE_SECS = 300;
export const MAX_PRICE_CONF_BPS = 200;
// A payout that would need a new token account is only pushed if worth at least 3× its rent.
export const AUTO_PUSH_MIN_RENT_MULTIPLE = 3;

export const STATIC_EXCLUSIONS = [{ owner: "1nc1nerator11111111111111111111111111111111", reason: "burn address" }];

/**
 * Every rule that decides who gets paid. Its hash is fixed on-chain when a
 * coin's distributor is created, so changing any value here means a new
 * distributor — the keeper refuses to run rounds under a different policy.
 */
export function roundPolicy(): RoundPolicy {
  return {
    version: 1,
    samplesPerRound: SAMPLES_PER_ROUND,
    minWindowSecs: MIN_ROUND_WINDOW_SECS,
    seedSlotOffset: SEED_SLOT_OFFSET,
    minEligibleUsdMicro: MIN_ELIGIBLE_USD_MICRO,
    maxLeavesPerAsset: MAX_LEAVES_PER_ASSET,
    maxMinLeafPasses: MAX_MIN_LEAF_PASSES,
    minLeafValueLamports: MIN_LEAF_VALUE_LAMPORTS,
    autoPushMinRentMultiple: AUTO_PUSH_MIN_RENT_MULTIPLE,
    excludeOffCurveOwners: true,
    staticExclusions: STATIC_EXCLUSIONS,
    priceFeedAccount: PYTH_SOL_USD_PRICE_ACCOUNT.toBase58(),
    priceFeedIdHex: PYTH_SOL_USD_FEED_ID,
    maxPriceAgeSecs: MAX_PRICE_AGE_SECS,
    maxPriceConfBps: MAX_PRICE_CONF_BPS,
    minExpirySecs: MIN_EXPIRY_SECS,
    roundExpirySecs: ROUND_EXPIRY_SECS,
  };
}

export function roundParams(): RoundParams {
  return {
    meanSnapshotIntervalSecs: MEAN_SNAPSHOT_INTERVAL_SECS,
    maxWindowSecs: MAX_ROUND_WINDOW_SECS,
    roundCostMaxBps: ROUND_COST_MAX_BPS,
    expectedBasketSize: BASKET_SIZE,
    priorityFeeLamportsPerTx: PRIORITY_FEE_LAMPORTS_PER_TX,
    swapImpactBps: SWAP_IMPACT_ESTIMATE_BPS,
    swapOverheadLamports: SWAP_OVERHEAD_LAMPORTS,
    maxBuyAttempts: MAX_BUY_ATTEMPTS,
    maxBuyPhaseSecs: MAX_BUY_PHASE_SECS,
    maxTransferFeeBps: MAX_BASKET_TRANSFER_FEE_BPS,
    maxActivationAttempts: MAX_ACTIVATION_ATTEMPTS,
    maxPushesPerStep: MAX_PUSHES_PER_STEP,
    maxPushAttempts: MAX_PUSH_ATTEMPTS,
  };
}
