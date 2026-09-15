import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { buildManifest, writeArtifacts } from "../lib/artifacts";
import { canonicalJson } from "../lib/canonicalJson";
import { verifyProof, payoutLeafHash } from "../lib/merkle";
import { parsePolicy, policyHash } from "../keeper/round/policy";
import { IntentRecord, parseRoundInputs, prepareRound, snapshotHash } from "../keeper/round/prepare";
import { readCommittedRoundHashes, verifyRoundArtifacts } from "../keeper/round/verify";
import { buildRoundInputs, candidateSnapshots, fixturePolicy } from "./helpers/roundFixture";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stonkfolio-round-"));
}

const sha256Hex = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const selection = (inputs: ReturnType<typeof buildRoundInputs>) => canonicalJson(inputs.selectedSnapshots.map((s) => s.index));

describe("round artifacts and verification", () => {
  it("publishes a bundle that re-verifies from its inputs", () => {
    const prepared = prepareRound(buildRoundInputs());
    const dir = tempDir();
    const manifestHash = writeArtifacts(dir, prepared.meta, prepared.files);
    expect(manifestHash.equals(prepared.manifestHash)).to.be.true;

    const report = verifyRoundArtifacts(dir);
    expect(report.manifestHash).to.equal(prepared.manifestHash.toString("hex"));
    expect(report.assetsRoot).to.equal(prepared.trees.assetsRoot.toString("hex"));
    expect(report.assets).to.equal(prepared.allocation.assets.length);
  });

  it("produces byte-identical output from identical inputs, and round-trips inputs.json", () => {
    const a = prepareRound(buildRoundInputs());
    const b = prepareRound(buildRoundInputs());
    expect(a.manifestHash.equals(b.manifestHash)).to.be.true;
    expect(canonicalJson(a.files)).to.equal(canonicalJson(b.files));
    const text = canonicalJson(buildRoundInputs());
    expect(canonicalJson(parseRoundInputs(text))).to.equal(text);
  });

  it("builds payout proofs that verify against each asset root", () => {
    const inputs = buildRoundInputs();
    const prepared = prepareRound(inputs);
    for (const [i, allocation] of prepared.allocation.assets.entries()) {
      const { tree } = prepared.trees.assets[i];
      for (const leaf of allocation.leaves) {
        const hash = payoutLeafHash(new PublicKey(inputs.programId), new PublicKey(inputs.distributor), inputs.roundId, i, {
          leafIdx: leaf.leafIdx,
          recipient: new PublicKey(leaf.recipient),
          amount: leaf.amount,
        });
        expect(verifyProof(tree.proof(leaf.leafIdx), tree.root, hash)).to.be.true;
      }
    }
  });

  it("detects a file edited after publishing", () => {
    const prepared = prepareRound(buildRoundInputs());
    const dir = tempDir();
    writeArtifacts(dir, prepared.meta, prepared.files);
    const target = path.join(dir, "allocation.json");
    fs.writeFileSync(target, fs.readFileSync(target, "utf-8").replace(/"amount":"(\d)/, '"amount":"9$1'));
    expect(() => verifyRoundArtifacts(dir)).to.throw(/hash mismatch: allocation.json/);
  });

  it("detects a republished bundle whose allocation doesn't follow from its inputs", () => {
    const prepared = prepareRound(buildRoundInputs());
    const files = prepared.files.map((f) =>
      f.path === "allocation.json" ? { ...f, contents: f.contents.replace(/"amount":"(\d)/, '"amount":"9$1') } : f
    );
    const dir = tempDir();
    writeArtifacts(dir, prepared.meta, files);
    expect(() => verifyRoundArtifacts(dir)).to.throw(/allocation.json does not match/);
  });

  it("rejects hand-picked samples, tampered snapshots, and a secret other than the committed one", () => {
    const inputs = buildRoundInputs();
    const unselected = candidateSnapshots().find((s) => !inputs.selectedSnapshots.some((sel) => sel.index === s.index))!;
    expect(snapshotHash(unselected)).to.equal(inputs.candidates[unselected.index].sha256);
    expect(() => prepareRound({ ...inputs, selectedSnapshots: [unselected, ...inputs.selectedSnapshots.slice(1)] })).to.throw(
      /differ from seeded selection/
    );

    const tampered = buildRoundInputs();
    tampered.selectedSnapshots[0].accounts[0].amount += 1n;
    expect(() => prepareRound(tampered)).to.throw(/does not match its published hash/);

    // A secret whose draw differs from the committed one's.
    let other: Buffer | undefined;
    for (let n = 20; n < 80 && !other; n++) {
      if (selection(buildRoundInputs({ secret: Buffer.alloc(32, n) })) !== selection(inputs)) other = Buffer.alloc(32, n);
    }
    expect(other, "some other secret draws different samples").to.not.equal(undefined);
    expect(() => prepareRound({ ...inputs, secretHex: other!.toString("hex") })).to.throw(/commitment/);
    expect(() =>
      prepareRound({ ...inputs, secretHex: other!.toString("hex"), intent: { ...inputs.intent, secretCommitmentHex: sha256Hex(other!) } })
    ).to.throw(/differ from seeded selection/);
  });

  it("rejects inputs that don't follow from the recorded intent", () => {
    const inputs = buildRoundInputs();
    const withIntent = (patch: Partial<IntentRecord>) => prepareRound({ ...inputs, intent: { ...inputs.intent, ...patch } });
    expect(() => withIntent({ seedSlot: inputs.intent.closeSlot })).to.throw(/too close to the window close/);
    expect(() => withIntent({ closeSlot: 550 })).to.throw(/outside the recorded window/);
    expect(() => withIntent({ snapshotCount: 5 })).to.throw(/count differs/);
    expect(() => withIntent({ closeTs: inputs.intent.openTs + 10 })).to.throw(/shorter than the policy minimum/);
    expect(() => withIntent({ solUsd: { ...inputs.intent.solUsd, publishTime: inputs.intent.closeTs - 61 } })).to.throw(/stale/);
    expect(() => withIntent({ secretCommitmentHex: "AB".repeat(32) })).to.throw(/lowercase hex/);
  });

  it("rejects a snapshot list that doesn't match its recorded chain head", () => {
    const inputs = buildRoundInputs();
    const unselected = inputs.candidates.find((c) => !inputs.selectedSnapshots.some((s) => s.index === c.index))!;
    const altered = {
      ...inputs,
      candidates: inputs.candidates.map((c) => (c.index === unselected.index ? { ...c, sha256: "00".repeat(32) } : c)),
    };
    expect(() => prepareRound(altered)).to.throw(/chain head/);
  });

  it("pins minimum payouts to purchase prices and always excludes the keeper", () => {
    const inputs = buildRoundInputs();
    const assets = inputs.assets.map((a, i) => (i === 1 ? { ...a, minLeafAmount: 99n } : a));
    expect(() => prepareRound({ ...inputs, assets })).to.throw(/does not follow from the policy/);
    expect(() => prepareRound({ ...inputs, purchases: [{ ...inputs.purchases[0], signatures: [] }] })).to.throw(/no transaction evidence/);

    const prepared = prepareRound(inputs);
    const recipients = new Set(prepared.allocation.assets.flatMap((a) => a.leaves.map((l) => l.recipient)));
    expect(recipients.size).to.be.greaterThan(0);
    expect(recipients.has(inputs.rootAuthority), "the keeper never pays itself").to.be.false;
  });

  it("hashes the policy canonically, and any change yields a different hash", () => {
    const policy = fixturePolicy();
    expect(policyHash(parsePolicy(JSON.parse(canonicalJson(policy)))).equals(policyHash(policy))).to.be.true;
    expect(policyHash({ ...policy, minEligibleUsdMicro: 49_000_000n }).equals(policyHash(policy))).to.be.false;
    expect(policyHash({ ...policy, staticExclusions: [] }).equals(policyHash(policy))).to.be.false;
    expect(() => parsePolicy({ ...JSON.parse(canonicalJson(policy)), seedSlotOffset: 0 })).to.throw(/seedSlotOffset/);
  });

  it("publishes a round with nothing payable as an empty, verifiable bundle", () => {
    const inputs = buildRoundInputs();
    const prepared = prepareRound({ ...inputs, policy: { ...inputs.policy, minEligibleUsdMicro: 10n ** 15n } });
    expect(prepared.trees.assets).to.have.length(0);
    expect(prepared.trees.assetsRoot.equals(Buffer.alloc(32))).to.be.true;
    const dir = tempDir();
    writeArtifacts(dir, prepared.meta, prepared.files);
    expect(verifyRoundArtifacts(dir).assets).to.equal(0);
  });

  it("rejects artifact paths that could escape the bundle or read differently across platforms", () => {
    expect(() => buildManifest({}, [{ path: "a\\b.json", contents: "" }])).to.throw(/unsafe artifact path/);
    expect(() => buildManifest({}, [{ path: "../x.json", contents: "" }])).to.throw(/unsafe artifact path/);
  });

  it("reads the committed roots from a RoundHeader account", () => {
    const data = Buffer.concat([Buffer.alloc(8, 1), Buffer.alloc(32, 2), Buffer.alloc(8, 3), Buffer.alloc(32, 4), Buffer.alloc(32, 5), Buffer.alloc(40)]);
    expect(readCommittedRoundHashes(data)).to.deep.equal({
      assetsRoot: Buffer.alloc(32, 4).toString("hex"),
      artifactHash: Buffer.alloc(32, 5).toString("hex"),
    });
  });
});
