/** Graduated side of a launch: the DAMM v2 pool the curve migrated into. */
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getMint } from "@solana/spl-token";
import {
  CollectFeeMode,
  CpAmm,
  PoolState,
  PositionState,
  SwapMode,
  getLiquidityHandler,
  getTokenProgram,
  getUnClaimLpFee,
} from "@meteora-ag/cp-amm-sdk";
import { OnSigned, sendTransaction } from "../../lib/send";
import { currentPoint as pointNow } from "./point";

const big = (value: BN) => BigInt(value.toString());
const bn = (value: bigint) => new BN(value.toString());

export interface DammPoolView {
  pool: PublicKey;
  state: PoolState;
  /** True when token B is SOL (the migrated layout); quote-side values follow this. */
  quoteIsB: boolean;
  baseMint: PublicKey;
  tokenADecimals: number;
  tokenBDecimals: number;
  quoteDepthLamports: bigint;
  baseDepth: bigint;
}

export async function readDammPool(connection: Connection, cpAmm: CpAmm, pool: PublicKey): Promise<DammPoolView> {
  const state = await cpAmm.fetchPoolState(pool);
  const quoteIsB = state.tokenBMint.equals(NATIVE_MINT);
  if (!quoteIsB && !state.tokenAMint.equals(NATIVE_MINT)) throw new Error(`DAMM v2 pool ${pool.toBase58()} has no SOL side`);
  const [reserveA, reserveB] = getLiquidityHandler(state).getReservesAmount();
  const [mintA, mintB] = await Promise.all([
    getMint(connection, state.tokenAMint, "confirmed", getTokenProgram(state.tokenAFlag)),
    getMint(connection, state.tokenBMint, "confirmed", getTokenProgram(state.tokenBFlag)),
  ]);
  return {
    pool,
    state,
    quoteIsB,
    baseMint: quoteIsB ? state.tokenAMint : state.tokenBMint,
    tokenADecimals: mintA.decimals,
    tokenBDecimals: mintB.decimals,
    quoteDepthLamports: big(quoteIsB ? reserveB : reserveA),
    baseDepth: big(quoteIsB ? reserveA : reserveB),
  };
}

function poolAccounts(view: DammPoolView) {
  const { state } = view;
  return {
    pool: view.pool,
    tokenAMint: state.tokenAMint,
    tokenBMint: state.tokenBMint,
    tokenAVault: state.tokenAVault,
    tokenBVault: state.tokenBVault,
    tokenAProgram: getTokenProgram(state.tokenAFlag),
    tokenBProgram: getTokenProgram(state.tokenBFlag),
  };
}

export interface OwnedPosition {
  position: PublicKey;
  positionNftAccount: PublicKey;
  state: PositionState;
}

/** The owner's permanently locked position in this pool (the migrated partner position). */
export async function findLockedPosition(cpAmm: CpAmm, pool: PublicKey, owner: PublicKey): Promise<OwnedPosition> {
  const positions = await cpAmm.getUserPositionByPool(pool, owner);
  const locked = positions
    .filter((p) => !p.positionState.permanentLockedLiquidity.isZero())
    .sort((a, b) => b.positionState.permanentLockedLiquidity.cmp(a.positionState.permanentLockedLiquidity));
  if (locked.length === 0) throw new Error(`${owner.toBase58()} holds no locked position in ${pool.toBase58()}`);
  return { position: locked[0].position, positionNftAccount: locked[0].positionNftAccount, state: locked[0].positionState };
}

export function unclaimedPositionFees(view: DammPoolView, position: OwnedPosition): { quoteLamports: bigint; base: bigint } {
  const { feeTokenA, feeTokenB } = getUnClaimLpFee(view.state, position.state);
  return view.quoteIsB
    ? { quoteLamports: big(feeTokenB), base: big(feeTokenA) }
    : { quoteLamports: big(feeTokenA), base: big(feeTokenB) };
}

/** Claims a position's fees to its owner; the SOL side arrives unwrapped. */
export async function claimPositionFees(
  connection: Connection,
  cpAmm: CpAmm,
  owner: Keypair,
  view: DammPoolView,
  position: OwnedPosition,
  /** Also given the SOL being claimed, so a caller can journal it. */
  onSigned?: (signature: string, lastValidBlockHeight: number, quoteLamports: bigint) => void
): Promise<{ signature?: string; quoteLamports: bigint; base: bigint }> {
  const unclaimed = unclaimedPositionFees(view, position);
  if (unclaimed.quoteLamports === 0n && unclaimed.base === 0n) return unclaimed;
  const tx = await cpAmm.claimPositionFee2({
    ...poolAccounts(view),
    owner: owner.publicKey,
    position: position.position,
    positionNftAccount: position.positionNftAccount,
    receiver: owner.publicKey,
    feePayer: owner.publicKey,
  });
  const signature = await sendTransaction(
    connection,
    tx,
    owner,
    [],
    undefined,
    onSigned && ((sig, height) => onSigned(sig, height, unclaimed.quoteLamports))
  );
  return { signature, ...unclaimed };
}

async function currentPoint(connection: Connection, view: DammPoolView): Promise<BN> {
  return pointNow(connection, view.state.activationType);
}

/** Exact-in swap on the graduated pool. */
export async function dammSwap(
  connection: Connection,
  cpAmm: CpAmm,
  owner: Keypair,
  view: DammPoolView,
  inputMint: PublicKey,
  amountIn: bigint,
  slippageBps: number,
  onSigned?: OnSigned
): Promise<{ signature: string; minimumAmountOut: bigint }> {
  const outputMint = inputMint.equals(view.state.tokenAMint) ? view.state.tokenBMint : view.state.tokenAMint;
  const quote = cpAmm.getQuote2({
    inputTokenMint: inputMint,
    slippage: slippageBps,
    currentPoint: await currentPoint(connection, view),
    poolState: view.state,
    tokenADecimal: view.tokenADecimals,
    tokenBDecimal: view.tokenBDecimals,
    hasReferral: false,
    swapMode: SwapMode.ExactIn,
    amountIn: bn(amountIn),
  });
  if (!quote.minimumAmountOut) throw new Error("swap quote returned no minimum output");
  const tx = await cpAmm.swap({
    ...poolAccounts(view),
    payer: owner.publicKey,
    inputTokenMint: inputMint,
    outputTokenMint: outputMint,
    amountIn: bn(amountIn),
    minimumAmountOut: quote.minimumAmountOut,
    referralTokenAccount: null,
    poolState: view.state,
  });
  return {
    signature: await sendTransaction(connection, tx, owner, [], undefined, onSigned),
    minimumAmountOut: big(quote.minimumAmountOut),
  };
}

/**
 * Adds `solLamports` of liquidity to the owner's locked position and locks
 * it permanently, atomically: swap half the SOL for the coin, deposit both
 * sides, lock the new liquidity — one transaction, so the added liquidity is
 * never withdrawable. Liquidity is sized from the swap's expected output at
 * the post-swap price with the slippage margin taken off once; the deposit
 * caps (the swap's minimum output, and the other half of the SOL) make a
 * price moved beyond that margin fail the whole transaction instead of
 * filling badly. SOL the deposit doesn't use stays with the owner, and so do
 * any coins, so callers should measure the SOL spent and burn the leftovers.
 */
export async function addLiquidityAndLock(
  connection: Connection,
  cpAmm: CpAmm,
  owner: Keypair,
  view: DammPoolView,
  position: OwnedPosition,
  solLamports: bigint,
  slippageBps: number,
  onSigned?: OnSigned
): Promise<{ signature: string; liquidityDelta: BN }> {
  const { state } = view;
  const swapLamports = solLamports / 2n;
  const depositLamports = solLamports - swapLamports;
  const quote = cpAmm.getQuote2({
    inputTokenMint: NATIVE_MINT,
    slippage: slippageBps,
    currentPoint: await currentPoint(connection, view),
    poolState: state,
    tokenADecimal: view.tokenADecimals,
    tokenBDecimal: view.tokenBDecimals,
    hasReferral: false,
    swapMode: SwapMode.ExactIn,
    amountIn: bn(swapLamports),
  });
  if (!quote.minimumAmountOut) throw new Error("swap quote returned no minimum output");

  const maxBase = quote.minimumAmountOut;
  const maxQuote = bn(depositLamports);
  const [maxAmountTokenA, maxAmountTokenB] = view.quoteIsB ? [maxBase, maxQuote] : [maxQuote, maxBase];
  const [expectedTokenA, expectedTokenB] = view.quoteIsB ? [quote.outputAmount, maxQuote] : [maxQuote, quote.outputAmount];
  const fullDelta = cpAmm.getLiquidityDelta({
    maxAmountTokenA: expectedTokenA,
    maxAmountTokenB: expectedTokenB,
    sqrtPrice: quote.nextSqrtPrice,
    sqrtMinPrice: state.sqrtMinPrice,
    sqrtMaxPrice: state.sqrtMaxPrice,
    collectFeeMode: state.collectFeeMode as CollectFeeMode,
    tokenAAmount: state.tokenAAmount,
    tokenBAmount: state.tokenBAmount,
    liquidity: state.liquidity,
  });
  // One margin: the swap's minimum output is its expected output less slippageBps; 10 bps more absorbs rounding.
  const liquidityDelta = fullDelta.mul(new BN(10_000 - slippageBps - 10)).div(new BN(10_000));
  if (liquidityDelta.isZero()) throw new Error("liquidity to add rounds to zero");

  const accounts = poolAccounts(view);
  const swapTx = await cpAmm.swap({
    ...accounts,
    payer: owner.publicKey,
    inputTokenMint: NATIVE_MINT,
    outputTokenMint: view.baseMint,
    amountIn: bn(swapLamports),
    minimumAmountOut: quote.minimumAmountOut,
    referralTokenAccount: null,
    poolState: state,
  });
  const addTx = await cpAmm.addLiquidity({
    ...accounts,
    owner: owner.publicKey,
    position: position.position,
    positionNftAccount: position.positionNftAccount,
    liquidityDelta,
    maxAmountTokenA,
    maxAmountTokenB,
    tokenAAmountThreshold: maxAmountTokenA,
    tokenBAmountThreshold: maxAmountTokenB,
  });
  const lockTx = await cpAmm.permanentLockPosition({
    owner: owner.publicKey,
    position: position.position,
    positionNftAccount: position.positionNftAccount,
    pool: view.pool,
    unlockedLiquidity: position.state.unlockedLiquidity.add(liquidityDelta),
  });
  const signature = await sendTransaction(connection, [swapTx, addTx, lockTx], owner, [], 400_000, onSigned);
  return { signature, liquidityDelta };
}
