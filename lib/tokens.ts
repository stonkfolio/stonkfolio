import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint, getTransferHook } from "@solana/spl-token";

/** Detects which of the two token programs actually owns a mint. */
export async function tokenProgramForMint(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return info.owner;
}

/**
 * A Token-2022 mint with its own transfer hook can't be moved by a plain
 * `transfer_checked` CPI (the hook's extra accounts are missing), so the
 * distributor rejects such mints — the keeper filters them out before buying.
 */
export async function hasTransferHook(connection: Connection, mint: PublicKey, tokenProgram: PublicKey): Promise<boolean> {
  if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return false;
  const mintInfo = await getMint(connection, mint, "confirmed", tokenProgram);
  return getTransferHook(mintInfo) !== null;
}

const MINT_BASE_LEN = 82;
const ACCOUNT_BASE_LEN = 165;
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_STATE_FROZEN = 2;

// Token-2022 ExtensionType discriminants — must match
// programs/stonkfolio-distributor/src/token_utils.rs.
const EXT = {
  uninitialized: 0,
  transferFeeConfig: 1,
  mintCloseAuthority: 3,
  defaultAccountState: 6,
  interestBearingConfig: 10,
  transferHook: 14,
  metadataPointer: 18,
  tokenMetadata: 19,
  groupPointer: 20,
  tokenGroup: 21,
  groupMemberPointer: 22,
  tokenGroupMember: 23,
} as const;

const ALLOWED_WITHOUT_CHECKS = new Set<number>([
  EXT.interestBearingConfig,
  EXT.metadataPointer,
  EXT.tokenMetadata,
  EXT.groupPointer,
  EXT.tokenGroup,
  EXT.groupMemberPointer,
  EXT.tokenGroupMember,
]);

export type MintVetResult = { ok: true } | { ok: false; reason: string };

export interface MintVetOptions {
  allowFreezeAuthority: boolean;
  /** Highest current or scheduled transfer fee accepted; the program caps it at MAX_TRANSFER_FEE_BPS (300). */
  maxTransferFeeBps: number;
}

/**
 * Mirrors the distributor's on-chain `vet_mint` so the keeper never buys a
 * basket coin the program would refuse. Unknown extension types are rejected by
 * default, and so is any authority that could later add a hook or close the
 * mint. A transfer-fee authority is accepted (StonkFun's reward coins keep one);
 * the current and scheduled fee must both be within `maxTransferFeeBps`.
 */
export function vetMintData(data: Buffer, owner: PublicKey, opts: MintVetOptions): MintVetResult {
  const is2022 = owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!is2022 && !owner.equals(TOKEN_PROGRAM_ID)) return { ok: false, reason: "not owned by a token program" };
  if (data.length < MINT_BASE_LEN) return { ok: false, reason: "account too small to be a mint" };
  if (data[45] !== 1) return { ok: false, reason: "mint not initialized" };
  if (data.readUInt32LE(46) !== 0 && !opts.allowFreezeAuthority) return { ok: false, reason: "has a freeze authority" };
  if (data.length === MINT_BASE_LEN) return { ok: true };

  if (!is2022) return { ok: false, reason: "extension data on a legacy spl-token mint" };
  if (data.length <= ACCOUNT_BASE_LEN || data[ACCOUNT_BASE_LEN] !== ACCOUNT_TYPE_MINT) {
    return { ok: false, reason: "malformed Token-2022 mint" };
  }
  let offset = ACCOUNT_BASE_LEN + 1;
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    if (type === EXT.uninitialized) break;
    const start = offset + 4;
    const end = start + length;
    if (end > data.length) return { ok: false, reason: "truncated extension data" };
    const value = data.subarray(start, end);
    offset = end;

    const isSet = (bytes: Buffer) => bytes.some((b) => b !== 0);
    if (ALLOWED_WITHOUT_CHECKS.has(type)) continue;
    if (type === EXT.defaultAccountState) {
      if (value.length < 1 || value[0] === ACCOUNT_STATE_FROZEN) return { ok: false, reason: "accounts default to frozen" };
      continue;
    }
    if (type === EXT.mintCloseAuthority) {
      if (value.length < 32) return { ok: false, reason: "truncated close authority extension" };
      if (isSet(value.subarray(0, 32))) return { ok: false, reason: "has a mint close authority" };
      continue;
    }
    if (type === EXT.transferHook) {
      // authority (32), program id (32)
      if (value.length < 64) return { ok: false, reason: "truncated transfer hook extension" };
      if (isSet(value.subarray(32, 64))) return { ok: false, reason: "has an active transfer hook" };
      if (isSet(value.subarray(0, 32))) return { ok: false, reason: "has a transfer hook authority" };
      continue;
    }
    if (type === EXT.transferFeeConfig) {
      // config authority (32), withdraw authority (32), withheld (8), then older and newer fees: epoch u64, max u64, bps u16
      if (value.length < 108) return { ok: false, reason: "truncated transfer fee extension" };
      const olderBps = value.readUInt16LE(88);
      const newerBps = value.readUInt16LE(106);
      if (Math.max(olderBps, newerBps) > opts.maxTransferFeeBps) {
        return { ok: false, reason: `transfer fee ${Math.max(olderBps, newerBps)} bps exceeds ${opts.maxTransferFeeBps}` };
      }
      continue;
    }
    return { ok: false, reason: `extension type ${type} is not allowed` };
  }
  return { ok: true };
}
