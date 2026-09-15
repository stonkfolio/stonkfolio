import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { base58Encode } from "./base58";
import { withBlockhashRetry } from "./confirm";

/** Called with a transaction's signature before it is sent, so a caller can journal it. */
export type OnSigned = (signature: string, lastValidBlockHeight: number) => void;

/**
 * Sends instructions (or an SDK-built transaction's instructions) as a fresh
 * transaction on every attempt. The Meteora SDKs return transactions with no
 * fee payer or blockhash, so this sets both, and `withBlockhashRetry` can
 * safely re-sign after a stale-blockhash rejection.
 *
 * When `computeUnits` is given, any compute-unit instructions already in the
 * input are replaced, since a transaction may only set the limit once.
 *
 * With `onSigned`, every signed attempt is reported before it's sent. A
 * caller that records it can later tell whether a send that timed out landed
 * (see `resolveSignature`) instead of sending the same action again.
 */
export async function sendTransaction(
  connection: Connection,
  input: Transaction | TransactionInstruction[] | (Transaction | TransactionInstruction[])[],
  payer: Keypair,
  signers: Keypair[] = [],
  computeUnits?: number,
  onSigned?: OnSigned
): Promise<string> {
  const parts = Array.isArray(input) && input.some((item) => item instanceof Transaction || Array.isArray(item))
    ? (input as (Transaction | TransactionInstruction[])[])
    : [input as Transaction | TransactionInstruction[]];
  let instructions = parts.flatMap((part) => (part instanceof Transaction ? part.instructions : part));
  if (computeUnits !== undefined) {
    instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ...instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)),
    ];
  }
  const uniqueSigners = [payer, ...signers].filter(
    (signer, i, all) => all.findIndex((other) => other.publicKey.equals(signer.publicKey)) === i
  );
  if (!onSigned) {
    return withBlockhashRetry(() => {
      const tx = new Transaction().add(...instructions);
      tx.feePayer = payer.publicKey;
      return sendAndConfirmTransaction(connection, tx, uniqueSigners, { commitment: "confirmed" });
    });
  }
  return withBlockhashRetry(async () => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
    tx.sign(...uniqueSigners);
    const signature = base58Encode(tx.signature!);
    onSigned(signature, lastValidBlockHeight);
    await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(value.err)}`);
    return signature;
  });
}

export type SignatureOutcome = "landed" | "failed" | "expired" | "pending";

/**
 * Only called "expired" once the chain is this many blocks past the
 * transaction's last valid height, so a lagging RPC node that hasn't seen a
 * landed transaction yet can't make it look expired.
 */
const EXPIRY_MARGIN_BLOCKS = 150;

/** What became of a journaled transaction. */
export async function resolveSignature(connection: Connection, signature: string, lastValidBlockHeight: number): Promise<SignatureOutcome> {
  const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = value[0];
  if (status) {
    if (status.err) return "failed";
    return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ? "landed" : "pending";
  }
  const height = await connection.getBlockHeight("confirmed");
  return height > lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS ? "expired" : "pending";
}

/**
 * How a confirmed transaction changed one account's lamports (post − pre),
 * plus the fee it paid. Retries while the RPC hasn't indexed the transaction;
 * undefined if it never shows up.
 */
export async function lamportChange(
  connection: Connection,
  signature: string,
  account: PublicKey,
  attempts = 6
): Promise<{ delta: bigint; fee: bigint } | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx?.meta) {
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
      for (let i = 0; i < keys.length; i++) {
        if (keys.get(i)!.equals(account)) {
          return { delta: BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]), fee: BigInt(tx.meta.fee) };
        }
      }
      return { delta: 0n, fee: BigInt(tx.meta.fee) };
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return undefined;
}
