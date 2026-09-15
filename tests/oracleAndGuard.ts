import { expect } from "chai";
import {
  ComputeBudgetProgram,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { decodePriceUpdateV2, encodePriceUpdateV2, toMicroUsd, PYTH_SOL_USD_FEED_ID } from "../lib/pyth";
import { checkQuote, checkSwapTransactionShape, JUPITER_V6_PROGRAM_ID, JupiterQuote } from "../keeper/jupiter";
import { sqrtPriceToRational } from "../keeper/meteora/price";

function priceUpdate(opts: { price: bigint; expo?: number; publishTime?: number; verified?: boolean; feed?: string }): Buffer {
  const i64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    return b;
  };
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  const i32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    return b;
  };
  const publish = BigInt(opts.publishTime ?? 1_800_000_000);
  return Buffer.concat([
    Buffer.from("22f123639d7ef4cd", "hex"),
    Buffer.alloc(32, 1),
    opts.verified === false ? Buffer.from([0, 3]) : Buffer.from([1]),
    Buffer.from(opts.feed ?? PYTH_SOL_USD_FEED_ID, "hex"),
    i64(opts.price),
    u64(1_498_244n),
    i32(opts.expo ?? -8),
    i64(publish),
    i64(publish - 1n),
    i64(opts.price),
    u64(1_000n),
    u64(446_839_116n),
  ]);
}

describe("Pyth price account decoding", () => {
  it("decodes a fully verified SOL/USD update into micro-USD", () => {
    const decoded = decodePriceUpdateV2(priceUpdate({ price: 9_938_001_756n }));
    expect(decoded.feedIdHex).to.equal(PYTH_SOL_USD_FEED_ID);
    expect(decoded.fullyVerified).to.be.true;
    expect(decoded.exponent).to.equal(-8);
    expect(decoded.postedSlot).to.equal(446_839_116n);
    expect(toMicroUsd(decoded.price, decoded.exponent)).to.equal(99_380_017n); // $99.380017
  });

  it("handles partially verified layouts and positive exponent shifts", () => {
    const partial = decodePriceUpdateV2(priceUpdate({ price: 5n, expo: -2, verified: false }));
    expect(partial.fullyVerified).to.be.false;
    expect(partial.price).to.equal(5n);
    expect(toMicroUsd(5n, -2)).to.equal(50_000n);
    expect(() => toMicroUsd(0n, -8)).to.throw();
  });

  it("encodes test fixtures byte-for-byte like a real fully verified update", () => {
    const real = priceUpdate({ price: 9_938_001_756n });
    const encoded = encodePriceUpdateV2({
      feedIdHex: PYTH_SOL_USD_FEED_ID,
      price: 9_938_001_756n,
      conf: 1_498_244n,
      exponent: -8,
      publishTime: 1_800_000_000,
      postedSlot: 446_839_116n,
    });
    expect(encoded.length).to.equal(real.length);
    const decoded = decodePriceUpdateV2(encoded);
    expect(decoded).to.deep.equal(decodePriceUpdateV2(real));
  });

  it("rejects accounts that aren't price updates", () => {
    expect(() => decodePriceUpdateV2(Buffer.alloc(134))).to.throw(/PriceUpdateV2/);
    expect(() => decodePriceUpdateV2(priceUpdate({ price: 1n }).subarray(0, 100))).to.throw(/truncated/);
  });
});

describe("pool price conversion", () => {
  it("squares the Q64.64 sqrt price", () => {
    const one = sqrtPriceToRational(1n << 64n);
    expect(one.num).to.equal(one.den);
    const quarter = sqrtPriceToRational(1n << 63n);
    expect(quarter.num * 4n).to.equal(quarter.den);
  });
});

describe("Jupiter quote validation", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const mint = Keypair.generate().publicKey.toBase58();
  const good: JupiterQuote = {
    inputMint: SOL,
    outputMint: mint,
    inAmount: "1000000",
    outAmount: "5000",
    otherAmountThreshold: "4950",
    swapMode: "ExactIn",
    slippageBps: 100,
    priceImpactPct: "0.001",
    routePlan: [],
  };
  const expected = { inputMint: SOL, outputMint: mint, amount: 1_000_000n, slippageBps: 100 };

  it("accepts a quote for exactly the requested swap", () => {
    expect(() => checkQuote(good, expected)).to.not.throw();
  });

  it("rejects a quote that spends more, trades something else, or loosens the minimum output", () => {
    expect(() => checkQuote({ ...good, inAmount: "500000000000" }, expected)).to.throw(/spends/);
    expect(() => checkQuote({ ...good, inputMint: mint }, expected)).to.throw(/input mint/);
    expect(() => checkQuote({ ...good, outputMint: SOL }, expected)).to.throw(/output mint/);
    expect(() => checkQuote({ ...good, otherAmountThreshold: "0" }, expected)).to.throw(/minimum output/);
    expect(() => checkQuote({ ...good, otherAmountThreshold: "6000" }, expected)).to.throw(/minimum output/);
    expect(() => checkQuote({ ...good, swapMode: "ExactOut" }, expected)).to.throw(/ExactIn/);
    expect(() => checkQuote({ ...good, slippageBps: 5_000 }, expected)).to.throw(/slippage/);
    expect(() => checkQuote({ ...good, outAmount: "1e9" }, expected)).to.throw(/integer/);
  });
});

describe("Jupiter swap transaction guard", () => {
  const keeper = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const swapIx = new TransactionInstruction({ programId: JUPITER_V6_PROGRAM_ID, keys: [{ pubkey: keeper.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) });

  function tx(payer: PublicKey, instructions: TransactionInstruction[]): VersionedTransaction {
    return new VersionedTransaction(MessageV0.compile({ payerKey: payer, instructions, recentBlockhash: blockhash }));
  }

  it("accepts a keeper-paid swap using only allowed programs", () => {
    const allowed = tx(keeper.publicKey, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
      swapIx,
    ]);
    expect(() => checkSwapTransactionShape(allowed, keeper.publicKey)).to.not.throw();
  });

  it("rejects another fee payer, extra signers, and unexpected programs", () => {
    expect(() => checkSwapTransactionShape(tx(Keypair.generate().publicKey, [swapIx]), keeper.publicKey)).to.throw(/fee payer/);

    const extraSigner = new TransactionInstruction({
      programId: JUPITER_V6_PROGRAM_ID,
      keys: [{ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false }],
      data: Buffer.alloc(0),
    });
    expect(() => checkSwapTransactionShape(tx(keeper.publicKey, [swapIx, extraSigner]), keeper.publicKey)).to.throw(/signers/);

    const rogue = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
    expect(() => checkSwapTransactionShape(tx(keeper.publicKey, [swapIx, rogue]), keeper.publicKey)).to.throw(/unexpected program/);
  });
});
