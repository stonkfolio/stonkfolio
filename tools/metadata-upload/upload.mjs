// Uploads a coin's logo, then its metadata JSON pointing at that logo, through
// Irys (paid in SOL). The coin's metadata can never change after launch, so the
// script reads both uploads back and checks them before printing the URI.
//
//   node upload.mjs --network devnet|mainnet --rpc <url> --keypair <payer.json> \
//     --metadata folio.json --image ../../LOGO.png --out <dir> [--yes]
//
// Without --yes it only prints the price. Nothing secret is printed.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Uploader } from "@irys/upload";
import { Solana } from "@irys/upload-solana";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(arg.slice(2), true);
  else args.set(arg.slice(2), process.argv[++i]);
}
const required = (name) => {
  const value = args.get(name);
  if (typeof value !== "string") throw new Error(`--${name} is required`);
  return value;
};

const network = required("network");
if (network !== "devnet" && network !== "mainnet") throw new Error("--network must be devnet or mainnet");
const rpc = required("rpc");
const imagePath = required("image");
const outDir = required("out");
const fields = JSON.parse(fs.readFileSync(required("metadata"), "utf-8"));
for (const key of ["name", "symbol", "description"]) {
  if (typeof fields[key] !== "string" || !fields[key]) throw new Error(`metadata file needs a ${key}`);
}
// Metaplex limits: name 32 bytes, symbol 10 bytes (checked again on-chain by DBC).
if (Buffer.byteLength(fields.name) > 32 || Buffer.byteLength(fields.symbol) > 10) throw new Error("name or symbol too long");
const image = fs.readFileSync(imagePath);
if (image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${imagePath} is not a PNG`);

const secretKey = JSON.parse(fs.readFileSync(required("keypair"), "utf-8"));
let builder = Uploader(Solana).withWallet(secretKey).withRpc(rpc);
if (network === "devnet") builder = builder.devnet();
const irys = await builder;

const gateway = network === "devnet" ? "https://devnet.irys.xyz" : "https://gateway.irys.xyz";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const toSol = (atomic) => irys.utils.fromAtomic(atomic).toString();

// The metadata JSON is small; price it generously so one funding covers both uploads.
const totalBytes = image.length + 4096;
const price = await irys.getPrice(totalBytes);
const balance = await irys.getBalance();
console.log(`network ${network}, payer ${irys.address}`);
console.log(`price for ${totalBytes} bytes: ${toSol(price)} SOL; already on the Irys node: ${toSol(balance)} SOL`);
if (args.get("yes") !== true) {
  console.log("price check only; re-run with --yes to fund and upload");
  process.exit(0);
}

if (balance.lt(price)) {
  const amount = price.minus(balance).multipliedBy(1.1).integerValue();
  console.log(`funding the Irys node with ${toSol(amount)} SOL`);
  await irys.fund(amount);
}

async function uploadAndCheck(bytes, contentType, label) {
  const receipt = await irys.upload(bytes, { tags: [{ name: "Content-Type", value: contentType }] });
  const uri = `${gateway}/${receipt.id}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(uri);
      if (response.ok) {
        const served = Buffer.from(await response.arrayBuffer());
        if (sha256(served) !== sha256(bytes)) throw new Error(`${label} at ${uri} doesn't match what was uploaded`);
        console.log(`${label}: ${uri} (checked, sha256 ${sha256(bytes)})`);
        return { id: receipt.id, uri };
      }
    } catch (error) {
      if (String(error.message).includes("doesn't match")) throw error;
    }
    if (attempt >= 30) throw new Error(`${label} at ${uri} still isn't served after ${attempt} tries`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

fs.mkdirSync(outDir, { recursive: true });
const logo = await uploadAndCheck(image, "image/png", "logo");
const metadata = {
  name: fields.name,
  symbol: fields.symbol,
  description: fields.description,
  image: logo.uri,
  properties: { files: [{ uri: logo.uri, type: "image/png" }], category: "image" },
};
const metadataBytes = Buffer.from(JSON.stringify(metadata, null, 2) + "\n");
const json = await uploadAndCheck(metadataBytes, "application/json", "metadata");
fs.writeFileSync(path.join(outDir, "metadata.json"), metadataBytes);
fs.writeFileSync(
  path.join(outDir, "upload-receipt.json"),
  JSON.stringify({ network, payer: irys.address, logo, metadata: json, logoSha256: sha256(image), metadataSha256: sha256(metadataBytes) }, null, 2) + "\n",
);
console.log(`\nmetadata URI (use as --uri for create-pool): ${json.uri}`);
