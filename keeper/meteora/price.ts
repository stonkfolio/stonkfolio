/** Index-coin price for the $50 check, read from whichever pool the coin currently trades in. */
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { DynamicBondingCurveClient, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { PriceSource } from "../round/engine";
import { Rational } from "../round/types";
import { DAMM_V2_CUSTOMIZABLE_CONFIG } from "./dbc";

const Q128 = 1n << 128n;

/** Both DBC and DAMM v2 store sqrt(price) as Q64.64; price = sqrtPrice² / 2^128 (quote raw per base raw). */
export function sqrtPriceToRational(sqrtPrice: BN | bigint): Rational {
  const s = BigInt(sqrtPrice.toString());
  return { num: s * s, den: Q128 };
}

export class LaunchPriceSource implements PriceSource {
  constructor(
    private readonly dbc: DynamicBondingCurveClient,
    private readonly cpAmm: CpAmm,
    private readonly pool: PublicKey
  ) {}

  /** Lamports per raw index-coin unit. */
  async poolPrice(): Promise<Rational> {
    const virtualPool = await this.dbc.state.getPool(this.pool);
    if (!virtualPool) throw new Error(`DBC pool ${this.pool.toBase58()} not found`);
    const state = virtualPool.poolState;
    if (state.isMigrated === 0) return sqrtPriceToRational(state.sqrtPrice);

    const config = await this.dbc.state.getPoolConfig(state.config);
    if (!config) throw new Error(`DBC config ${state.config.toBase58()} not found`);
    const damm = await this.cpAmm.fetchPoolState(deriveDammV2PoolAddress(DAMM_V2_CUSTOMIZABLE_CONFIG, state.baseMint, config.quoteMint));
    const price = sqrtPriceToRational(damm.sqrtPrice); // token B per token A
    return damm.tokenBMint.equals(NATIVE_MINT) ? price : { num: price.den, den: price.num };
  }
}
