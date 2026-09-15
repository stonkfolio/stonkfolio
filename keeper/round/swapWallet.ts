/**
 * Basket buys run from a throwaway wallet funded with exactly one buy's SOL,
 * so a swap transaction from an untrusted API can reach nothing else the
 * keeper holds. Afterwards everything in the wallet comes back to the keeper.
 */
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeAmount,
  unpackAccount,
} from "@solana/spl-token";
import { sendTransaction } from "../../lib/send";

export interface SweepResult {
  /** Raw units of the bought mint moved to the keeper (before any transfer fee). */
  tokens: bigint;
  /** Lamports sent or refunded to the keeper (wallet balance plus closed-account rent). */
  lamportsReturned: bigint;
  signature?: string;
}

/**
 * Moves the bought mint and all SOL out of a swap wallet into the keeper, and
 * closes the wallet's token accounts for that mint and wrapped SOL. Only token
 * accounts the wallet still owns can be swept, so a swap that handed its
 * output account to someone else loses at most that one buy.
 */
export async function sweepSwapWallet(
  connection: Connection,
  keeper: Keypair,
  wallet: Keypair,
  mint: PublicKey,
  tokenProgram: PublicKey,
  /** Called with the sweep's signature and what it will move before it's sent, so a caller can journal it. */
  onSigned?: (signature: string, lastValidBlockHeight: number, plan: { tokens: bigint; lamportsReturned: bigint }) => void
): Promise<SweepResult> {
  const instructions: TransactionInstruction[] = [];
  let tokens = 0n;
  let lamportsReturned = 0n;
  let decimals: number | undefined;
  const keeperAccount = getAssociatedTokenAddressSync(mint, keeper.publicKey, false, tokenProgram);

  const owned = [
    ...(await connection.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }, "confirmed")).value,
    ...(await connection.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed")).value,
  ];
  for (const { pubkey, account } of owned) {
    const programId = account.owner;
    const parsed = unpackAccount(pubkey, account, programId);
    if (parsed.mint.equals(mint)) {
      if (parsed.amount > 0n) {
        decimals ??= (await getMint(connection, mint, "confirmed", tokenProgram)).decimals;
        if (tokens === 0n) {
          instructions.push(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperAccount, keeper.publicKey, mint, tokenProgram));
        }
        instructions.push(createTransferCheckedInstruction(pubkey, mint, keeperAccount, wallet.publicKey, parsed.amount, decimals, [], programId));
        tokens += parsed.amount;
      }
      // Fees withheld on the way in must go back to the mint before the account can close.
      if ((getTransferFeeAmount(parsed)?.withheldAmount ?? 0n) > 0n) {
        instructions.push(createHarvestWithheldTokensToMintInstruction(mint, [pubkey], programId));
      }
      instructions.push(createCloseAccountInstruction(pubkey, keeper.publicKey, wallet.publicKey, [], programId));
      lamportsReturned += BigInt(account.lamports);
    } else if (parsed.mint.equals(NATIVE_MINT)) {
      instructions.push(createCloseAccountInstruction(pubkey, keeper.publicKey, wallet.publicKey, [], programId));
      lamportsReturned += BigInt(account.lamports);
    }
  }

  const balance = BigInt(await connection.getBalance(wallet.publicKey, "confirmed"));
  if (balance > 0n) {
    instructions.push(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: keeper.publicKey, lamports: balance }));
    lamportsReturned += balance;
  }
  if (instructions.length === 0) return { tokens: 0n, lamportsReturned: 0n };
  const signature = await sendTransaction(
    connection,
    instructions,
    keeper,
    [wallet],
    undefined,
    onSigned && ((sig, height) => onSigned(sig, height, { tokens, lamportsReturned }))
  );
  return { tokens, lamportsReturned, signature };
}
