import * as fs from "fs";
import * as path from "path";

/** A deployment file records the addresses a cluster's launchpad uses. */
export interface Deployment {
  cluster: string;
  /** The keeper key: fee claimer, pool creator, and distributor root authority. */
  feeClaimer: string;
  /** Fee tier in bps → DBC config address. */
  feeTierConfigs: Record<string, string>;
  pools: { name: string; symbol: string; feeBps: number; pool: string; baseMint: string }[];
}

export function readDeployment(file: string): Deployment | undefined {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as Deployment) : undefined;
}

export function writeDeployment(file: string, deployment: Deployment): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
}
