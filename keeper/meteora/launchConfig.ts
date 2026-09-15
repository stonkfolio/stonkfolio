/**
 * The exact Meteora DBC settings every launch uses. One reusable config per
 * creator fee tier; launches pick a tier and create their pool against it.
 *
 * Per tier: flat fee on the bonding curve, collected in SOL (Meteora keeps
 * 20%); migration to DAMM v2 at 85 SOL with the same fee, still in SOL; all
 * migrated liquidity permanently locked to the fee claimer; immutable token
 * metadata; no creator fee, migration fee, pool-creation fee, or vesting.
 */
import { PublicKey } from "@solana/web3.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  ConfigParameters,
  DammV2BaseFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  PoolConfig,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const FEE_TIERS_BPS = [300, 350, 400, 450, 500] as const;
export type FeeTierBps = (typeof FEE_TIERS_BPS)[number];

export const MIGRATION_QUOTE_THRESHOLD_SOL = 85;
export const MIGRATION_QUOTE_THRESHOLD_LAMPORTS = 85_000_000_000n;
/**
 * The launch curve (owner's decision, 2026-09-14): 1B supply with 25% going to the DAMM v2 pool at
 * migration. With the 85 SOL threshold that starts near a 37.8 SOL market cap and graduates at 340 SOL,
 * a 9× rise over the curve — flatter than 20% (16×), since launches have no anti-snipe fee.
 */
export const DEFAULT_TOTAL_SUPPLY = 1_000_000_000;
export const DEFAULT_SUPPLY_ON_MIGRATION_PCT = 25;
const FEE_NUMERATOR_PER_BPS = 100_000;

export function isFeeTier(bps: number): bps is FeeTierBps {
  return (FEE_TIERS_BPS as readonly number[]).includes(bps);
}

export interface LaunchCurveOptions {
  feeBps: number;
  totalTokenSupply?: number;
  percentageSupplyOnMigration?: number;
}

export function buildLaunchConfig(options: LaunchCurveOptions): ConfigParameters {
  if (!isFeeTier(options.feeBps)) throw new Error(`fee ${options.feeBps} bps is not a launch tier (${FEE_TIERS_BPS.join(", ")})`);
  const feeBps = options.feeBps;
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: options.totalTokenSupply ?? DEFAULT_TOTAL_SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: feeBps,
        compoundingFeeBps: 0,
        baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: options.percentageSupplyOnMigration ?? DEFAULT_SUPPLY_ON_MIGRATION_PCT,
    migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD_SOL,
  });
}

export interface ExpectedLaunchConfig extends LaunchCurveOptions {
  feeBps: number;
  feeClaimer: PublicKey;
  leftoverReceiver: PublicKey;
  quoteMint: PublicKey;
}

const VESTING_FIELDS = ["amountPerPeriod", "cliffDurationFromMigrationTime", "frequency", "numberOfPeriod", "cliffUnlockAmount"] as const;
const LIQUIDITY_VESTING_FIELDS = ["vestingPercentage", "bpsPerPeriod", "numberOfPeriods", "frequency", "cliffDurationFromMigrationTime"] as const;

/**
 * Compares a config account on-chain against the launch settings; returns
 * every mismatch. Covers the fees, the curve itself (start price and every
 * point), supply, vesting, and the migrated pool's fee mode, since any of
 * those changes a launch's economics.
 */
export function checkLaunchConfig(config: PoolConfig, expected: ExpectedLaunchConfig): string[] {
  const built = buildLaunchConfig(expected);
  const problems: string[] = [];
  const check = (label: string, actual: { toString(): string } | boolean | number, wanted: { toString(): string } | number) => {
    const actualText = typeof actual === "boolean" ? String(Number(actual)) : actual.toString();
    if (actualText !== wanted.toString()) problems.push(`${label}: expected ${wanted.toString()}, found ${actualText}`);
  };

  check("fee claimer", config.feeClaimer, expected.feeClaimer);
  check("leftover receiver", config.leftoverReceiver, expected.leftoverReceiver);
  check("quote mint", config.quoteMint, expected.quoteMint);
  check("base fee numerator", config.poolFees.baseFee.cliffFeeNumerator, expected.feeBps * FEE_NUMERATOR_PER_BPS);
  check("base fee first factor", config.poolFees.baseFee.firstFactor, 0);
  check("base fee second factor", config.poolFees.baseFee.secondFactor, 0);
  check("base fee third factor", config.poolFees.baseFee.thirdFactor, 0);
  check("dynamic fee", config.poolFees.dynamicFee.initialized, 0);
  check("collect fee mode", config.collectFeeMode, CollectFeeMode.QuoteToken);
  check("migration option", config.migrationOption, MigrationOption.MET_DAMM_V2);
  check("migration fee option", config.migrationFeeOption, MigrationFeeOption.Customizable);
  check("migration quote threshold", config.migrationQuoteThreshold, MIGRATION_QUOTE_THRESHOLD_LAMPORTS);
  check("token type", config.tokenType, TokenType.SPLToken);
  check("token decimals", config.tokenDecimal, TokenDecimal.SIX);
  check("token update authority", config.tokenUpdateAuthority, TokenAuthorityOption.Immutable);
  check("creator trading fee", config.creatorTradingFeePercentage, 0);
  check("migration fee", config.migrationFeePercentage, 0);
  check("creator migration fee", config.creatorMigrationFeePercentage, 0);
  check("partner locked liquidity", config.partnerPermanentLockedLiquidityPercentage, 100);
  check("partner unlocked liquidity", config.partnerLiquidityPercentage, 0);
  check("creator locked liquidity", config.creatorPermanentLockedLiquidityPercentage, 0);
  check("creator unlocked liquidity", config.creatorLiquidityPercentage, 0);
  check("migrated collect fee mode", config.migratedCollectFeeMode, MigratedCollectFeeMode.QuoteToken);
  check("migrated dynamic fee", config.migratedDynamicFee, DammV2DynamicFeeMode.Disabled);
  check("migrated pool fee bps", config.migratedPoolFeeBps, expected.feeBps);
  check("migrated compounding fee", config.migratedCompoundingFeeBps, 0);
  check("pool creation fee", config.poolCreationFee, 0);
  check("first swap min fee", config.enableFirstSwapWithMinFee, 0);

  check("activation type", config.activationType, built.activationType);
  check("quote token flag", config.quoteTokenFlag, 0);
  check("sqrt start price", config.sqrtStartPrice, built.sqrtStartPrice);
  config.curve.forEach((point, i) => {
    const wanted = built.curve[i];
    check(`curve point ${i} sqrt price`, point.sqrtPrice, wanted ? wanted.sqrtPrice : 0);
    check(`curve point ${i} liquidity`, point.liquidity, wanted ? wanted.liquidity : 0);
  });
  if (built.curve.length > config.curve.length) problems.push(`curve: expected ${built.curve.length} points, account holds ${config.curve.length}`);
  check("fixed token supply", config.fixedTokenSupplyFlag, built.tokenSupply ? 1 : 0);
  if (built.tokenSupply) {
    check("pre-migration token supply", config.preMigrationTokenSupply, built.tokenSupply.preMigrationTokenSupply);
    check("post-migration token supply", config.postMigrationTokenSupply, built.tokenSupply.postMigrationTokenSupply);
  }
  for (const field of VESTING_FIELDS) check(`locked vesting ${field}`, config.lockedVestingConfig[field], 0);
  for (const side of ["partnerLiquidityVestingInfo", "creatorLiquidityVestingInfo"] as const) {
    for (const field of LIQUIDITY_VESTING_FIELDS) check(`${side} ${field}`, config[side][field], 0);
  }
  check("migrated pool base fee mode", config.migratedPoolBaseFeeMode, built.migratedPoolBaseFeeMode ?? 0);
  check("migrated pool base fee bytes", Buffer.from(config.migratedPoolBaseFeeBytes).toString("hex"), "00".repeat(16));

  // Derived by the program from the curve: must stay consistent with it.
  const big = (value: { toString(): string }) => BigInt(value.toString());
  if (big(config.swapBaseAmount) + big(config.migrationBaseThreshold) > big(config.preMigrationTokenSupply)) {
    problems.push("curve sells more tokens than the pre-migration supply holds");
  }
  if (big(config.migrationSqrtPrice) <= big(config.sqrtStartPrice)) problems.push("migration price is not above the curve's start price");
  return problems;
}
