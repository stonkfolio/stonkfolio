/**
 * Our fee-claim instruction must be the one Raydium's lock program expects.
 * The check is a real transaction StonkFun's API prepared for a live launch
 * (tests/fixtures/stonkfun-claim.json, captured by
 * scripts/raydium/capture-claim-fixture.mjs): we rebuild it from the same
 * on-chain accounts and compare account by account.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import {
  decodeClmmPool,
  decodeClmmPosition,
  personalPositionAddress,
  protocolPositionAddress,
  tickArrayAddress,
  tickArrayBitmapExtensionAddress,
  tickArrayStartIndex,
} from "../keeper/raydium/clmm";
import { COLLECT_CLMM_FEES_AND_REWARDS, collectFeesAccountMetas, decodeLockedPosition } from "../keeper/raydium/lock";

interface Fixture {
  feeNftOwner: string;
  claim: { programId: string; data: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };
  accounts: Record<string, string>;
}

const fixture: Fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "tests", "fixtures", "stonkfun-claim.json"), "utf-8")
);
const account = (address: string) => Buffer.from(fixture.accounts[address], "base64");

describe("StonkFun fee claim", () => {
  const theirs = fixture.claim.accounts;
  const lockedAddress = new PublicKey(theirs[3].pubkey);
  const poolAddress = new PublicKey(theirs[7].pubkey);
  const positionAddress = new PublicKey(theirs[6].pubkey);
  const locked = decodeLockedPosition(lockedAddress, account(theirs[3].pubkey));
  const pool = decodeClmmPool(poolAddress, account(theirs[7].pubkey));
  const position = decodeClmmPosition(positionAddress, account(theirs[6].pubkey));

  it("reads the locked position the same way the program wrote it", () => {
    expect(locked.poolId.toBase58()).to.equal(poolAddress.toBase58());
    expect(locked.positionId.toBase58()).to.equal(positionAddress.toBase58());
    expect(locked.lockedNftAccount.toBase58()).to.equal(theirs[5].pubkey);
    expect(position.poolId.toBase58()).to.equal(poolAddress.toBase58());
    // The position account is the PDA of its own NFT mint.
    expect(personalPositionAddress(position.nftMint).toBase58()).to.equal(positionAddress.toBase58());
  });

  it("derives the protocol position, tick arrays and bitmap extension the program is handed", () => {
    expect(protocolPositionAddress(poolAddress, position.tickLowerIndex, position.tickUpperIndex).toBase58()).to.equal(theirs[8].pubkey);
    expect(tickArrayAddress(poolAddress, tickArrayStartIndex(position.tickLowerIndex, pool.tickSpacing)).toBase58()).to.equal(theirs[11].pubkey);
    expect(tickArrayAddress(poolAddress, tickArrayStartIndex(position.tickUpperIndex, pool.tickSpacing)).toBase58()).to.equal(theirs[12].pubkey);
    expect(tickArrayBitmapExtensionAddress(poolAddress).toBase58()).to.equal(theirs[20].pubkey);
  });

  it("builds the same instruction StonkFun's API prepares", () => {
    expect(COLLECT_CLMM_FEES_AND_REWARDS.toString("base64")).to.equal(fixture.claim.data);
    const ours = collectFeesAccountMetas({
      locked,
      pool,
      position,
      feeNftAccount: new PublicKey(theirs[2].pubkey),
      feeNftOwner: new PublicKey(fixture.feeNftOwner),
      // Where the two sides are paid is the caller's choice; keep theirs so the rest compares.
      recipientToken0: new PublicKey(theirs[13].pubkey),
      recipientToken1: new PublicKey(theirs[14].pubkey),
      tickArrayBitmapExtension: new PublicKey(theirs[20].pubkey),
    });
    expect(ours.length).to.equal(theirs.length);
    ours.forEach((meta, i) => {
      expect(`${i} ${meta.pubkey.toBase58()} ${meta.isSigner ? "S" : "-"}${meta.isWritable ? "W" : "-"}`).to.equal(
        `${i} ${theirs[i].pubkey} ${theirs[i].isSigner ? "S" : "-"}${theirs[i].isWritable ? "W" : "-"}`
      );
    });
  });

  it("refuses to build a claim for a position that isn't in the pool", () => {
    const otherPool = { ...pool, address: PublicKey.default };
    expect(() =>
      collectFeesAccountMetas({
        locked,
        pool: otherPool,
        position,
        feeNftAccount: new PublicKey(theirs[2].pubkey),
        feeNftOwner: new PublicKey(fixture.feeNftOwner),
        recipientToken0: new PublicKey(theirs[13].pubkey),
        recipientToken1: new PublicKey(theirs[14].pubkey),
      })
    ).to.throw(/not in this pool/);
  });
});
