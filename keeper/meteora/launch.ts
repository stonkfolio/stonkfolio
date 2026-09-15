import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
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
  metadata: LaunchMetadata
): Promise<{ pool: PublicKey; baseMint: PublicKey; signature: string }> {
  const baseMint = Keypair.generate();
  const tx = await client.creator.createPool({
    ...metadata,
    payer: creator.publicKey,
    poolCreator: creator.publicKey,
    config,
    baseMint: baseMint.publicKey,
  });
  const signature = await sendTransaction(connection, tx, creator, [baseMint]);
  return { pool: deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, config), baseMint: baseMint.publicKey, signature };
}
