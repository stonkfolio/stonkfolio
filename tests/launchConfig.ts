import { expect } from "chai";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { PoolConfig, validateConfigParameters } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { FEE_TIERS_BPS, MIGRATION_QUOTE_THRESHOLD_LAMPORTS, buildLaunchConfig, checkLaunchConfig } from "../keeper/meteora/launchConfig";

/** A config account shaped as the program stores what createConfig was given for this tier. */
function storedConfig(feeBps: number, feeClaimer: PublicKey): PoolConfig {
  const built = buildLaunchConfig({ feeBps });
  const zeroVesting = { isInitialized: 0, vestingPercentage: 0, bpsPerPeriod: 0, numberOfPeriods: 0, frequency: 0, cliffDurationFromMigrationTime: 0 };
  const curve = Array.from({ length: 20 }, (_, i) => built.curve[i] ?? { sqrtPrice: new BN(0), liquidity: new BN(0) });
  return {
    quoteMint: NATIVE_MINT,
    feeClaimer,
    leftoverReceiver: feeClaimer,
    poolFees: { baseFee: { ...built.poolFees.baseFee }, dynamicFee: { initialized: 0 } },
    partnerLiquidityVestingInfo: zeroVesting,
    creatorLiquidityVestingInfo: zeroVesting,
    collectFeeMode: built.collectFeeMode,
    migrationOption: built.migrationOption,
    activationType: built.activationType,
    tokenDecimal: built.tokenDecimal,
    tokenType: built.tokenType,
    quoteTokenFlag: 0,
    partnerPermanentLockedLiquidityPercentage: 100,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
    creatorLiquidityPercentage: 0,
    migrationFeeOption: built.migrationFeeOption,
    fixedTokenSupplyFlag: 1,
    creatorTradingFeePercentage: 0,
    tokenUpdateAuthority: built.tokenUpdateAuthority,
    migrationFeePercentage: 0,
    creatorMigrationFeePercentage: 0,
    swapBaseAmount: new BN("800000000000000"),
    migrationQuoteThreshold: built.migrationQuoteThreshold,
    migrationBaseThreshold: new BN("200000000000000"),
    migrationSqrtPrice: built.curve[built.curve.length - 1].sqrtPrice,
    lockedVestingConfig: { amountPerPeriod: new BN(0), cliffDurationFromMigrationTime: new BN(0), frequency: new BN(0), numberOfPeriod: new BN(0), cliffUnlockAmount: new BN(0) },
    preMigrationTokenSupply: built.tokenSupply!.preMigrationTokenSupply,
    postMigrationTokenSupply: built.tokenSupply!.postMigrationTokenSupply,
    migratedCollectFeeMode: 0,
    migratedDynamicFee: 0,
    migratedPoolFeeBps: feeBps,
    migratedPoolBaseFeeMode: 0,
    enableFirstSwapWithMinFee: 0,
    migratedCompoundingFeeBps: 0,
    poolCreationFee: new BN(0),
    migratedPoolBaseFeeBytes: Array(16).fill(0),
    sqrtStartPrice: built.sqrtStartPrice,
    curve,
  } as unknown as PoolConfig;
}

describe("launch config", () => {
  for (const feeBps of FEE_TIERS_BPS) {
    it(`${feeBps / 100}% tier passes Meteora's validation with the launch settings`, () => {
      const config = buildLaunchConfig({ feeBps });
      expect(() => validateConfigParameters({ ...config, leftoverReceiver: Keypair.generate().publicKey })).to.not.throw();

      expect(config.poolFees.baseFee.cliffFeeNumerator.toString()).to.equal(String(feeBps * 100_000));
      expect(config.poolFees.baseFee.firstFactor).to.equal(0);
      expect(config.poolFees.dynamicFee).to.equal(null);
      expect(config.collectFeeMode).to.equal(0);
      expect(config.migrationOption).to.equal(1);
      expect(config.migrationFeeOption).to.equal(6);
      expect(config.migratedPoolFee).to.deep.equal({ collectFeeMode: 0, dynamicFee: 0, poolFeeBps: feeBps });
      expect(config.migrationQuoteThreshold.toString()).to.equal(MIGRATION_QUOTE_THRESHOLD_LAMPORTS.toString());
      expect(config.partnerPermanentLockedLiquidityPercentage).to.equal(100);
      expect(config.partnerLiquidityPercentage + config.creatorLiquidityPercentage + config.creatorPermanentLockedLiquidityPercentage).to.equal(0);
      expect(config.creatorTradingFeePercentage).to.equal(0);
      expect(config.tokenUpdateAuthority).to.equal(1);
      expect(config.tokenType).to.equal(0);
      expect(config.tokenDecimal).to.equal(6);
      expect(config.migrationFee).to.deep.equal({ feePercentage: 0, creatorFeePercentage: 0 });
      expect(config.poolCreationFee.isZero()).to.be.true;
      expect(config.enableFirstSwapWithMinFee).to.be.false;
    });
  }

  it("checks the curve, supply, vesting and migrated fee mode of a stored config, not just its fees", () => {
    const claimer = Keypair.generate().publicKey;
    const expected = { feeBps: 500, feeClaimer: claimer, leftoverReceiver: claimer, quoteMint: NATIVE_MINT };
    expect(checkLaunchConfig(storedConfig(500, claimer), expected)).to.deep.equal([]);

    const tamper = (change: (config: any) => void, pattern: RegExp) => {
      const config = storedConfig(500, claimer) as any;
      change(config);
      expect(checkLaunchConfig(config, expected).join("\n")).to.match(pattern);
    };
    tamper((c) => (c.sqrtStartPrice = c.sqrtStartPrice.addn(1)), /sqrt start price/);
    tamper((c) => (c.curve[1] = { ...c.curve[1], liquidity: c.curve[1].liquidity.muln(2) }), /curve point 1 liquidity/);
    tamper((c) => (c.curve[5] = { sqrtPrice: new BN(1), liquidity: new BN(1) }), /curve point 5/);
    tamper((c) => (c.preMigrationTokenSupply = new BN("2000000000000000")), /pre-migration token supply/);
    tamper((c) => (c.lockedVestingConfig = { ...c.lockedVestingConfig, amountPerPeriod: new BN(5) }), /locked vesting amountPerPeriod/);
    tamper((c) => (c.creatorLiquidityVestingInfo = { ...c.creatorLiquidityVestingInfo, vestingPercentage: 50 }), /creatorLiquidityVestingInfo vestingPercentage/);
    tamper((c) => (c.migratedPoolBaseFeeMode = 3), /migrated pool base fee mode/);
    tamper((c) => (c.migratedPoolBaseFeeBytes = [1, ...Array(15).fill(0)]), /migrated pool base fee bytes/);
    tamper((c) => (c.swapBaseAmount = new BN("900000000000000")), /more tokens than the pre-migration supply/);
  });

  it("refuses fees outside the tiers", () => {
    expect(() => buildLaunchConfig({ feeBps: 250 })).to.throw(/not a launch tier/);
    expect(() => buildLaunchConfig({ feeBps: 525 })).to.throw(/not a launch tier/);
  });
});
