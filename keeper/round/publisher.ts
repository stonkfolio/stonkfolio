/** Where a round's artifact bundle goes public before the round is committed. */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface ArtifactPublisher {
  publish(bundleDir: string, roundId: bigint, manifestHashHex: string): Promise<void>;
}

/** Copies bundles into a directory (served statically, or synced elsewhere). */
export class LocalDirectoryPublisher implements ArtifactPublisher {
  constructor(private readonly root: string, private readonly distributor: string) {}

  async publish(bundleDir: string, roundId: bigint): Promise<void> {
    const target = path.join(this.root, this.distributor, roundId.toString());
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(bundleDir, target, { recursive: true });
  }
}

/**
 * Commits bundles into a local clone of a public artifacts repository and,
 * when a remote is given, pushes. The clone's own git config supplies the
 * commit identity and credentials. Anything pushed to the remote from
 * elsewhere is rebased under the new commit, so an unrelated push can't stall
 * publishing.
 */
export class GitRepoPublisher implements ArtifactPublisher {
  constructor(
    private readonly repoDir: string,
    private readonly distributor: string,
    private readonly remote?: string
  ) {}

  private git(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync("git", args, { cwd: this.repoDir, encoding: "utf-8" });
    if (result.error) throw result.error;
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }

  private gitOrThrow(args: string[]): string {
    const result = this.git(args);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  /** Rebases onto the remote branch if it exists yet. */
  private syncWithRemote(branch: string): void {
    if (!this.remote) return;
    if (this.git(["ls-remote", "--exit-code", "--heads", this.remote, branch]).status !== 0) return;
    this.gitOrThrow(["pull", "--rebase", "--quiet", this.remote, branch]);
  }

  async publish(bundleDir: string, roundId: bigint, manifestHashHex: string): Promise<void> {
    // symbolic-ref also works before the clone's first commit.
    const head = this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head.status !== 0) throw new Error(`artifacts clone ${this.repoDir} is on a detached HEAD`);
    const branch = head.stdout.trim();
    this.syncWithRemote(branch);

    const relative = ["rounds", this.distributor, roundId.toString()];
    const target = path.join(this.repoDir, ...relative);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(bundleDir, target, { recursive: true });

    this.gitOrThrow(["add", "--all", "--", relative.join("/")]);
    // exit 1 means staged changes exist; 0 means this exact bundle is already committed
    if (this.git(["diff", "--cached", "--quiet"]).status !== 0) {
      this.gitOrThrow(["commit", "-m", `round ${roundId} of ${this.distributor}: artifact hash ${manifestHashHex}`]);
    }
    if (!this.remote) return;
    if (this.git(["push", this.remote, `HEAD:${branch}`]).status !== 0) {
      // Someone pushed in between: rebase once more and retry.
      this.syncWithRemote(branch);
      this.gitOrThrow(["push", this.remote, `HEAD:${branch}`]);
    }
  }
}
