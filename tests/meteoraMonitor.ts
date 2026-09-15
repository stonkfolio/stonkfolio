import { expect } from "chai";
import { createHash } from "crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { currentPoint } from "../keeper/meteora/point";
import { MeteoraPin, checkMeteora, parseProgramAccount, parseProgramData } from "../keeper/monitor";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

function programAccount(programData: PublicKey): Buffer {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  programData.toBuffer().copy(data, 4);
  return data;
}

function programData(slot: number, authority: PublicKey | null): Buffer {
  const data = Buffer.alloc(45 + 8);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(BigInt(slot), 4);
  if (authority) {
    data[12] = 1;
    authority.toBuffer().copy(data, 13);
  }
  return data;
}

describe("Meteora monitor", () => {
  const program = Keypair.generate().publicKey;
  const data = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const configData = Buffer.from("config bytes");

  function chain(slot: number, currentAuthority: PublicKey | null, currentConfig: Buffer): Connection {
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>([
      [program.toBase58(), { owner: LOADER, data: programAccount(data) }],
      [data.toBase58(), { owner: LOADER, data: programData(slot, currentAuthority) }],
      [config.toBase58(), { owner: Keypair.generate().publicKey, data: currentConfig }],
    ]);
    return { getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null } as unknown as Connection;
  }

  const pin: MeteoraPin = {
    damm_v2: { programId: program.toBase58(), sha256: "unused-by-the-keeper", lastDeployedSlot: 100, upgradeAuthority: authority.toBase58() },
    damm_v2_customizable_config: { address: config.toBase58(), sha256: createHash("sha256").update(configData).digest("hex") },
  };

  it("parses upgradeable program and programdata headers", () => {
    expect(parseProgramAccount(programAccount(data)).equals(data)).to.be.true;
    expect(parseProgramData(programData(42, authority))).to.deep.equal({ slot: 42, upgradeAuthority: authority.toBase58() });
    expect(parseProgramData(programData(42, null)).upgradeAuthority).to.equal(null);
    expect(() => parseProgramData(Buffer.alloc(45))).to.throw(/programdata/);
  });

  it("stays quiet when nothing moved, and reports a redeploy, a new upgrade authority, and a changed config", async () => {
    expect(await checkMeteora(chain(100, authority, configData), pin)).to.deep.equal([]);
    const problems = await checkMeteora(chain(250, Keypair.generate().publicKey, Buffer.from("other bytes")), pin);
    expect(problems).to.have.length(3);
    expect(problems[0]).to.match(/redeployed at slot 250/);
    expect(problems[1]).to.match(/upgrade authority changed/);
    expect(problems[2]).to.match(/damm_v2_customizable_config .* changed/);
  });
});

describe("Meteora current point", () => {
  it("steps back past slots with no block time yet, and uses slots for slot-activated pools", async () => {
    const connection = {
      getSlot: async () => 1_000,
      getBlockTime: async (slot: number) => {
        if (slot === 1_000) return null;
        if (slot === 999) throw new Error("Block not available for slot 999");
        return 1_800_000_000 + slot;
      },
    } as unknown as Connection;
    expect((await currentPoint(connection, 1)).toNumber()).to.equal(1_800_000_998);
    expect((await currentPoint(connection, 0)).toNumber()).to.equal(1_000);
  });
});
