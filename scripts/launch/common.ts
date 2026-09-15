import * as fs from "fs";
import { Connection, Keypair } from "@solana/web3.js";
import { patchConnectionForPollingConfirmation } from "../../lib/confirm";

export function parseArgs(argv: string[] = process.argv.slice(2)): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    args.set(flag.slice(2), value);
    i++;
  }
  return args;
}

export function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

export function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf-8"))));
}

export function connect(rpc: string): Connection {
  const connection = new Connection(rpc, "confirmed");
  patchConnectionForPollingConfirmation(connection);
  return connection;
}

export type { Deployment } from "../../lib/deployment";
export { readDeployment, writeDeployment } from "../../lib/deployment";

export function run(main: () => Promise<void>): void {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
