import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface LockHolder {
  pid: number;
  host: string;
  startedAt: number;
}

/** A lock file nobody could parse is only treated as abandoned once it's this old (a writer may be mid-write). */
const UNREADABLE_LOCK_GRACE_MS = 60_000;

function readHolder(lockPath: string): LockHolder | "unreadable" | undefined {
  let text: string;
  try {
    text = fs.readFileSync(lockPath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const holder = JSON.parse(text) as LockHolder;
    return Number.isInteger(holder.pid) && typeof holder.host === "string" ? holder : "unreadable";
  } catch {
    return "unreadable";
  }
}

function isAlive(holder: LockHolder): boolean {
  if (holder.host !== os.hostname()) return true; // can't check another machine's processes
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

/**
 * One keeper per state directory for the life of the process. Two keepers on
 * the same state would double-claim fees, lose ledger updates and spend
 * buckets twice. A lock left by a process that no longer exists is taken over;
 * a live holder's lock is never removed.
 */
export class ProcessLock {
  private constructor(readonly path: string) {}

  static acquire(stateDir: string): ProcessLock {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(stateDir, "keeper.lock");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const holder: LockHolder = { pid: process.pid, host: os.hostname(), startedAt: Date.now() };
        fs.writeFileSync(lockPath, JSON.stringify(holder), { flag: "wx", mode: 0o600 });
        return new ProcessLock(lockPath);
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
      }
      const holder = readHolder(lockPath);
      if (holder === "unreadable") {
        if (Date.now() - fs.statSync(lockPath).mtimeMs < UNREADABLE_LOCK_GRACE_MS) {
          throw new Error(`${lockPath} is being written by another keeper`);
        }
      } else if (holder && isAlive(holder)) {
        throw new Error(`another keeper (pid ${holder.pid} on ${holder.host}) holds ${lockPath}`);
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (err: any) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    throw new Error(`could not acquire ${lockPath}`);
  }

  /** Removes the lock only if this process still holds it. */
  release(): void {
    const holder = readHolder(this.path);
    if (holder && holder !== "unreadable" && holder.pid === process.pid && holder.host === os.hostname()) {
      fs.unlinkSync(this.path);
    }
  }
}
