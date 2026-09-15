/**
 * Watches the Meteora pieces a launch depends on but nobody here controls:
 * the DBC and DAMM v2 programs (upgradeable by Meteora) and the DAMM v2
 * migration config. Compares them to deployments/meteora-programs.json, the
 * pin recorded when the fork lifecycle test last passed. It only reports;
 * the keeper has no power to respond, and holders should be told.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";

export interface PinnedProgram {
  programId: string;
  sha256: string;
  lastDeployedSlot: number;
  upgradeAuthority?: string | null;
}

export interface PinnedAccount {
  address: string;
  sha256: string;
}

export type MeteoraPin = Record<string, PinnedProgram | PinnedAccount>;

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** An upgradeable program account holds its programdata address; programdata starts with the deploy slot and authority. */
export function parseProgramAccount(data: Buffer): PublicKey {
  if (data.length < 36 || data.readUInt32LE(0) !== 2) throw new Error("not an upgradeable program account");
  return new PublicKey(data.subarray(4, 36));
}

export function parseProgramData(data: Buffer): { slot: number; upgradeAuthority: string | null } {
  if (data.length < 45 || data.readUInt32LE(0) !== 3) throw new Error("not a programdata account");
  return {
    slot: Number(data.readBigUInt64LE(4)),
    upgradeAuthority: data[12] === 1 ? new PublicKey(data.subarray(13, 45)).toBase58() : null,
  };
}

/** Everything that differs from the pin; empty when nothing moved. */
export async function checkMeteora(connection: Connection, pin: MeteoraPin): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(pin)) {
    if ("programId" in entry) {
      const program = await connection.getAccountInfo(new PublicKey(entry.programId), "confirmed");
      if (!program || !program.owner.equals(UPGRADEABLE_LOADER)) {
        problems.push(`${name} (${entry.programId}) is no longer an upgradeable program account`);
        continue;
      }
      const programData = await connection.getAccountInfo(parseProgramAccount(program.data), "confirmed");
      if (!programData) {
        problems.push(`${name} (${entry.programId}) has no programdata account`);
        continue;
      }
      const { slot, upgradeAuthority } = parseProgramData(programData.data);
      if (slot !== entry.lastDeployedSlot) {
        problems.push(`${name} (${entry.programId}) was redeployed at slot ${slot}; pinned binary was deployed at ${entry.lastDeployedSlot}`);
      }
      if (entry.upgradeAuthority !== undefined && upgradeAuthority !== entry.upgradeAuthority) {
        problems.push(`${name} (${entry.programId}) upgrade authority changed from ${entry.upgradeAuthority} to ${upgradeAuthority}`);
      }
    } else {
      const account = await connection.getAccountInfo(new PublicKey(entry.address), "confirmed");
      const hash = account ? createHash("sha256").update(account.data).digest("hex") : "missing";
      if (hash !== entry.sha256) problems.push(`${name} (${entry.address}) changed: data hash ${hash}, pinned ${entry.sha256}`);
    }
  }
  return problems;
}

export function readMeteoraPin(file: string): MeteoraPin {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as MeteoraPin;
}
