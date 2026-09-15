import { expect } from "chai";
import { PYTH_SOL_USD_FEED_ID, PYTH_SOL_USD_PRICE_ACCOUNT, sponsoredFeedAccount } from "../lib/pyth";

describe("Pyth feed accounts", () => {
  it("SOL/USD's configured account is the push oracle's shard-0 account the program requires", () => {
    expect(sponsoredFeedAccount(PYTH_SOL_USD_FEED_ID).toBase58()).to.equal(PYTH_SOL_USD_PRICE_ACCOUNT.toBase58());
  });
});
