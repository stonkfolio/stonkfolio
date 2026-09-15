/** Where holder balances come from: every token account of the index coin, at a known slot. */
import { Connection, PublicKey } from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TokenAccountRow } from "../round/types";

export interface HolderSnapshotRows {
  slot: number;
  accounts: TokenAccountRow[];
}

export interface HolderSource {
  fetch(mint: PublicKey): Promise<HolderSnapshotRows>;
}

function finalizeRows(rows: TokenAccountRow[]): TokenAccountRow[] {
  const byAddress = new Map<string, TokenAccountRow>();
  for (const row of rows) if (row.amount > 0n) byAddress.set(row.address, row);
  return [...byAddress.values()].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/**
 * Plain `getProgramAccounts` filtered by mint. Works on local validators and
 * devnet; public mainnet RPCs refuse this query for the SPL Token program.
 */
export class RpcProgramAccountsSource implements HolderSource {
  constructor(
    private readonly connection: Connection,
    private readonly tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ) {}

  async fetch(mint: PublicKey): Promise<HolderSnapshotRows> {
    const { context, value } = await this.connection.getProgramAccounts(this.tokenProgram, {
      commitment: "confirmed",
      withContext: true,
      filters: [{ dataSize: AccountLayout.span }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
    });
    const rows = value.map(({ pubkey, account }) => {
      const decoded = AccountLayout.decode(account.data);
      return { address: pubkey.toBase58(), owner: new PublicKey(decoded.owner).toBase58(), amount: decoded.amount };
    });
    return { slot: context.slot, accounts: finalizeRows(rows) };
  }
}

export type FetchText = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Helius DAS `getTokenAccounts`, paged by cursor — the mainnet source.
 * Amounts are re-quoted before JSON parsing so balances above 2^53 keep full
 * precision. The snapshot slot is the lowest `last_indexed_slot` seen across
 * pages, so every row is at least that fresh.
 */
export class HeliusDasSource implements HolderSource {
  constructor(
    private readonly rpcUrl: string,
    private readonly fetchText: FetchText = fetch as unknown as FetchText,
    private readonly pageSize = 1_000,
    private readonly maxPages = 10_000,
    private readonly timeoutMs = 30_000
  ) {}

  async fetch(mint: PublicKey): Promise<HolderSnapshotRows> {
    const rows: TokenAccountRow[] = [];
    let cursor: string | undefined;
    let slot: number | undefined;
    let complete = false;
    for (let page = 0; page < this.maxPages; page++) {
      const response = await this.fetchText(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `stonkfolio-holders-${page}`,
          method: "getTokenAccounts",
          params: { mint: mint.toBase58(), limit: this.pageSize, ...(cursor ? { cursor } : {}), options: { showZeroBalance: false } },
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`getTokenAccounts HTTP ${response.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text.replace(/"amount"\s*:\s*(\d+)/g, '"amount":"$1"'));
      if (body.error) throw new Error(`getTokenAccounts error: ${JSON.stringify(body.error)}`);
      const result = body.result ?? {};
      if (typeof result.last_indexed_slot === "number") {
        slot = slot === undefined ? result.last_indexed_slot : Math.min(slot, result.last_indexed_slot);
      }
      const accounts: { address: string; owner: string; amount: string }[] = result.token_accounts ?? [];
      for (const account of accounts) rows.push({ address: account.address, owner: account.owner, amount: BigInt(account.amount) });
      if (!result.cursor || accounts.length === 0) {
        complete = true;
        break;
      }
      cursor = result.cursor;
    }
    // A truncated holder list would silently drop holders from the round.
    if (!complete) throw new Error(`getTokenAccounts returned more than ${this.maxPages} pages`);
    if (slot === undefined) throw new Error("getTokenAccounts returned no last_indexed_slot");
    return { slot, accounts: finalizeRows(rows) };
  }
}
