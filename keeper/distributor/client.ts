/**
 * Keeper-side client for stonkfolio-distributor. Every write checks on-chain
 * state first so a retried step never repeats an action that already landed.
 */
import BN from "bn.js";
import { AnchorProvider, IdlAccounts, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TokenAccountNotFoundError,
  calculateEpochFee,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
} from "@solana/spl-token";
import idl from "./idl.json";
import type { StonkfolioDistributor } from "./stonkfolio_distributor";
import { u64le } from "../../lib/merkle";
import { sendTransaction } from "../../lib/send";
import { RoundPolicy, policyHash } from "../round/policy";
import type { IntentRecord } from "../round/prepare";
import { RoundAssetTree } from "../round/trees";
import { PayoutLeafRow } from "../round/types";

export const DISTRIBUTOR_PROGRAM_ID = new PublicKey(idl.address);
/** A seeded round whose secret is lost can be abandoned this long after seeding (state.rs). */
export const SEEDED_ABANDON_DELAY_SECS = 7 * 24 * 60 * 60;
/** A closed round whose seed block aged out unrecorded can be abandoned this long after its window closed (state.rs). */
export const EXPIRED_SEED_ABANDON_DELAY_SECS = 24 * 60 * 60;

const bn = (value: bigint | number) => new BN(value.toString());
/** Enough for 8 pushes that each create their destination account. */
export const PUSH_BLOCK_COMPUTE_UNITS = 1_000_000;

export function distributorAddress(indexMint: PublicKey, creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("distributor"), indexMint.toBuffer(), creator.toBuffer()],
    DISTRIBUTOR_PROGRAM_ID
  )[0];
}

export function intentAddress(distributor: PublicKey, roundId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("intent"), distributor.toBuffer(), u64le(roundId)], DISTRIBUTOR_PROGRAM_ID)[0];
}

export function roundAddress(distributor: PublicKey, roundId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("round"), distributor.toBuffer(), u64le(roundId)], DISTRIBUTOR_PROGRAM_ID)[0];
}

export function roundAssetAddress(round: PublicKey, assetIdx: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("round_asset"), round.toBuffer(), Buffer.from([assetIdx])], DISTRIBUTOR_PROGRAM_ID)[0];
}

export function isLeafClaimed(bitmap: Buffer, leafIdx: number): boolean {
  return (bitmap[Math.floor(leafIdx / 8)] & (1 << (leafIdx % 8))) !== 0;
}

export type IntentStatus = "open" | "closed" | "seeded" | "committed" | "abandoned";

/** A RoundIntent account, in the units round inputs publish. */
export interface IntentView extends IntentRecord {
  roundId: bigint;
  status: IntentStatus;
  seedTs: number;
}

const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");

function toIntentView(a: IdlAccounts<StonkfolioDistributor>["roundIntent"]): IntentView {
  return {
    roundId: BigInt(a.roundId.toString()),
    status: Object.keys(a.status)[0] as IntentStatus,
    openSlot: a.openSlot.toNumber(),
    openTs: a.openTs.toNumber(),
    closeSlot: a.closeSlot.toNumber(),
    closeTs: a.closeTs.toNumber(),
    snapshotCount: a.snapshotCount,
    snapshotChainHeadHex: hex(a.snapshotChainHead),
    secretCommitmentHex: hex(a.secretCommitment),
    seedSlot: a.seedSlot.toNumber(),
    seedHashHex: hex(a.seedHash),
    seedTs: a.seedTs.toNumber(),
    solUsd: {
      price: BigInt(a.solUsdPrice.toString()),
      conf: BigInt(a.solUsdConf.toString()),
      exponent: a.solUsdExponent,
      publishTime: a.solUsdPublishTime.toNumber(),
    },
  };
}

/** The fields a round's inputs.json carries. */
export function intentRecord(view: IntentView): IntentRecord {
  const { roundId: _roundId, status: _status, seedTs: _seedTs, ...record } = view;
  return record;
}

export class DistributorClient {
  readonly program: Program<StonkfolioDistributor>;
  private readonly decimals = new Map<string, number>();

  constructor(
    readonly connection: Connection,
    /** Signs and pays; the root authority for keeper operations. */
    readonly signer: Keypair,
    readonly distributor: PublicKey,
    readonly indexMint?: PublicKey
  ) {
    this.program = new Program(idl as StonkfolioDistributor, new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" }));
  }

  /** The distributor this keeper creates (and is root authority of) for an index coin. */
  static forIndexMint(connection: Connection, keeper: Keypair, indexMint: PublicKey): DistributorClient {
    return new DistributorClient(connection, keeper, distributorAddress(indexMint, keeper.publicKey), indexMint);
  }

  intent(roundId: bigint): PublicKey {
    return intentAddress(this.distributor, roundId);
  }

  round(roundId: bigint): PublicKey {
    return roundAddress(this.distributor, roundId);
  }

  roundAsset(roundId: bigint, assetIdx: number): PublicKey {
    return roundAssetAddress(this.round(roundId), assetIdx);
  }

  fetchDistributor() {
    return this.program.account.distributor.fetchNullable(this.distributor);
  }

  async fetchIntent(roundId: bigint): Promise<IntentView | null> {
    const account = await this.program.account.roundIntent.fetchNullable(this.intent(roundId));
    return account ? toIntentView(account) : null;
  }

  fetchRound(roundId: bigint) {
    return this.program.account.roundHeader.fetchNullable(this.round(roundId));
  }

  fetchRoundAsset(roundId: bigint, assetIdx: number) {
    return this.program.account.roundAsset.fetchNullable(this.roundAsset(roundId, assetIdx));
  }

  /**
   * Creates this keeper's distributor with the policy's rules fixed on-chain,
   * or confirms the existing one was created with exactly this policy.
   */
  async ensureDistributor(policy: RoundPolicy): Promise<string | undefined> {
    const hash = policyHash(policy);
    const existing = await this.fetchDistributor();
    if (existing) {
      const fixed = Buffer.from(existing.policyHash);
      if (!fixed.equals(hash)) {
        throw new Error(
          `distributor ${this.distributor.toBase58()} is fixed to round policy ${fixed.toString("hex")}, but this keeper's policy hashes to ${hash.toString("hex")}`
        );
      }
      return undefined;
    }
    if (!this.indexMint) throw new Error("creating a distributor needs its index mint");
    if (!distributorAddress(this.indexMint, this.signer.publicKey).equals(this.distributor)) {
      throw new Error(`distributor ${this.distributor.toBase58()} doesn't exist, and only its creator key can create it`);
    }
    const ix = await this.program.methods
      .createDistributor({
        minExpirySecs: bn(policy.minExpirySecs),
        policyHash: Array.from(hash),
        priceFeedAccount: new PublicKey(policy.priceFeedAccount),
        priceFeedId: Array.from(Buffer.from(policy.priceFeedIdHex, "hex")),
        maxPriceAgeSecs: policy.maxPriceAgeSecs,
        maxPriceConfBps: policy.maxPriceConfBps,
        seedSlotOffset: policy.seedSlotOffset,
        minWindowSecs: policy.minWindowSecs,
      })
      .accountsStrict({
        rootAuthority: this.signer.publicKey,
        payer: this.signer.publicKey,
        indexMint: this.indexMint,
        distributor: this.distributor,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return sendTransaction(this.connection, [ix], this.signer);
  }

  async nextRoundId(): Promise<bigint> {
    const account = await this.fetchDistributor();
    if (!account) throw new Error(`distributor ${this.distributor.toBase58()} does not exist`);
    return BigInt(account.nextRoundId.toString());
  }

  async openRound(roundId: bigint, secretCommitment: Buffer): Promise<string> {
    const ix = await this.program.methods
      .openRound(bn(roundId), Array.from(secretCommitment))
      .accountsStrict({
        rootAuthority: this.signer.publicKey,
        payer: this.signer.publicKey,
        distributor: this.distributor,
        intent: this.intent(roundId),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return sendTransaction(this.connection, [ix], this.signer);
  }

  async closeWindow(roundId: bigint, snapshotChainHead: Buffer, snapshotCount: number): Promise<string> {
    const distributor = await this.fetchDistributor();
    if (!distributor) throw new Error(`distributor ${this.distributor.toBase58()} does not exist`);
    const ix = await this.program.methods
      .closeWindow(Array.from(snapshotChainHead), snapshotCount)
      .accountsStrict({
        rootAuthority: this.signer.publicKey,
        distributor: this.distributor,
        intent: this.intent(roundId),
        priceUpdate: distributor.priceFeedAccount,
      })
      .instruction();
    return sendTransaction(this.connection, [ix], this.signer);
  }

  /** Permissionless: any wallet can record the seed once its block exists. */
  async recordSeed(roundId: bigint): Promise<string> {
    const ix = await this.program.methods
      .recordSeed()
      .accountsStrict({ distributor: this.distributor, intent: this.intent(roundId), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY })
      .instruction();
    return sendTransaction(this.connection, [ix], this.signer);
  }

  async abandonRound(roundId: bigint): Promise<string> {
    const ix = await this.program.methods
      .abandonRound()
      .accountsStrict({
        rootAuthority: this.signer.publicKey,
        distributor: this.distributor,
        intent: this.intent(roundId),
        slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
      })
      .instruction();
    return sendTransaction(this.connection, [ix], this.signer);
  }

  async commitRound(args: {
    roundId: bigint;
    /** Revealed here; must hash to the commitment made when the round opened. */
    secret: Buffer;
    assetsRoot: Buffer;
    artifactHash: Buffer;
    assetCount: number;
    expiryTs: number;
    allowFreezeAuthorityMask: number;
  }): Promise<string> {
    const ix = await this.program.methods
      .commitRound({
        roundId: bn(args.roundId),
        secret: Array.from(args.secret),
        assetsRoot: Array.from(args.assetsRoot),
        artifactHash: Array.from(args.artifactHash),
        assetCount: args.assetCount,
        expiryTs: bn(args.expiryTs),
        allowFreezeAuthorityMask: args.allowFreezeAuthorityMask,
      })
      .accountsStrict({
        rootAuthority: this.signer.publicKey,
        payer: this.signer.publicKey,
        distributor: this.distributor,
        intent: this.intent(args.roundId),
        round: this.round(args.roundId),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return sendTransaction(this.connection, [ix], this.signer);
  }

  async decimalsOf(mint: PublicKey, tokenProgram: PublicKey): Promise<number> {
    let decimals = this.decimals.get(mint.toBase58());
    if (decimals === undefined) {
      decimals = (await getMint(this.connection, mint, "confirmed", tokenProgram)).decimals;
      this.decimals.set(mint.toBase58(), decimals);
    }
    return decimals;
  }

  /** What arrives when `gross` is transferred (Token-2022 transfer fees withheld). */
  async netAfterTransferFee(mint: PublicKey, tokenProgram: PublicKey, gross: bigint): Promise<bigint> {
    if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return gross;
    const config = getTransferFeeConfig(await getMint(this.connection, mint, "confirmed", tokenProgram));
    if (!config) return gross;
    const { epoch } = await this.connection.getEpochInfo("confirmed");
    return gross - calculateEpochFee(config, BigInt(epoch), gross);
  }

  async tokenBalance(tokenAccount: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    try {
      return (await getAccount(this.connection, tokenAccount, "confirmed", tokenProgram)).amount;
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) return 0n;
      throw err;
    }
  }

  signerTokenAccount(mint: PublicKey, tokenProgram: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, this.signer.publicKey, false, tokenProgram);
  }

  /**
   * Brings an asset to Active in one transaction: open it if needed, send the
   * vault whatever it still lacks (grossed up for any transfer fee) from the
   * keeper's holdings, activate. `reserved` caps what may be sent.
   */
  async openFundActivate(
    roundId: bigint,
    asset: RoundAssetTree,
    assetProof: Buffer[],
    reserved: bigint
  ): Promise<{ signature?: string; transferred: bigint }> {
    const round = this.round(roundId);
    const roundAsset = roundAssetAddress(round, asset.assetIdx);
    const vault = getAssociatedTokenAddressSync(asset.mint, roundAsset, true, asset.tokenProgram);
    const existing = await this.program.account.roundAsset.fetchNullable(roundAsset);
    if (existing && "active" in existing.status) return { transferred: 0n };

    const ixs: TransactionInstruction[] = [];
    if (!existing) {
      ixs.push(
        await this.program.methods
          .openAsset({
            assetIdx: asset.assetIdx,
            merkleRoot: Array.from(asset.merkleRoot),
            allocated: bn(asset.allocated),
            leafCount: asset.leafCount,
            assetProof: assetProof.map((node) => Array.from(node)),
          })
          .accountsStrict({
            payer: this.signer.publicKey,
            round,
            roundAsset,
            mint: asset.mint,
            vault,
            tokenProgram: asset.tokenProgram,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      );
    }
    const vaultBalance = await this.tokenBalance(vault, asset.tokenProgram);
    const transferred = vaultBalance < asset.allocated ? await this.grossForNet(asset.mint, asset.tokenProgram, asset.allocated - vaultBalance) : 0n;
    if (transferred > reserved) {
      throw new Error(`asset ${asset.assetIdx} needs ${transferred} of ${asset.mint.toBase58()} but only ${reserved} is reserved for it`);
    }
    if (transferred > 0n) {
      ixs.push(
        createTransferCheckedInstruction(
          this.signerTokenAccount(asset.mint, asset.tokenProgram),
          asset.mint,
          vault,
          this.signer.publicKey,
          transferred,
          await this.decimalsOf(asset.mint, asset.tokenProgram),
          [],
          asset.tokenProgram
        )
      );
    }
    ixs.push(
      await this.program.methods
        .activateAsset()
        .accountsStrict({ round, roundAsset, vault })
        .instruction()
    );
    return { signature: await sendTransaction(this.connection, ixs, this.signer), transferred };
  }

  /** What to send so that `net` arrives after any Token-2022 transfer fee. */
  async grossForNet(mint: PublicKey, tokenProgram: PublicKey, net: bigint): Promise<bigint> {
    let gross = net;
    for (let i = 0; i < 8; i++) {
      const arrives = await this.netAfterTransferFee(mint, tokenProgram, gross);
      if (arrives >= net) return gross;
      gross += net - arrives;
    }
    return gross;
  }

  /** Pushes one payout to the recipient's canonical token account, creating it if needed. */
  async pushPayout(roundId: bigint, asset: RoundAssetTree, leaf: PayoutLeafRow): Promise<string> {
    const round = this.round(roundId);
    const roundAsset = roundAssetAddress(round, asset.assetIdx);
    const recipient = new PublicKey(leaf.recipient);
    const destination = getAssociatedTokenAddressSync(asset.mint, recipient, true, asset.tokenProgram);
    const ix = await this.program.methods
      .pushPayout(leaf.leafIdx, bn(leaf.amount), asset.tree.proof(leaf.leafIdx).map((node) => Array.from(node)))
      .accountsStrict({
        payer: this.signer.publicKey,
        round,
        roundAsset,
        mint: asset.mint,
        vault: getAssociatedTokenAddressSync(asset.mint, roundAsset, true, asset.tokenProgram),
        recipient,
        destination,
        tokenProgram: asset.tokenProgram,
      })
      .instruction();
    return sendTransaction(
      this.connection,
      [createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, destination, recipient, asset.mint, asset.tokenProgram), ix],
      this.signer
    );
  }

  /**
   * One `push_payouts` block: creates any destination accounts that don't
   * exist yet, then pays every `push` leaf with the block's shared proof.
   * `leaves` must be every leaf of the block, in order.
   */
  async pushPayoutBlockInstructions(
    roundId: bigint,
    asset: RoundAssetTree,
    firstLeaf: number,
    level: number,
    leaves: { leaf: PayoutLeafRow; push: boolean; createAccount: boolean }[]
  ): Promise<TransactionInstruction[]> {
    const round = this.round(roundId);
    const roundAsset = roundAssetAddress(round, asset.assetIdx);
    const instructions: TransactionInstruction[] = [];
    const destinations: PublicKey[] = [];
    const encoded = leaves.map(({ leaf, push, createAccount }) => {
      const recipient = new PublicKey(leaf.recipient);
      if (!push) return { skip: { recipient, amount: bn(leaf.amount) } };
      const destination = getAssociatedTokenAddressSync(asset.mint, recipient, true, asset.tokenProgram);
      if (createAccount) {
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, destination, recipient, asset.mint, asset.tokenProgram));
      }
      destinations.push(destination);
      return { push: { amount: bn(leaf.amount) } };
    });
    instructions.push(
      await this.program.methods
        .pushPayouts({ firstLeaf, level, leaves: encoded, proof: asset.tree.blockProof(firstLeaf, level).map((node) => Array.from(node)) })
        .accountsStrict({
          payer: this.signer.publicKey,
          round,
          roundAsset,
          mint: asset.mint,
          vault: getAssociatedTokenAddressSync(asset.mint, roundAsset, true, asset.tokenProgram),
          tokenProgram: asset.tokenProgram,
        })
        .remainingAccounts(destinations.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
        .instruction()
    );
    return instructions;
  }

  /** Whether a push block fits in one transaction paid and signed by this client's signer. */
  fitsInOneTransaction(instructions: TransactionInstruction[]): boolean {
    const tx = new Transaction({ feePayer: this.signer.publicKey, blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 0 }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: PUSH_BLOCK_COMPUTE_UNITS }),
      ...instructions
    );
    try {
      return tx.serializeMessage().length + 1 + 64 <= PACKET_DATA_SIZE;
    } catch {
      return false;
    }
  }

  sendPushBlock(instructions: TransactionInstruction[]): Promise<string> {
    return sendTransaction(this.connection, instructions, this.signer, [], PUSH_BLOCK_COMPUTE_UNITS);
  }

  /** For a recipient signing their own claim into any token account they own. */
  async selfClaimInstruction(roundId: bigint, asset: RoundAssetTree, leaf: PayoutLeafRow, destination: PublicKey): Promise<TransactionInstruction> {
    const round = this.round(roundId);
    const roundAsset = roundAssetAddress(round, asset.assetIdx);
    return this.program.methods
      .selfClaim(leaf.leafIdx, bn(leaf.amount), asset.tree.proof(leaf.leafIdx).map((node) => Array.from(node)))
      .accountsStrict({
        round,
        roundAsset,
        mint: asset.mint,
        vault: getAssociatedTokenAddressSync(asset.mint, roundAsset, true, asset.tokenProgram),
        recipient: new PublicKey(leaf.recipient),
        destination,
        tokenProgram: asset.tokenProgram,
      })
      .instruction();
  }

  /** After expiry: returns the asset's remaining tokens and rent to the keeper. */
  async closeAsset(roundId: bigint, assetIdx: number, mint: PublicKey, tokenProgram: PublicKey): Promise<string> {
    const round = this.round(roundId);
    const roundAsset = roundAssetAddress(round, assetIdx);
    const rolloverDestination = this.signerTokenAccount(mint, tokenProgram);
    const ix = await this.program.methods
      .closeAsset()
      .accountsStrict({
        distributor: this.distributor,
        round,
        roundAsset,
        mint,
        vault: getAssociatedTokenAddressSync(mint, roundAsset, true, tokenProgram),
        rolloverDestination,
        rolloverWallet: this.signer.publicKey,
        tokenProgram,
      })
      .instruction();
    return sendTransaction(
      this.connection,
      [createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, rolloverDestination, this.signer.publicKey, mint, tokenProgram), ix],
      this.signer
    );
  }
}
