/**
 * Records a real StonkFun fee-claim transaction and the on-chain accounts it
 * reads, so tests/raydiumClaim.ts can check our own instruction builder against
 * it offline. Re-run only to refresh the fixture.
 *
 *   node scripts/raydium/capture-claim-fixture.mjs [mint] [creator]
 */
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import fs from "fs";

const API = "https://www.stonkfun.xyz/api/public/v1";
const MINT = process.argv[2] ?? "3Sv4Jriwo2V7c1wturGVrrpfKc9XbGxewnDHpMLrpbWQ"; // INDEX
const CREATOR = process.argv[3] ?? "4arR3ifTp6Ksfj9i4otH4R8APuF8zUWqSE1tgoRK7C5c";
const LOCK_PROGRAM = "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE";
const connection = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");

const response = await fetch(`${API}/tokens/${MINT}/fees/claim/prepare`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ creatorWallet: CREATOR }),
});
const body = await response.json();
if (!response.ok) throw new Error(`prepare ${response.status}: ${JSON.stringify(body)}`);
const raw = Buffer.from(body.data.transaction, "base64");

let instructions;
try {
  const tx = VersionedTransaction.deserialize(raw);
  const keys = tx.message.staticAccountKeys;
  instructions = tx.message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex].toBase58(),
    accounts: ix.accountKeyIndexes.map((i) => ({ pubkey: keys[i].toBase58(), isSigner: tx.message.isAccountSigner(i), isWritable: tx.message.isAccountWritable(i) })),
    data: Buffer.from(ix.data).toString("base64"),
  }));
} catch {
  const tx = Transaction.from(raw);
  instructions = tx.instructions.map((ix) => ({
    programId: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: ix.data.toString("base64"),
  }));
}
const claim = instructions.find((ix) => ix.programId === LOCK_PROGRAM);
if (!claim) throw new Error("no lock-program instruction in the prepared transaction");

// The accounts our builder has to read to reproduce that instruction.
const lockedPosition = claim.accounts[3].pubkey;
const poolState = claim.accounts[7].pubkey;
const personalPosition = claim.accounts[6].pubkey;
const [lockedInfo, poolInfo, positionInfo] = await connection.getMultipleAccountsInfo(
  [lockedPosition, poolState, personalPosition].map((k) => new PublicKey(k))
);
const fixture = {
  capturedAt: new Date().toISOString(),
  source: `${API}/tokens/${MINT}/fees/claim/prepare`,
  mint: MINT,
  feeNftOwner: CREATOR,
  claim,
  accounts: {
    [lockedPosition]: lockedInfo.data.toString("base64"),
    [poolState]: poolInfo.data.toString("base64"),
    [personalPosition]: positionInfo.data.toString("base64"),
  },
};
fs.writeFileSync("tests/fixtures/stonkfun-claim.json", JSON.stringify(fixture, null, 2) + "\n");
console.log(`saved tests/fixtures/stonkfun-claim.json: ${claim.accounts.length} accounts, data ${Buffer.from(claim.data, "base64").toString("hex")}`);
