/**
 * A coin's round policy: every rule that shapes who gets paid, fixed when its
 * distributor is created. The distributor stores sha256(canonical policy), and
 * every round publishes the full policy, so the keeper can't quietly change
 * the threshold, exclusions or sampling for a particular round.
 */
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { canonicalJson } from "../../lib/canonicalJson";
import { ExclusionEntry } from "./types";

export interface RoundPolicy {
  version: 1;
  samplesPerRound: number;
  minWindowSecs: number;
  /** Slots after the window closes before the block whose hash seeds sampling. */
  seedSlotOffset: number;
  minEligibleUsdMicro: bigint;
  maxLeavesPerAsset: number;
  maxMinLeafPasses: number;
  /** Payouts worth less than this, at the round's purchase price, are dropped and redistributed. */
  minLeafValueLamports: bigint;
  /** A first payout of a coin is pushed only if worth at least this many token-account rents; otherwise it waits for self-claim. */
  autoPushMinRentMultiple: number;
  /** Program-owned wallets (pool vaults, lockers, multisigs) never receive payouts. */
  excludeOffCurveOwners: true;
  staticExclusions: ExclusionEntry[];
  priceFeedAccount: string;
  priceFeedIdHex: string;
  maxPriceAgeSecs: number;
  maxPriceConfBps: number;
  minExpirySecs: number;
  roundExpirySecs: number;
}

const U32_MAX = 4_294_967_295;
const TEN_YEARS_SECS = 10 * 365 * 24 * 60 * 60;

export function policyHash(policy: RoundPolicy): Buffer {
  return createHash("sha256").update(canonicalJson(policy)).digest();
}

function requireInt(value: unknown, min: number, max: number, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`policy.${field} must be an integer in [${min}, ${max}]`);
  }
}

export function validatePolicy(policy: RoundPolicy): void {
  if (policy.version !== 1) throw new Error("unsupported policy version");
  requireInt(policy.samplesPerRound, 1, 10_000, "samplesPerRound");
  requireInt(policy.minWindowSecs, 0, U32_MAX, "minWindowSecs");
  requireInt(policy.seedSlotOffset, 1, 256, "seedSlotOffset");
  requireInt(policy.maxLeavesPerAsset, 1, 65_536, "maxLeavesPerAsset");
  requireInt(policy.maxMinLeafPasses, 0, 100, "maxMinLeafPasses");
  requireInt(policy.autoPushMinRentMultiple, 0, 1_000, "autoPushMinRentMultiple");
  requireInt(policy.maxPriceAgeSecs, 1, U32_MAX, "maxPriceAgeSecs");
  requireInt(policy.maxPriceConfBps, 1, 10_000, "maxPriceConfBps");
  requireInt(policy.minExpirySecs, 0, TEN_YEARS_SECS, "minExpirySecs");
  requireInt(policy.roundExpirySecs, Math.max(1, policy.minExpirySecs), TEN_YEARS_SECS, "roundExpirySecs");
  if (typeof policy.minEligibleUsdMicro !== "bigint" || policy.minEligibleUsdMicro < 0n) throw new Error("policy.minEligibleUsdMicro must be non-negative");
  if (typeof policy.minLeafValueLamports !== "bigint" || policy.minLeafValueLamports < 0n) throw new Error("policy.minLeafValueLamports must be non-negative");
  if (policy.excludeOffCurveOwners !== true) throw new Error("policy.excludeOffCurveOwners must be true");
  if (!/^[0-9a-f]{64}$/.test(policy.priceFeedIdHex)) throw new Error("policy.priceFeedIdHex must be 64 lowercase hex characters");
  requirePubkeyString(policy.priceFeedAccount, "policy.priceFeedAccount");
  const owners = new Set<string>();
  for (const [i, exclusion] of policy.staticExclusions.entries()) {
    requirePubkeyString(exclusion.owner, `policy.staticExclusions[${i}].owner`);
    if (typeof exclusion.reason !== "string" || exclusion.reason.length === 0) throw new Error(`policy.staticExclusions[${i}] needs a reason`);
    if (owners.has(exclusion.owner)) throw new Error(`policy.staticExclusions lists ${exclusion.owner} twice`);
    owners.add(exclusion.owner);
  }
}

export function requirePubkeyString(value: unknown, field: string): void {
  let canonical: string | undefined;
  try {
    canonical = typeof value === "string" ? new PublicKey(value).toBase58() : undefined;
  } catch {
    canonical = undefined;
  }
  if (canonical === undefined || canonical !== value) throw new Error(`${field} must be a base58 public key`);
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function bigField(value: Json, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${field} must be a non-negative integer string`);
  return BigInt(value);
}

export function parsePolicy(v: Json): RoundPolicy {
  const policy: RoundPolicy = {
    version: v.version,
    samplesPerRound: v.samplesPerRound,
    minWindowSecs: v.minWindowSecs,
    seedSlotOffset: v.seedSlotOffset,
    minEligibleUsdMicro: bigField(v.minEligibleUsdMicro, "policy.minEligibleUsdMicro"),
    maxLeavesPerAsset: v.maxLeavesPerAsset,
    maxMinLeafPasses: v.maxMinLeafPasses,
    minLeafValueLamports: bigField(v.minLeafValueLamports, "policy.minLeafValueLamports"),
    autoPushMinRentMultiple: v.autoPushMinRentMultiple,
    excludeOffCurveOwners: v.excludeOffCurveOwners,
    staticExclusions: (v.staticExclusions as Json[]).map((e) => ({ owner: e.owner, reason: e.reason })),
    priceFeedAccount: v.priceFeedAccount,
    priceFeedIdHex: v.priceFeedIdHex,
    maxPriceAgeSecs: v.maxPriceAgeSecs,
    maxPriceConfBps: v.maxPriceConfBps,
    minExpirySecs: v.minExpirySecs,
    roundExpirySecs: v.roundExpirySecs,
  };
  validatePolicy(policy);
  return policy;
}
