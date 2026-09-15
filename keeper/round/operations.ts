/** Pure decisions the round engine makes about costs, payouts and retries. */
import { PublicKey } from "@solana/web3.js";
import type { Ledger } from "../state";
import { Rational, TokenAccountRow } from "./types";

const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Owners whose current balance already clears the payout threshold, capped at
 * the per-asset leaf limit. Sizes a round's cost estimate, so wallets holding
 * dust can't inflate it and starve the trigger.
 */
export function countLikelyEligible(
  accounts: TokenAccountRow[],
  poolPrice: Rational,
  solUsdMicro: bigint,
  opts: { minEligibleUsdMicro: bigint; excluded: Set<string>; excludeOffCurve: boolean; cap: number }
): number {
  const byOwner = new Map<string, bigint>();
  for (const row of accounts) {
    if (!opts.excluded.has(row.owner)) byOwner.set(row.owner, (byOwner.get(row.owner) ?? 0n) + row.amount);
  }
  // Same comparison as allocate(): balance × price × SOL/USD against the threshold, all in integers.
  const threshold = opts.minEligibleUsdMicro * poolPrice.den * LAMPORTS_PER_SOL;
  let count = 0;
  for (const [owner, amount] of byOwner) {
    if (amount === 0n || amount * poolPrice.num * solUsdMicro < threshold) continue;
    if (opts.excludeOffCurve) {
      let onCurve: boolean;
      try {
        onCurve = PublicKey.isOnCurve(new PublicKey(owner).toBuffer());
      } catch {
        continue;
      }
      if (!onCurve) continue;
    }
    if (++count >= opts.cap) return opts.cap;
  }
  return count;
}

/**
 * A payout into an existing token account is always pushed. One that needs a
 * new account is pushed only if it's worth at least `minRentMultiple` times
 * that account's rent at the round's purchase price; otherwise the holder
 * self-claims and pays the rent themselves.
 */
export function shouldAutoPush(input: {
  accountExists: boolean;
  amount: bigint;
  /** What the round paid: `lamports` for `tokens` raw units. Absent for coins carried over unbought. */
  price?: { lamports: bigint; tokens: bigint };
  rentLamports: bigint;
  minRentMultiple: number;
}): boolean {
  if (input.accountExists) return true;
  if (!input.price || input.price.tokens <= 0n) return false;
  return input.amount * input.price.lamports >= input.rentLamports * BigInt(input.minRentMultiple) * input.price.tokens;
}

/** Takes up to `amount` from a bucket; returns what was taken. */
export function debit(ledger: Ledger, bucket: keyof Ledger, amount: bigint): bigint {
  const taken = amount < ledger[bucket] ? amount : ledger[bucket];
  ledger[bucket] -= taken;
  return taken;
}

/**
 * Settles a finished round's operations reserve against what it really spent:
 * unused reserve goes back to the basket, and an overrun is taken from it.
 */
export function reconcileReserve(ledger: Ledger, reserve: bigint, spent: bigint): { returned: bigint; overrun: bigint } {
  const held = debit(ledger, "operationsLamports", reserve);
  if (spent <= held) {
    ledger.basketLamports += held - spent;
    return { returned: held - spent, overrun: 0n };
  }
  return { returned: 0n, overrun: debit(ledger, "basketLamports", spent - held) };
}

/**
 * Trouble on the keeper's side — the RPC, the network, or its own SOL for
 * fees — rather than anything about the action itself. Such failures pause
 * and retry without counting against the action (or the holder it pays);
 * every other failure counts toward that action's attempt limit.
 */
export function isTransientError(text: string): boolean {
  if (/custom program error|Error Code:|InstructionError/i.test(text)) return false;
  return /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|timed? ?out|not confirmed|blockhash not found|block height exceeded|429|Too Many Requests|50[0234]\b|network|debit an account|insufficient funds for fee|insufficient lamports/i.test(
    text
  );
}

export function backoffSecs(attempts: number, baseSecs = 60, maxSecs = 6 * 60 * 60): number {
  return Math.min(baseSecs * 2 ** Math.max(0, attempts - 1), maxSecs);
}
