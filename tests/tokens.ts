import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { vetMintData } from "../lib/tokens";

interface Ext {
  type: number;
  value: Buffer;
}

function mintData(opts: { freeze?: boolean; extensions?: Ext[] } = {}): Buffer {
  const base = Buffer.alloc(82);
  base[45] = 1;
  if (opts.freeze) base.writeUInt32LE(1, 46);
  if (!opts.extensions?.length) return base;
  const padded = Buffer.alloc(166);
  base.copy(padded);
  padded[165] = 1;
  const tlv = opts.extensions.map((e) => {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(e.type, 0);
    header.writeUInt16LE(e.value.length, 2);
    return Buffer.concat([header, e.value]);
  });
  return Buffer.concat([padded, ...tlv]);
}

function transferFee(bps: number): Ext {
  const value = Buffer.alloc(108);
  value.writeUInt16LE(bps, 88);
  value.writeUInt16LE(bps, 106);
  return { type: 1, value };
}

const opts = { allowFreezeAuthority: false, maxTransferFeeBps: 300 };

describe("vetMintData", () => {
  it("accepts plain mints from either token program", () => {
    expect(vetMintData(mintData(), TOKEN_PROGRAM_ID, opts)).to.deep.equal({ ok: true });
    expect(vetMintData(mintData(), TOKEN_2022_PROGRAM_ID, opts)).to.deep.equal({ ok: true });
  });

  it("rejects non-token owners and uninitialized mints", () => {
    expect(vetMintData(mintData(), Keypair.generate().publicKey, opts).ok).to.be.false;
    const uninitialized = mintData();
    uninitialized[45] = 0;
    expect(vetMintData(uninitialized, TOKEN_PROGRAM_ID, opts).ok).to.be.false;
  });

  it("rejects a freeze authority unless allowed", () => {
    expect(vetMintData(mintData({ freeze: true }), TOKEN_PROGRAM_ID, opts)).to.deep.equal({ ok: false, reason: "has a freeze authority" });
    expect(vetMintData(mintData({ freeze: true }), TOKEN_PROGRAM_ID, { ...opts, allowFreezeAuthority: true }).ok).to.be.true;
  });

  it("allows metadata and inert extensions, rejects dangerous and unknown ones", () => {
    const ok = (ext: Ext) => vetMintData(mintData({ extensions: [ext] }), TOKEN_2022_PROGRAM_ID, opts).ok;
    expect(ok({ type: 18, value: Buffer.alloc(64) }), "metadata pointer").to.be.true;
    expect(ok({ type: 12, value: Buffer.alloc(32, 1) }), "permanent delegate").to.be.false;
    expect(ok({ type: 9, value: Buffer.alloc(0) }), "non-transferable").to.be.false;
    expect(ok({ type: 4, value: Buffer.alloc(65) }), "confidential transfer").to.be.false;
    expect(ok({ type: 26, value: Buffer.alloc(33) }), "pausable (unknown to the pinned library)").to.be.false;
    expect(ok({ type: 6, value: Buffer.from([2]) }), "default frozen").to.be.false;
    expect(ok({ type: 6, value: Buffer.from([1]) }), "default initialized").to.be.true;
    expect(ok({ type: 14, value: Buffer.concat([Buffer.alloc(32), Buffer.alloc(32, 2)]) }), "active hook").to.be.false;
    expect(ok({ type: 14, value: Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32)]) }), "hook authority could add a program later").to.be.false;
    expect(ok({ type: 14, value: Buffer.alloc(64) }), "hook with no authority or program").to.be.true;
    expect(ok({ type: 3, value: Buffer.alloc(32, 1) }), "close authority").to.be.false;
    expect(ok({ type: 3, value: Buffer.alloc(32) }), "no close authority").to.be.true;
  });

  it("caps the current and scheduled transfer fee, and accepts a fee authority like StonkFun's reward coins keep", () => {
    expect(vetMintData(mintData({ extensions: [transferFee(300)] }), TOKEN_2022_PROGRAM_ID, opts).ok).to.be.true;
    expect(vetMintData(mintData({ extensions: [transferFee(301)] }), TOKEN_2022_PROGRAM_ID, opts)).to.deep.equal({
      ok: false,
      reason: "transfer fee 301 bps exceeds 300",
    });
    const withAuthority = transferFee(300);
    withAuthority.value.fill(1, 0, 32);
    expect(vetMintData(mintData({ extensions: [withAuthority] }), TOKEN_2022_PROGRAM_ID, opts)).to.deep.equal({ ok: true });
    // 1% now, 4% already scheduled: the scheduled fee counts
    const scheduled = transferFee(100);
    scheduled.value.writeUInt16LE(400, 106);
    expect(vetMintData(mintData({ extensions: [scheduled] }), TOKEN_2022_PROGRAM_ID, opts).ok).to.be.false;
  });

  it("rejects extension data on legacy mints and truncated TLV", () => {
    expect(vetMintData(mintData({ extensions: [{ type: 18, value: Buffer.alloc(64) }] }), TOKEN_PROGRAM_ID, opts).ok).to.be.false;
    const truncated = mintData({ extensions: [{ type: 18, value: Buffer.alloc(64) }] }).subarray(0, 180);
    expect(vetMintData(truncated, TOKEN_2022_PROGRAM_ID, opts).ok).to.be.false;
  });
});
