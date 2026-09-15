import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, Keypair } from "@solana/web3.js";
import { ProcessLock } from "../lib/lock";
import { resolveSignature } from "../lib/send";
import { KeeperStore, creditInventory, emptyLedger } from "../keeper/state";
import { FetchText, HeliusDasSource } from "../keeper/holders/source";
import { GitRepoPublisher, LocalDirectoryPublisher } from "../keeper/round/publisher";

const temp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe("keeper state", () => {
  it("starts empty and round-trips bigints through an atomic save", () => {
    const store = new KeeperStore(temp("stonkfolio-state-"));
    const state = store.load();
    expect(state.ledger).to.deep.equal(emptyLedger());
    expect(state.inventory).to.deep.equal({});
    state.ledger.basketLamports = 123_456_789_012_345_678_901n;
    state.expiring.push({ roundId: 7n, expiryTs: 99, assets: [] });
    creditInventory(state, "mintA", "program", 5n);
    creditInventory(state, "mintA", "program", 7n);
    creditInventory(state, "mintB", "program", 0n);
    store.save(state);
    expect(fs.existsSync(`${store.statePath}.tmp`)).to.be.false;
    const reloaded = store.load();
    expect(reloaded.ledger.basketLamports).to.equal(123_456_789_012_345_678_901n);
    expect(reloaded.expiring[0].roundId).to.equal(7n);
    expect(reloaded.inventory).to.deep.equal({ mintA: { tokenProgram: "program", amount: 12n } });
    if (process.platform !== "win32") expect(fs.statSync(store.statePath).mode & 0o777).to.equal(0o600);
  });
});

describe("process lock", () => {
  it("lets one live process hold a state directory, takes over a dead one's lock, and never removes another's", () => {
    const dir = temp("stonkfolio-lock-");
    const lockPath = path.join(dir, "keeper.lock");
    const lock = ProcessLock.acquire(dir);
    expect(() => ProcessLock.acquire(dir)).to.throw(/another keeper/);
    lock.release();
    expect(fs.existsSync(lockPath)).to.be.false;

    const exited = spawnSync(process.execPath, ["-e", ""]).pid!;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: exited, host: os.hostname(), startedAt: 0 }));
    const takenOver = ProcessLock.acquire(dir);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8")).pid).to.equal(process.pid);

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: "some-other-host", startedAt: 0 }));
    takenOver.release();
    expect(fs.existsSync(lockPath), "a lock this process doesn't hold stays").to.be.true;
  });
});

describe("journaled transaction resolution", () => {
  const connection = (status: unknown, height: number) =>
    ({ getSignatureStatuses: async () => ({ value: [status] }), getBlockHeight: async () => height }) as unknown as Connection;

  it("waits well past the blockhash's last valid height before calling a missing transaction expired", async () => {
    expect(await resolveSignature(connection({ err: null, confirmationStatus: "confirmed" }, 0), "sig", 100)).to.equal("landed");
    expect(await resolveSignature(connection({ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }, 0), "sig", 100)).to.equal("failed");
    expect(await resolveSignature(connection({ err: null, confirmationStatus: "processed" }, 0), "sig", 100)).to.equal("pending");
    expect(await resolveSignature(connection(null, 200), "sig", 100)).to.equal("pending");
    expect(await resolveSignature(connection(null, 251), "sig", 100)).to.equal("expired");
  });
});

describe("Helius DAS holder source", () => {
  it("pages by cursor, keeps huge amounts exact, drops zero balances, and uses the lowest indexed slot", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const pages = [
      `{"jsonrpc":"2.0","result":{"last_indexed_slot":500,"cursor":"c1","token_accounts":[{"address":"b","owner":"${owner}","amount":9007199254740993},{"address":"z","owner":"${owner}","amount":0}]}}`,
      `{"jsonrpc":"2.0","result":{"last_indexed_slot":498,"cursor":"c2","token_accounts":[{"address":"a","owner":"${owner}","amount":5}]}}`,
      `{"jsonrpc":"2.0","result":{"last_indexed_slot":501,"token_accounts":[]}}`,
    ];
    const bodies: any[] = [];
    const fetchText: FetchText = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => pages[bodies.length - 1] };
    };
    const rows = await new HeliusDasSource("https://rpc.invalid", fetchText).fetch(Keypair.generate().publicKey);
    expect(rows.slot).to.equal(498);
    expect(rows.accounts.map((r) => [r.address, r.amount])).to.deep.equal([
      ["a", 5n],
      ["b", 9_007_199_254_740_993n],
    ]);
    expect(bodies[1].params.cursor).to.equal("c1");
    expect(bodies[2].params.cursor).to.equal("c2");
  });

  it("surfaces RPC errors, and refuses a holder list cut short by the page limit", async () => {
    const failing: FetchText = async () => ({ ok: true, status: 200, text: async () => '{"error":{"code":-32000,"message":"nope"}}' });
    const endless: FetchText = async () => ({
      ok: true,
      status: 200,
      text: async () => '{"result":{"last_indexed_slot":1,"cursor":"more","token_accounts":[{"address":"a","owner":"o","amount":1}]}}',
    });
    for (const [source, pattern] of [
      [new HeliusDasSource("https://rpc.invalid", failing), /nope/],
      [new HeliusDasSource("https://rpc.invalid", endless, 1_000, 3), /more than 3 pages/],
    ] as const) {
      try {
        await source.fetch(Keypair.generate().publicKey);
        expect.fail("should have thrown");
      } catch (err) {
        expect(String(err)).to.match(pattern);
      }
    }
  });
});

describe("artifact publishers", () => {
  function bundle(): string {
    const dir = temp("stonkfolio-bundle-");
    fs.writeFileSync(path.join(dir, "manifest.json"), '{"schemaVersion":1}');
    fs.writeFileSync(path.join(dir, "inputs.json"), "{}");
    return dir;
  }

  it("copies bundles into a local directory", async () => {
    const root = temp("stonkfolio-public-");
    await new LocalDirectoryPublisher(root, "dist1").publish(bundle(), 3n);
    expect(fs.readFileSync(path.join(root, "dist1", "3", "manifest.json"), "utf-8")).to.equal('{"schemaVersion":1}');
  });

  it("commits bundles to a git clone, pushes once per distinct bundle, and rebases over commits pushed from elsewhere", async function () {
    if (spawnSync("git", ["--version"]).status !== 0) this.skip();
    const remote = temp("stonkfolio-remote-");
    const clone = temp("stonkfolio-clone-");
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    };
    const identify = (cwd: string) => {
      git(cwd, "config", "user.name", "stonkfolio test");
      git(cwd, "config", "user.email", "test@stonkfolio.invalid");
    };
    git(remote, "init", "--bare", "-q");
    git(clone, "init", "-q", "-b", "main");
    identify(clone);
    git(clone, "remote", "add", "origin", remote);

    const publisher = new GitRepoPublisher(clone, "dist1", "origin");
    const dir = bundle();
    await publisher.publish(dir, 3n, "ab".repeat(32));
    await publisher.publish(dir, 3n, "ab".repeat(32)); // unchanged: no second commit
    expect(git(remote, "log", "--oneline", "main").trim().split("\n")).to.have.length(1);

    // Someone else pushes to the artifacts repository.
    const other = temp("stonkfolio-other-");
    git(other, "clone", "-q", "-b", "main", remote, ".");
    identify(other);
    fs.writeFileSync(path.join(other, "README.md"), "artifacts\n");
    git(other, "add", "README.md");
    git(other, "commit", "-q", "-m", "readme");
    git(other, "push", "-q", "origin", "main");

    await publisher.publish(dir, 4n, "cd".repeat(32));
    expect(git(remote, "log", "--oneline", "main").trim().split("\n")).to.have.length(3);
    expect(git(remote, "show", "main:rounds/dist1/4/manifest.json")).to.equal('{"schemaVersion":1}');
    expect(git(remote, "show", "main:README.md")).to.equal("artifacts\n");
  });
});

describe("vendored distributor IDL", () => {
  it("matches the freshly built IDL", function () {
    const built = path.join(process.cwd(), "target", "idl", "stonkfolio_distributor.json");
    if (!fs.existsSync(built)) this.skip();
    const vendored = path.join(process.cwd(), "keeper", "distributor", "idl.json");
    expect(JSON.parse(fs.readFileSync(vendored, "utf-8"))).to.deep.equal(JSON.parse(fs.readFileSync(built, "utf-8")));
  });
});
