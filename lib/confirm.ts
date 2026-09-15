import { Connection, TransactionSignature, Commitment } from "@solana/web3.js";

/**
 * Some RPC providers (confirmed here: Alchemy's devnet endpoint) don't
 * implement the `signatureSubscribe` WebSocket method web3.js's default
 * `confirmTransaction` relies on. The failure mode is NOT a fast error: the
 * subscription setup just never reaches "subscribed" state, which gates a
 * polling fallback that's already built into web3.js — so every transaction
 * confirmation (raw `sendAndConfirmTransaction` AND Anchor's `.rpc()`, which
 * both ultimately call `connection.confirmTransaction` on the same
 * connection instance) hangs until a flat timeout or the blockhash expires,
 * even though the transaction actually landed. Confirmed by watching a real
 * SOL balance change while `sendAndConfirmTransaction` still threw
 * `TransactionExpiredBlockheightExceededError`.
 *
 * This isn't just a local test problem: a keeper bot deployed against a
 * similarly WS-limited RPC tier in production would hang the exact same
 * way. Call this once on any `Connection` this project constructs, right
 * after creating it — it replaces `confirmTransaction` with a plain
 * `getSignatureStatuses` poll, which needs nothing but the RPC's ordinary
 * HTTP JSON-RPC surface.
 */
export function patchConnectionForPollingConfirmation(connection: Connection): void {
  (connection as any).confirmTransaction = async (
    strategyOrSignature: TransactionSignature | { signature: TransactionSignature },
    commitment?: Commitment
  ) => {
    const signature =
      typeof strategyOrSignature === "string" ? strategyOrSignature : strategyOrSignature.signature;
    const target = commitment ?? connection.commitment ?? "confirmed";
    const rank: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };
    const targetRank = rank[target] ?? rank.confirmed;

    const start = Date.now();
    const timeoutMs = 90_000;
    while (Date.now() - start < timeoutMs) {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (status) {
        if (status.err) {
          throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
        }
        const actualRank = rank[status.confirmationStatus ?? "processed"] ?? 0;
        if (actualRank >= targetRank) {
          return { context: { slot: status.slot }, value: { err: status.err ?? null } };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Transaction ${signature} not confirmed within ${timeoutMs}ms (polling fallback)`);
  };
}

/**
 * A load-balanced multi-node RPC endpoint (confirmed here: Alchemy's devnet
 * tier) can route consecutive calls to backend nodes that lag each other by
 * a slot or two. A blockhash fetched for one transaction is sometimes still
 * unknown to whichever node the very next `sendTransaction` preflight lands
 * on, surfacing as "Transaction simulation failed: Blockhash not found" even
 * though the transaction is perfectly valid and the blockhash is fresh.
 *
 * Both raw `sendAndConfirmTransaction` and Anchor's `.rpc()` re-fetch a
 * blockhash and re-sign on every call when given a `Transaction` that
 * doesn't already carry a signature, so simply re-invoking the same send
 * thunk on this specific error is safe and clears it in practice — this is
 * the same tolerance production Solana bots build in for exactly this class
 * of RPC provider flakiness.
 */
export async function withBlockhashRetry<T>(send: () => Promise<T>, retries = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (attempt < retries && /blockhash not found/i.test(String(err))) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}
