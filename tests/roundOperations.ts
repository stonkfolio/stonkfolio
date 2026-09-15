import { expect } from "chai";
import { randomBytes } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { base58Encode } from "../lib/base58";
import { emptyLedger } from "../keeper/state";
import { backoffSecs, countLikelyEligible, isTransientError, reconcileReserve, shouldAutoPush } from "../keeper/round/operations";
import { pda, wallet } from "./helpers/roundFixture";

describe("round operations", () => {
  it("counts only holders already worth the threshold, skipping exclusions, program-owned wallets and dust", () => {
    const price = { num: 1n, den: 1n }; // 1 lamport per raw unit
    const solUsdMicro = 100_000_000n; // $100, so $50 is 500,000,000 raw units
    const accounts = [
      { address: "a", owner: wallet(1), amount: 500_000_000n },
      { address: "b", owner: wallet(2), amount: 499_999_999n },
      { address: "c1", owner: wallet(3), amount: 300_000_000n },
      { address: "c2", owner: wallet(3), amount: 200_000_000n },
      { address: "d", owner: pda(1), amount: 9_000_000_000n },
      { address: "e", owner: wallet(4), amount: 9_000_000_000n },
      ...Array.from({ length: 50 }, (_, i) => ({ address: `dust${i}`, owner: wallet(100 + i), amount: 1n })),
    ];
    const opts = { minEligibleUsdMicro: 50_000_000n, excluded: new Set([wallet(4)]), excludeOffCurve: true, cap: 65_536 };
    expect(countLikelyEligible(accounts, price, solUsdMicro, opts)).to.equal(2);
    expect(countLikelyEligible(accounts, price, solUsdMicro, { ...opts, cap: 1 })).to.equal(1);
    expect(countLikelyEligible(accounts, price, solUsdMicro, { ...opts, excludeOffCurve: false })).to.equal(3);
  });

  it("pushes into existing token accounts, and into new ones only when worth 3x their rent", () => {
    const rent = 2_039_280n;
    const price = { lamports: 1_000n, tokens: 1n };
    expect(shouldAutoPush({ accountExists: true, amount: 1n, rentLamports: 0n, minRentMultiple: 3 })).to.be.true;
    expect(shouldAutoPush({ accountExists: false, amount: 6_118n, price, rentLamports: rent, minRentMultiple: 3 })).to.be.true;
    expect(shouldAutoPush({ accountExists: false, amount: 6_117n, price, rentLamports: rent, minRentMultiple: 3 })).to.be.false;
    expect(shouldAutoPush({ accountExists: false, amount: 10n ** 12n, rentLamports: rent, minRentMultiple: 3 }), "unpriced leftovers").to.be.false;
  });

  it("returns unused reserve to the pot and takes overruns from it", () => {
    const ledger = { ...emptyLedger(), basketLamports: 100n, operationsLamports: 50n };
    expect(reconcileReserve(ledger, 50n, 20n)).to.deep.equal({ returned: 30n, overrun: 0n });
    expect(ledger).to.include({ basketLamports: 130n, operationsLamports: 0n });
    const over = { ...emptyLedger(), basketLamports: 10n, operationsLamports: 50n };
    expect(reconcileReserve(over, 50n, 80n)).to.deep.equal({ returned: 0n, overrun: 10n });
    expect(over).to.include({ basketLamports: 0n, operationsLamports: 0n });
  });

  it("pauses on keeper-side trouble and counts attempts for everything else", () => {
    expect(isTransientError("fetch failed")).to.be.true;
    expect(isTransientError("Transaction abc not confirmed within 90000ms (polling fallback)")).to.be.true;
    expect(isTransientError("429 Too Many Requests")).to.be.true;
    expect(isTransientError("Attempt to debit an account but found no record of a prior credit.")).to.be.true;
    expect(isTransientError("Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1771")).to.be.false;
    expect(isTransientError("AnchorError occurred. Error Code: AlreadyClaimed. Timed out? no")).to.be.false;
    expect(isTransientError("asset 3 needs 100 but only 90 is reserved for it")).to.be.false;
    expect(backoffSecs(1)).to.equal(60);
    expect(backoffSecs(3)).to.equal(240);
    expect(backoffSecs(30)).to.equal(6 * 60 * 60);
  });

  it("encodes base58 exactly like PublicKey", () => {
    const vectors = [Buffer.alloc(32), Buffer.alloc(32, 255), Keypair.generate().publicKey.toBuffer(), Buffer.concat([Buffer.alloc(5), randomBytes(27)])];
    for (const bytes of vectors) expect(base58Encode(bytes)).to.equal(new PublicKey(bytes).toBase58());
  });
});
