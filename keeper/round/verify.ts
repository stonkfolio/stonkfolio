/**
 * Independent re-check of a published round. Offline, every file hash, the
 * secret commitment, seeded sample selection, allocation and Merkle root are
 * recomputed from inputs.json and must match the bundle byte for byte. With
 * an RPC, the bundle is also held against what the distributor program
 * recorded: its fixed policy, the round intent, the committed header, and
 * each basket purchase's transactions.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { canonicalJson } from "../../lib/canonicalJson";
import { readArtifacts } from "../../lib/artifacts";
import { u64le } from "../../lib/merkle";
import { DISTRIBUTOR_PROGRAM_ID, DistributorClient, distributorAddress, intentRecord } from "../distributor/client";
import { policyHash } from "./policy";
import { PreparedRound, PurchaseEvidence, RoundInputs, parseRoundInputs, prepareRound } from "./prepare";

export interface VerifyReport {
  programId: string;
  distributor: string;
  roundId: bigint;
  roundAddress: string;
  manifestHash: string;
  assetsRoot: string;
  assets: number;
  recipients: number;
  inputs: RoundInputs;
  prepared: PreparedRound;
}

export function verifyRoundArtifacts(dir: string): VerifyReport {
  const { manifestHash, files } = readArtifacts(dir);
  const inputsText = files.get("inputs.json");
  if (inputsText === undefined) throw new Error("bundle has no inputs.json");
  const inputs = parseRoundInputs(inputsText);
  if (canonicalJson(inputs) !== inputsText) throw new Error("inputs.json is not in canonical form");

  const prepared = prepareRound(inputs);
  for (const file of prepared.files) {
    const published = files.get(file.path);
    if (published === undefined) throw new Error(`bundle is missing ${file.path}`);
    if (published !== file.contents) throw new Error(`${file.path} does not match what the inputs produce`);
  }
  if (!prepared.manifestHash.equals(manifestHash)) throw new Error("manifest does not match what the inputs produce");

  const programId = new PublicKey(inputs.programId);
  const distributor = new PublicKey(inputs.distributor);
  const [roundAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("round"), distributor.toBuffer(), u64le(inputs.roundId)],
    programId
  );
  return {
    programId: inputs.programId,
    distributor: inputs.distributor,
    roundId: inputs.roundId,
    roundAddress: roundAddress.toBase58(),
    manifestHash: manifestHash.toString("hex"),
    assetsRoot: prepared.trees.assetsRoot.toString("hex"),
    assets: prepared.allocation.assets.length,
    recipients: new Set(prepared.allocation.assets.flatMap((a) => a.leaves.map((l) => l.recipient))).size,
    inputs,
    prepared,
  };
}

function differs(what: string): never {
  throw new Error(`${what} differs between this bundle and the chain`);
}

/**
 * Holds an offline-verified bundle against the chain. Throws on any mismatch;
 * returns notes a reader should know about (things the chain can't prove).
 */
export async function verifyRoundOnChain(connection: Connection, report: VerifyReport): Promise<string[]> {
  const { inputs, prepared } = report;
  const notes: string[] = [];
  if (inputs.programId !== DISTRIBUTOR_PROGRAM_ID.toBase58()) {
    throw new Error(`bundle names program ${inputs.programId}, not the Stonkfolio distributor ${DISTRIBUTOR_PROGRAM_ID.toBase58()}`);
  }
  // Read-only: the throwaway key never signs anything.
  const client = new DistributorClient(connection, Keypair.generate(), new PublicKey(inputs.distributor));

  const distributor = await client.fetchDistributor();
  if (!distributor) throw new Error(`distributor ${inputs.distributor} not found`);
  if (!distributorAddress(distributor.indexMint, distributor.creator).equals(client.distributor)) {
    throw new Error("distributor account is not at its program address");
  }
  if (distributor.indexMint.toBase58() !== inputs.indexMint) differs("index mint");
  const { policy } = inputs;
  if (!Buffer.from(distributor.policyHash).equals(policyHash(policy))) differs("round policy (its hash is fixed when the distributor is created)");
  const fixedRules: [string, unknown, unknown][] = [
    ["price feed account", distributor.priceFeedAccount.toBase58(), policy.priceFeedAccount],
    ["price feed id", Buffer.from(distributor.priceFeedId).toString("hex"), policy.priceFeedIdHex],
    ["maximum price age", distributor.maxPriceAgeSecs, policy.maxPriceAgeSecs],
    ["maximum price confidence", distributor.maxPriceConfBps, policy.maxPriceConfBps],
    ["seed slot offset", distributor.seedSlotOffset, policy.seedSlotOffset],
    ["minimum window", distributor.minWindowSecs, policy.minWindowSecs],
    ["minimum expiry", distributor.minExpirySecs.toNumber(), policy.minExpirySecs],
  ];
  for (const [rule, onChain, published] of fixedRules) if (onChain !== published) differs(rule);
  if (distributor.rootAuthority.toBase58() !== inputs.rootAuthority) {
    notes.push(`the distributor's keeper is now ${distributor.rootAuthority.toBase58()}, not ${inputs.rootAuthority}; confirm the key rotated after this round`);
  }

  const intent = await client.fetchIntent(inputs.roundId);
  if (!intent) throw new Error(`round ${inputs.roundId} has no on-chain intent`);
  if (intent.status !== "committed") throw new Error(`round ${inputs.roundId} intent is ${intent.status}, not committed`);
  if (canonicalJson(intentRecord(intent)) !== canonicalJson(inputs.intent)) differs("round intent (window, snapshot chain, SOL/USD price or seed)");

  const header = await client.fetchRound(inputs.roundId);
  if (!header) throw new Error(`round account ${report.roundAddress} not found`);
  if (Buffer.from(header.assetsRoot).toString("hex") !== report.assetsRoot) differs("assets root");
  if (Buffer.from(header.artifactHash).toString("hex") !== report.manifestHash) differs("artifact hash");
  if (header.assetCount !== prepared.trees.assets.length) differs("asset count");
  if (header.windowStartSlot.toNumber() !== intent.openSlot || header.windowEndSlot.toNumber() !== intent.closeSlot) differs("window");

  for (const purchase of inputs.purchases) await verifyPurchase(connection, purchase);

  notes.push("snapshot balances, the pool price, and each coin's allocatable amount are attested by the keeper; spot-check them against an archive RPC");
  return notes;
}

/**
 * A purchase's price sets its minimum payout, so both sides are checked: the
 * buyer signed every transaction, received exactly the claimed tokens, and
 * spent at least the claimed lamports.
 */
async function verifyPurchase(connection: Connection, purchase: PurchaseEvidence): Promise<void> {
  let received = 0n;
  let lamportsOut = 0n;
  for (const signature of purchase.signatures) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) throw new Error(`purchase transaction ${signature} not found`);
    if (tx.meta.err) throw new Error(`purchase transaction ${signature} failed`);
    const message = tx.transaction.message;
    const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    let buyerIndex = -1;
    for (let i = 0; i < keys.length; i++) if (keys.get(i)!.toBase58() === purchase.buyer) buyerIndex = i;
    if (buyerIndex < 0 || !message.isAccountSigner(buyerIndex)) throw new Error(`purchase transaction ${signature} is not signed by ${purchase.buyer}`);
    lamportsOut += BigInt(tx.meta.preBalances[buyerIndex]) - BigInt(tx.meta.postBalances[buyerIndex]);
    const held = (balances: typeof tx.meta.postTokenBalances) =>
      (balances ?? [])
        .filter((b) => b.owner === purchase.buyer && b.mint === purchase.mint)
        .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
    received += held(tx.meta.postTokenBalances) - held(tx.meta.preTokenBalances);
  }
  if (received !== purchase.received) differs(`amount of ${purchase.mint} received`);
  if (lamportsOut < purchase.lamportsSpent) differs(`lamports spent on ${purchase.mint}`);
}

/**
 * RoundHeader layout: 8-byte discriminator, distributor (32), round_id (8),
 * assets_root (32), artifact_hash (32), ...
 */
export function readCommittedRoundHashes(data: Buffer): { assetsRoot: string; artifactHash: string } {
  if (data.length < 112) throw new Error("account too small to be a RoundHeader");
  return {
    assetsRoot: data.subarray(48, 80).toString("hex"),
    artifactHash: data.subarray(80, 112).toString("hex"),
  };
}
