/**
 * Claims your own unpaid Stonkfolio payouts from a published round bundle —
 * for when the keeper's push couldn't land (for example, your token account
 * requires memos or is frozen).
 *
 *   node dist/scripts/self-claim.js --rpc <url> --bundle <round bundle dir> --keypair <your wallet.json> [--fresh-accounts true]
 *
 * By default payouts go to your associated token accounts. With
 * `--fresh-accounts true`, a new token account you own is created for each
 * coin instead, which sidesteps a memo-required or frozen ATA.
 */
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction,
  getAccountLenForMint,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { readArtifacts } from "../lib/artifacts";
import { sendTransaction } from "../lib/send";
import { DistributorClient, isLeafClaimed } from "../keeper/distributor/client";
import { parseRoundInputs, prepareRound } from "../keeper/round/prepare";
import { connect, loadKeypair, parseArgs, required, run } from "./launch/common";

run(async () => {
  const args = parseArgs();
  const connection = connect(required(args, "rpc"));
  const recipient = loadKeypair(required(args, "keypair"));
  const freshAccounts = args.get("fresh-accounts") === "true";

  const { files } = readArtifacts(required(args, "bundle"));
  const inputs = parseRoundInputs(files.get("inputs.json")!);
  const prepared = prepareRound(inputs);
  const client = new DistributorClient(connection, recipient, new PublicKey(inputs.distributor));

  let claimed = 0;
  for (const asset of prepared.trees.assets) {
    const leaf = prepared.allocation.assets[asset.assetIdx].leaves.find((l) => l.recipient === recipient.publicKey.toBase58());
    if (!leaf) continue;
    const account = await client.fetchRoundAsset(inputs.roundId, asset.assetIdx);
    if (!account || isLeafClaimed(Buffer.from(account.bitmap), leaf.leafIdx)) {
      console.log(`${asset.mint.toBase58()}: nothing to claim`);
      continue;
    }

    const setup = [];
    const signers: Keypair[] = [];
    let destination: PublicKey;
    if (freshAccounts) {
      const tokenAccount = Keypair.generate();
      const mint = await getMint(connection, asset.mint, "confirmed", asset.tokenProgram);
      const space = getAccountLenForMint(mint);
      setup.push(
        SystemProgram.createAccount({
          fromPubkey: recipient.publicKey,
          newAccountPubkey: tokenAccount.publicKey,
          space,
          lamports: await connection.getMinimumBalanceForRentExemption(space),
          programId: asset.tokenProgram,
        }),
        createInitializeAccount3Instruction(tokenAccount.publicKey, asset.mint, recipient.publicKey, asset.tokenProgram)
      );
      signers.push(tokenAccount);
      destination = tokenAccount.publicKey;
    } else {
      destination = getAssociatedTokenAddressSync(asset.mint, recipient.publicKey, false, asset.tokenProgram);
      setup.push(createAssociatedTokenAccountIdempotentInstruction(recipient.publicKey, destination, recipient.publicKey, asset.mint, asset.tokenProgram));
    }
    const claim = await client.selfClaimInstruction(inputs.roundId, asset, leaf, destination);
    const signature = await sendTransaction(connection, [...setup, claim], recipient, signers);
    console.log(`${asset.mint.toBase58()}: claimed ${leaf.amount} into ${destination.toBase58()} (${signature})`);
    claimed++;
  }
  console.log(claimed === 0 ? "no unpaid payouts for this wallet" : `claimed ${claimed} payout(s)`);
});
