/**
 * Long-running migrator: once a launch's bonding curve reaches its SOL
 * threshold, DBC blocks all swaps until someone migrates the pool to DAMM v2.
 * Migration is permissionless, so this service needs no authority over the
 * pool — just a wallet with ~2 SOL to front the refundable rent.
 *
 *   STONKFOLIO_RPC_URL=… MIGRATOR_KEYPAIR=… DBC_POOLS=poolA,poolB node dist/keeper/migrator.js
 */
import * as fs from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { patchConnectionForPollingConfirmation } from "../lib/confirm";
import { migrateToDammV2, readDbcPool } from "./meteora/dbc";

export type MigrateResult =
  | { status: "migrated"; signature: string; dammPool: PublicKey }
  | { status: "curve" | "graduated" };

export async function migrateIfReady(
  connection: Connection,
  client: DynamicBondingCurveClient,
  payer: Keypair,
  pool: PublicKey
): Promise<MigrateResult> {
  const view = await readDbcPool(client, pool);
  if (view.phase === "CURVE") return { status: "curve" };
  if (view.phase === "GRADUATED") return { status: "graduated" };
  return { status: "migrated", ...(await migrateToDammV2(connection, client, payer, pool)) };
}

async function main(): Promise<void> {
  const rpc = process.env.STONKFOLIO_RPC_URL;
  const keypairPath = process.env.MIGRATOR_KEYPAIR;
  const pools = (process.env.DBC_POOLS ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => new PublicKey(p));
  const pollMs = Number(process.env.MIGRATOR_POLL_MS ?? 5_000);
  if (!rpc || !keypairPath || pools.length === 0) {
    throw new Error("set STONKFOLIO_RPC_URL, MIGRATOR_KEYPAIR and DBC_POOLS");
  }
  const connection = new Connection(rpc, "confirmed");
  patchConnectionForPollingConfirmation(connection);
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const pending = new Set(pools.map((p) => p.toBase58()));

  console.log(`[migrator] watching ${pending.size} pool(s) every ${pollMs}ms`);
  while (pending.size > 0) {
    for (const address of [...pending]) {
      try {
        const result = await migrateIfReady(connection, client, payer, new PublicKey(address));
        if (result.status === "migrated") {
          console.log(`[migrator] migrated ${address} → DAMM v2 ${result.dammPool.toBase58()} (${result.signature})`);
          pending.delete(address);
        } else if (result.status === "graduated") {
          console.log(`[migrator] ${address} already graduated`);
          pending.delete(address);
        }
      } catch (err) {
        // Someone else may have migrated first, or the RPC hiccuped; the next poll re-reads state.
        console.warn(`[migrator] ${address}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  console.log("[migrator] every watched pool has graduated");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
