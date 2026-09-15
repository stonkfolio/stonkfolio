import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { OnSigned, sendTransaction } from "../lib/send";

/**
 * Plain SOL transfer from the keeper (the platform revenue share). Returns
 * undefined without sending when `lamports` is zero or `destination` is still
 * the PublicKey.default placeholder, so an unconfigured wallet doesn't crash
 * the tick.
 */
export async function transferSol(
  connection: Connection,
  keeper: Keypair,
  destination: PublicKey,
  lamports: bigint,
  onSigned?: OnSigned
): Promise<string | undefined> {
  if (lamports === 0n || destination.equals(PublicKey.default)) return undefined;
  return sendTransaction(
    connection,
    [SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: destination, lamports })],
    keeper,
    [],
    undefined,
    onSigned
  );
}
