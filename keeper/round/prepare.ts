/**
 * Turns a round's recorded inputs into its allocation, Merkle trees, and
 * publishable artifact bundle. The keeper calls this before committing; the
 * verifier calls the very same function on the published inputs and demands
 * byte-identical output.
 *
 * Inputs carry the round's on-chain intent (secret commitment, window,
 * snapshot chain head, SOL/USD price and seed block, all recorded by the
 * distributor program) and the distributor's fixed policy. `checkInputs`
 * rejects anything that doesn't follow from those.
 */
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { canonicalJson } from "../../lib/canonicalJson";
import { ArtifactFile, buildManifest, sha256Hex } from "../../lib/artifacts";
import { u64le } from "../../lib/merkle";
import { toMicroUsd } from "../../lib/pyth";
import { allocate } from "./allocate";
import { RoundPolicy, parsePolicy, policyHash, requirePubkeyString, validatePolicy } from "./policy";
import { deriveSampleSeed, selectSampleIndices } from "./select";
import { RoundTrees, buildRoundTrees, summarizeTrees } from "./trees";
import { AllocationResult, AssetInput, ExclusionEntry, Rational, Snapshot } from "./types";

/** Values the distributor program recorded in the round's RoundIntent account. */
export interface IntentRecord {
  openSlot: number;
  openTs: number;
  closeSlot: number;
  closeTs: number;
  snapshotCount: number;
  snapshotChainHeadHex: string;
  secretCommitmentHex: string;
  seedSlot: number;
  seedHashHex: string;
  solUsd: { price: bigint; conf: bigint; exponent: number; publishTime: number };
}

/** A basket purchase, provable from its transactions: `buyer` received `received` of `mint`. */
export interface PurchaseEvidence {
  mint: string;
  tokenProgram: string;
  buyer: string;
  lamportsSpent: bigint;
  received: bigint;
  signatures: string[];
}

export interface RoundInputs {
  version: 2;
  programId: string;
  distributor: string;
  indexMint: string;
  rootAuthority: string;
  roundId: bigint;
  policy: RoundPolicy;
  intent: IntentRecord;
  /** Revealed on-chain at commit. */
  secretHex: string;
  /** Every snapshot taken during the round, identified by the hash of its canonical JSON. */
  candidates: { index: number; slot: number; sha256: string }[];
  selectedSnapshots: Snapshot[];
  purchases: PurchaseEvidence[];
  assets: AssetInput[];
}

export interface PreparedRound {
  inputs: RoundInputs;
  allocation: AllocationResult;
  trees: RoundTrees;
  meta: Record<string, unknown>;
  files: ArtifactFile[];
  manifestHash: Buffer;
}

export function snapshotHash(snapshot: Snapshot): string {
  return sha256Hex(canonicalJson(snapshot));
}

export const SNAPSHOT_CHAIN_DOMAIN = "stonkfolio-snapshots";

export function snapshotChainGenesis(distributor: string, roundId: bigint): string {
  return createHash("sha256").update(SNAPSHOT_CHAIN_DOMAIN).update(new PublicKey(distributor).toBuffer()).update(u64le(roundId)).digest("hex");
}

export function extendSnapshotChain(headHex: string, snapshotSha256: string): string {
  return createHash("sha256").update(Buffer.from(headHex, "hex")).update(Buffer.from(snapshotSha256, "hex")).digest("hex");
}

/** Hash chain over snapshot hashes in index order; the program records its head when the window closes. */
export function snapshotChainHead(distributor: string, roundId: bigint, snapshotHashes: string[]): string {
  return snapshotHashes.reduce(extendSnapshotChain, snapshotChainGenesis(distributor, roundId));
}

/** The policy's static exclusions plus the keeper's own wallet. */
export function roundExclusions(inputs: Pick<RoundInputs, "policy" | "rootAuthority">): ExclusionEntry[] {
  const exclusions = [...inputs.policy.staticExclusions];
  if (!exclusions.some((e) => e.owner === inputs.rootAuthority)) exclusions.push({ owner: inputs.rootAuthority, reason: "keeper wallet" });
  return exclusions;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** A payout worth less than the policy minimum at this round's purchase price is dropped. */
export function expectedMinLeafAmount(
  policy: RoundPolicy,
  purchase: Pick<PurchaseEvidence, "lamportsSpent" | "received"> | undefined
): bigint {
  if (!purchase || purchase.lamportsSpent === 0n || purchase.received === 0n) return 0n;
  return ceilDiv(policy.minLeafValueLamports * purchase.received, purchase.lamportsSpent);
}

const HEX32 = /^[0-9a-f]{64}$/;

function requireHex32(value: string, field: string): void {
  if (!HEX32.test(value)) throw new Error(`${field} must be 64 lowercase hex characters`);
}

/** Throws unless the inputs are well-formed and follow from the recorded intent and policy. */
export function checkInputs(inputs: RoundInputs): void {
  if (inputs.version !== 2) throw new Error("unsupported inputs version");
  for (const [field, value] of [
    ["programId", inputs.programId],
    ["distributor", inputs.distributor],
    ["indexMint", inputs.indexMint],
    ["rootAuthority", inputs.rootAuthority],
  ] as const) {
    requirePubkeyString(value, field);
  }
  const { policy, intent } = inputs;
  validatePolicy(policy);

  requireHex32(inputs.secretHex, "secretHex");
  requireHex32(intent.secretCommitmentHex, "intent.secretCommitmentHex");
  requireHex32(intent.snapshotChainHeadHex, "intent.snapshotChainHeadHex");
  requireHex32(intent.seedHashHex, "intent.seedHashHex");
  const secret = Buffer.from(inputs.secretHex, "hex");
  if (createHash("sha256").update(secret).digest("hex") !== intent.secretCommitmentHex) {
    throw new Error("revealed secret does not match its commitment");
  }
  if (intent.closeSlot < intent.openSlot) throw new Error("window closes before it opens");
  if (intent.closeTs - intent.openTs < policy.minWindowSecs) throw new Error("window is shorter than the policy minimum");
  if (intent.seedSlot < intent.closeSlot + policy.seedSlotOffset) throw new Error("seed block is too close to the window close");

  const { solUsd } = intent;
  if (solUsd.price <= 0n) throw new Error("SOL/USD price must be positive");
  if (intent.closeTs - solUsd.publishTime > policy.maxPriceAgeSecs) throw new Error("SOL/USD price was stale at close");
  if (solUsd.conf * 10_000n > solUsd.price * BigInt(policy.maxPriceConfBps)) throw new Error("SOL/USD confidence exceeds the policy limit");

  if (inputs.candidates.length !== intent.snapshotCount) throw new Error("candidate count differs from the recorded snapshot count");
  inputs.candidates.forEach((candidate, i) => {
    if (candidate.index !== i) throw new Error("candidates must be listed in index order starting at 0");
    requireHex32(candidate.sha256, `candidates[${i}].sha256`);
    if (!Number.isSafeInteger(candidate.slot) || candidate.slot < intent.openSlot || candidate.slot > intent.closeSlot) {
      throw new Error(`candidate ${i} was taken outside the recorded window`);
    }
  });
  if (snapshotChainHead(inputs.distributor, inputs.roundId, inputs.candidates.map((c) => c.sha256)) !== intent.snapshotChainHeadHex) {
    throw new Error("snapshot list does not match its recorded chain head");
  }

  const seed = deriveSampleSeed(inputs.roundId, Buffer.from(intent.seedHashHex, "hex"), secret);
  const expected = selectSampleIndices(
    inputs.candidates,
    { startSlot: intent.openSlot, endSlot: intent.closeSlot },
    policy.samplesPerRound,
    seed
  );
  const actual = inputs.selectedSnapshots.map((s) => s.index);
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new Error(`selected snapshots ${canonicalJson(actual)} differ from seeded selection ${canonicalJson(expected)}`);
  }
  for (const snapshot of inputs.selectedSnapshots) {
    const candidate = inputs.candidates[snapshot.index];
    if (!candidate || candidate.slot !== snapshot.slot || candidate.sha256 !== snapshotHash(snapshot)) {
      throw new Error(`snapshot ${snapshot.index} does not match its published hash`);
    }
    for (const [j, row] of snapshot.accounts.entries()) {
      requirePubkeyString(row.address, `snapshot ${snapshot.index} row ${j} address`);
      requirePubkeyString(row.owner, `snapshot ${snapshot.index} row ${j} owner`);
    }
  }

  const purchaseByMint = new Map<string, PurchaseEvidence>();
  for (const [i, purchase] of inputs.purchases.entries()) {
    requirePubkeyString(purchase.mint, `purchases[${i}].mint`);
    requirePubkeyString(purchase.tokenProgram, `purchases[${i}].tokenProgram`);
    requirePubkeyString(purchase.buyer, `purchases[${i}].buyer`);
    if (purchase.lamportsSpent < 0n || purchase.received < 0n) throw new Error(`purchases[${i}] has negative amounts`);
    if (purchase.received > 0n && purchase.signatures.length === 0) throw new Error(`purchases[${i}] has no transaction evidence`);
    if (purchaseByMint.has(purchase.mint)) throw new Error(`purchases list ${purchase.mint} twice`);
    purchaseByMint.set(purchase.mint, purchase);
  }
  for (const [i, asset] of inputs.assets.entries()) {
    requirePubkeyString(asset.mint, `assets[${i}].mint`);
    requirePubkeyString(asset.tokenProgram, `assets[${i}].tokenProgram`);
    if (asset.minLeafAmount !== expectedMinLeafAmount(policy, purchaseByMint.get(asset.mint))) {
      throw new Error(`assets[${i}].minLeafAmount does not follow from the policy and the purchase price`);
    }
  }
}

function balancesCsv(allocation: AllocationResult, snapshots: Snapshot[]): string {
  const slots = [...snapshots].sort((a, b) => a.slot - b.slot || a.index - b.index).map((s) => s.slot);
  const header = ["owner", "twab", "value_usd_micro", "eligible", ...slots.map((slot) => `balance_at_slot_${slot}`)];
  const rows = allocation.holders.map((h) =>
    [h.owner, h.twab.toString(), h.valueUsdMicro.toString(), String(h.eligible), ...h.sampleBalances.map(String)].join(",")
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

export function prepareRound(inputs: RoundInputs): PreparedRound {
  checkInputs(inputs);
  const { policy, intent } = inputs;
  const allocation = allocate({
    snapshots: inputs.selectedSnapshots,
    exclusions: roundExclusions(inputs),
    assets: inputs.assets,
    solUsdMicro: toMicroUsd(intent.solUsd.price, intent.solUsd.exponent),
    params: {
      minEligibleUsdMicro: policy.minEligibleUsdMicro,
      maxLeavesPerAsset: policy.maxLeavesPerAsset,
      maxMinLeafPasses: policy.maxMinLeafPasses,
    },
  });
  const trees = buildRoundTrees(new PublicKey(inputs.programId), new PublicKey(inputs.distributor), inputs.roundId, allocation.assets);
  const meta = {
    version: 2,
    programId: inputs.programId,
    distributor: inputs.distributor,
    roundId: inputs.roundId,
    policyHash: policyHash(policy).toString("hex"),
    windowStartSlot: intent.openSlot,
    windowEndSlot: intent.closeSlot,
  };
  const files: ArtifactFile[] = [
    { path: "inputs.json", contents: canonicalJson(inputs) },
    { path: "allocation.json", contents: canonicalJson(allocation) },
    { path: "trees.json", contents: canonicalJson(summarizeTrees(trees)) },
    { path: "balances.csv", contents: balancesCsv(allocation, inputs.selectedSnapshots) },
  ];
  const { manifestHash } = buildManifest(meta, files);
  return { inputs, allocation, trees, meta, files, manifestHash };
}

// --- parsing published inputs back into typed values -------------------------

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function big(value: Json, field: string): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error(`${field} must be an integer string`);
  return BigInt(value);
}

function int(value: Json, field: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
}

function str(value: Json, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function rational(value: Json, field: string): Rational {
  return { num: big(value?.num, `${field}.num`), den: big(value?.den, `${field}.den`) };
}

export function parseSnapshot(value: Json, field = "snapshot"): Snapshot {
  return {
    index: int(value.index, `${field}.index`),
    slot: int(value.slot, `${field}.slot`),
    timestamp: int(value.timestamp, `${field}.timestamp`),
    poolPrice: rational(value.poolPrice, `${field}.poolPrice`),
    accounts: (value.accounts as Json[]).map((row, i) => ({
      address: str(row.address, `${field}.accounts[${i}].address`),
      owner: str(row.owner, `${field}.accounts[${i}].owner`),
      amount: big(row.amount, `${field}.accounts[${i}].amount`),
    })),
  };
}

export function parseRoundInputs(text: string): RoundInputs {
  const v: Json = JSON.parse(text);
  return {
    version: int(v.version, "version") as 2,
    programId: str(v.programId, "programId"),
    distributor: str(v.distributor, "distributor"),
    indexMint: str(v.indexMint, "indexMint"),
    rootAuthority: str(v.rootAuthority, "rootAuthority"),
    roundId: big(v.roundId, "roundId"),
    policy: parsePolicy(v.policy),
    intent: {
      openSlot: int(v.intent.openSlot, "intent.openSlot"),
      openTs: int(v.intent.openTs, "intent.openTs"),
      closeSlot: int(v.intent.closeSlot, "intent.closeSlot"),
      closeTs: int(v.intent.closeTs, "intent.closeTs"),
      snapshotCount: int(v.intent.snapshotCount, "intent.snapshotCount"),
      snapshotChainHeadHex: str(v.intent.snapshotChainHeadHex, "intent.snapshotChainHeadHex"),
      secretCommitmentHex: str(v.intent.secretCommitmentHex, "intent.secretCommitmentHex"),
      seedSlot: int(v.intent.seedSlot, "intent.seedSlot"),
      seedHashHex: str(v.intent.seedHashHex, "intent.seedHashHex"),
      solUsd: {
        price: big(v.intent.solUsd.price, "intent.solUsd.price"),
        conf: big(v.intent.solUsd.conf, "intent.solUsd.conf"),
        exponent: int(v.intent.solUsd.exponent, "intent.solUsd.exponent"),
        publishTime: int(v.intent.solUsd.publishTime, "intent.solUsd.publishTime"),
      },
    },
    secretHex: str(v.secretHex, "secretHex"),
    candidates: (v.candidates as Json[]).map((c, i) => ({
      index: int(c.index, `candidates[${i}].index`),
      slot: int(c.slot, `candidates[${i}].slot`),
      sha256: str(c.sha256, `candidates[${i}].sha256`),
    })),
    selectedSnapshots: (v.selectedSnapshots as Json[]).map((s, i) => parseSnapshot(s, `selectedSnapshots[${i}]`)),
    purchases: (v.purchases as Json[]).map((p, i) => ({
      mint: str(p.mint, `purchases[${i}].mint`),
      tokenProgram: str(p.tokenProgram, `purchases[${i}].tokenProgram`),
      buyer: str(p.buyer, `purchases[${i}].buyer`),
      lamportsSpent: big(p.lamportsSpent, `purchases[${i}].lamportsSpent`),
      received: big(p.received, `purchases[${i}].received`),
      signatures: (p.signatures as Json[]).map((s, j) => str(s, `purchases[${i}].signatures[${j}]`)),
    })),
    assets: (v.assets as Json[]).map((a, i) => ({
      mint: str(a.mint, `assets[${i}].mint`),
      tokenProgram: str(a.tokenProgram, `assets[${i}].tokenProgram`),
      allocatable: big(a.allocatable, `assets[${i}].allocatable`),
      minLeafAmount: big(a.minLeafAmount, `assets[${i}].minLeafAmount`),
    })),
  };
}
