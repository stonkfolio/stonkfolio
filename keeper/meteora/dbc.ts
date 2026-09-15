/** Bonding-curve side of a launch: reading state, trading, claiming fees, migrating. */
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  SwapQuoteResult,
  deriveDammV2PoolAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { OnSigned, sendTransaction } from "../../lib/send";
import { currentPoint } from "./point";
import { PoolPhase } from "../liquidity";

export const DAMM_V2_CUSTOMIZABLE_CONFIG = DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.Customizable];

const big = (value: BN) => BigInt(value.toString());
const bn = (value: bigint) => new BN(value.toString());

export interface DbcPoolView {
  pool: PublicKey;
  config: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  quoteReserve: bigint;
  migrationQuoteThreshold: bigint;
  partnerQuoteFee: bigint;
  partnerBaseFee: bigint;
  protocolQuoteFee: bigint;
  isMigrated: boolean;
  partnerSurplusWithdrawn: boolean;
  phase: PoolPhase;
}

export function phaseOf(isMigrated: boolean, quoteReserve: bigint, migrationQuoteThreshold: bigint): PoolPhase {
  if (isMigrated) return "GRADUATED";
  return quoteReserve >= migrationQuoteThreshold ? "AWAITING_MIGRATION" : "CURVE";
}

export async function readDbcPool(client: DynamicBondingCurveClient, pool: PublicKey): Promise<DbcPoolView> {
  const virtualPool = await client.state.getPool(pool);
  if (!virtualPool) throw new Error(`DBC pool ${pool.toBase58()} not found`);
  const state = virtualPool.poolState;
  const config = await client.state.getPoolConfig(state.config);
  if (!config) throw new Error(`DBC config ${state.config.toBase58()} not found`);
  const quoteReserve = big(state.quoteReserve);
  const migrationQuoteThreshold = big(config.migrationQuoteThreshold);
  const isMigrated = state.isMigrated !== 0;
  return {
    pool,
    config: state.config,
    baseMint: state.baseMint,
    quoteMint: config.quoteMint,
    quoteReserve,
    migrationQuoteThreshold,
    partnerQuoteFee: big(state.partnerQuoteFee),
    partnerBaseFee: big(state.partnerBaseFee),
    protocolQuoteFee: big(state.protocolQuoteFee),
    isMigrated,
    partnerSurplusWithdrawn: state.isPartnerWithdrawSurplus !== 0,
    phase: phaseOf(isMigrated, quoteReserve, migrationQuoteThreshold),
  };
}

/** Exact-in swap on the curve. `swapBaseForQuote` true sells the coin for SOL. */
export async function curveSwap(
  connection: Connection,
  client: DynamicBondingCurveClient,
  owner: Keypair,
  pool: PublicKey,
  amountIn: bigint,
  swapBaseForQuote: boolean,
  slippageBps: number,
  onSigned?: OnSigned
): Promise<{ signature: string; quote: SwapQuoteResult }> {
  const virtualPool = await client.state.getPool(pool);
  if (!virtualPool) throw new Error(`DBC pool ${pool.toBase58()} not found`);
  const config = await client.state.getPoolConfig(virtualPool.poolState.config);
  if (!config) throw new Error(`DBC config ${virtualPool.poolState.config.toBase58()} not found`);
  const quote = client.pool.swapQuote({
    virtualPool,
    config,
    swapBaseForQuote,
    amountIn: bn(amountIn),
    slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: await currentPoint(connection, config.activationType),
  });
  const tx = await client.pool.swap({
    owner: owner.publicKey,
    pool,
    amountIn: bn(amountIn),
    minimumAmountOut: quote.minimumAmountOut,
    swapBaseForQuote,
    referralTokenAccount: null,
  });
  return { signature: await sendTransaction(connection, tx, owner, [], undefined, onSigned), quote };
}

/**
 * Claims the partner's accrued curve fees to the fee claimer, unwrapped to
 * SOL. The claim is capped at the amount read beforehand, so exactly that
 * much is received even if more fees accrue while it lands.
 */
export async function claimCurveFees(
  connection: Connection,
  client: DynamicBondingCurveClient,
  feeClaimer: Keypair,
  pool: PublicKey,
  /** Also given the amount being claimed, so a caller can journal it. */
  onSigned?: (signature: string, lastValidBlockHeight: number, claimedLamports: bigint) => void
): Promise<{ signature?: string; claimedLamports: bigint }> {
  const view = await readDbcPool(client, pool);
  if (view.partnerQuoteFee === 0n && view.partnerBaseFee === 0n) return { claimedLamports: 0n };
  const tx = await client.partner.claimPartnerTradingFee({
    feeClaimer: feeClaimer.publicKey,
    payer: feeClaimer.publicKey,
    pool,
    maxBaseAmount: bn(view.partnerBaseFee),
    maxQuoteAmount: bn(view.partnerQuoteFee),
  });
  const signature = await sendTransaction(
    connection,
    tx,
    feeClaimer,
    [],
    undefined,
    onSigned && ((sig, height) => onSigned(sig, height, view.partnerQuoteFee))
  );
  return { signature, claimedLamports: view.partnerQuoteFee };
}

/** Permissionless migration to DAMM v2; `payer` fronts about 1 SOL of rent that is refunded. */
export async function migrateToDammV2(
  connection: Connection,
  client: DynamicBondingCurveClient,
  payer: Keypair,
  pool: PublicKey
): Promise<{ signature: string; dammPool: PublicKey }> {
  const view = await readDbcPool(client, pool);
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({
    payer: payer.publicKey,
    pool,
    dammConfig: DAMM_V2_CUSTOMIZABLE_CONFIG,
  });
  const signature = await sendTransaction(connection, transaction, payer, [firstPositionNftKeypair, secondPositionNftKeypair]);
  return { signature, dammPool: deriveDammV2PoolAddress(DAMM_V2_CUSTOMIZABLE_CONFIG, view.baseMint, view.quoteMint) };
}
