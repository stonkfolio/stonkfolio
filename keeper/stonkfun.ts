import { FETCH_TIMEOUT_MS, STONKFUN_API_BASE } from "./config";

/**
 * Confirmed against a live `GET /tokens` call (2026-09-13) — the response is
 * wrapped in `{data: {...}}`, and market figures live under `market`, not on
 * the token object directly. `market.liquidityUsd` is absent on most
 * graduated tokens in practice (present on roughly 1 in 5 in a live sample)
 * — treat it as a best-effort signal, not a required field. See
 * `getTopGraduatedTokens`'s doc comment for how that absence is handled.
 */
export interface StonkfunToken {
  mint: string;
  symbol: string;
  name: string;
  launchpad: string;
  mode: "standard" | "reward";
  /** The token this one trades against — often SOL, but StonkFun also
   * supports xStocks/PreStocks/other custom quote mints (e.g. a token
   * quoted against an xStock, not SOL directly). A basket candidate quoted
   * against something exotic may route through more hops on Jupiter and
   * show higher price impact for that reason alone, not because it's thin. */
  quote: { mint: string; symbol: string };
  status: "new" | "aboutToGraduate" | "graduated";
  market: {
    priceUsd: number;
    marketCapUsd: number;
    volume24hUsd: number;
    /** Frequently absent — see interface doc comment. */
    liquidityUsd?: number;
  };
}

interface TokensResponse {
  data: {
    tokens: StonkfunToken[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

/**
 * Only `status=graduated` tokens are considered. Graduation itself is a
 * meaningful liquidity signal on a bonding-curve platform — migrating from
 * curve to a real AMM pool requires the curve to have accumulated enough to
 * seed one — which matters because `market.liquidityUsd` (the more direct
 * signal) is absent on most tokens in practice. Where it IS present,
 * `growBasket` still enforces MIN_QUOTE_LIQUIDITY_USD as an extra check; the
 * real binding safety control either way is the price-impact check
 * `buyBasketAndDeposit` runs against a live Jupiter quote right before
 * spending anything — that measures actual on-chain depth at trade time
 * instead of trusting a possibly-stale or absent API figure.
 */
export async function getTopGraduatedTokens(limit: number): Promise<StonkfunToken[]> {
  const url = new URL(`${STONKFUN_API_BASE}/tokens`);
  url.searchParams.set("sort", "marketCap");
  url.searchParams.set("status", "graduated");
  url.searchParams.set("pageSize", String(Math.min(limit, 100)));
  url.searchParams.set("page", "1");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`StonkFun API error ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as TokensResponse;
  return body.data.tokens.slice(0, limit);
}
