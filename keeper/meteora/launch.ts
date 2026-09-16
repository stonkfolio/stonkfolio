import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { sendTransaction } from "../../lib/send";
import { buildLaunchConfig } from "./launchConfig";

/** Creates one reusable DBC config for a fee tier. The keeper is fee claimer and leftover receiver. */
export async function createFeeTierConfig(
  connection: Connection,
  client: DynamicBondingCurveClient,
  payer: Keypair,
  feeClaimer: PublicKey,
  feeBps: number
): Promise<{ config: PublicKey; signature: string }> {
  const configKeypair = Keypair.generate();
  const tx = await client.partner.createConfig({
    config: configKeypair.publicKey,
    feeClaimer,
    leftoverReceiver: feeClaimer,
    quoteMint: NATIVE_MINT,
    payer: payer.publicKey,
    ...buildLaunchConfig({ feeBps }),
  });
  const signature = await sendTransaction(connection, tx, payer, [configKeypair]);
  return { config: configKeypair.publicKey, signature };
}

/**
 * A buy bundled into the launch transaction itself, so the coin's first trade
 * is the creator's and no sniper can take the opening price. `minimumAmountOut`
 * is a sanity bound on a misconfigured curve, not slippage protection: nothing
 * can trade between the pool's creation and this buy.
 */
export interface FirstBuy {
  lamports: bigint;
  minimumAmountOut: bigint;
}

export interface LaunchMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/** Launches a coin on a tier config; DBC creates the mint and its bonding-curve pool. */
export async function createLaunchPool(
  connection: Connection,
  client: DynamicBondingCurveClient,
  creator: Keypair,
  config: PublicKey,
  metadata: LaunchMetadata,
  firstBuy?: FirstBuy
): Promise<{ pool: PublicKey; baseMint: PublicKey; signature: string; bought: bigint }> {
  const baseMint = Keypair.generate();
  const createPoolParam = {
    ...metadata,
    payer: creator.publicKey,
    poolCreator: creator.publicKey,
    config,
    baseMint: baseMint.publicKey,
  };
  const tx = firstBuy
    ? await client.creator.createPoolWithFirstBuy({
        createPoolParam,
        firstBuyParam: {
          buyer: creator.publicKey,
          buyAmount: new BN(firstBuy.lamports.toString()),
          minimumAmountOut: new BN(firstBuy.minimumAmountOut.toString()),
          referralTokenAccount: null,
        },
      })
    : await client.creator.createPool(createPoolParam);
  const before = firstBuy ? await baseBalance(connection, baseMint.publicKey, creator.publicKey) : 0n;
  const signature = await sendTransaction(connection, tx, creator, [baseMint]);
  const bought = firstBuy ? (await baseBalance(connection, baseMint.publicKey, creator.publicKey)) - before : 0n;
  return { pool: deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, config), baseMint: baseMint.publicKey, signature, bought };
}

/** What the creator holds of a launch's own mint; 0 before the account exists. */
async function baseBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0n;
    throw err;
  }
}
