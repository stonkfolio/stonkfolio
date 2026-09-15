/**
 * Round artifact bundles: a set of text files plus a canonical manifest.json
 * listing each file's sha256. The sha256 of manifest.json is what a round
 * commits on-chain as `artifact_hash`, so publishing the bundle lets anyone
 * confirm they are looking at exactly what the keeper committed to. Hashes
 * are always over raw file bytes, so any sha256 tool gets the same answer.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { canonicalJson } from "./canonicalJson";

export const MANIFEST_FILE = "manifest.json";

export interface ArtifactFile {
  path: string;
  contents: string;
}

export interface Manifest {
  schemaVersion: number;
  meta: unknown;
  files: { path: string; sha256: string }[];
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertSafeRelativePath(filePath: string): void {
  const normalized = path.posix.normalize(filePath);
  if (
    filePath !== normalized ||
    filePath.includes("\\") ||
    path.posix.isAbsolute(filePath) ||
    normalized.split("/").includes("..") ||
    filePath === MANIFEST_FILE
  ) {
    throw new Error(`unsafe artifact path: ${filePath}`);
  }
}

export function buildManifest(meta: unknown, files: ArtifactFile[]): { manifest: string; manifestHash: Buffer } {
  const seen = new Set<string>();
  for (const file of files) {
    assertSafeRelativePath(file.path);
    if (seen.has(file.path)) throw new Error(`duplicate artifact path: ${file.path}`);
    seen.add(file.path);
  }
  const manifest = canonicalJson({
    schemaVersion: 1,
    meta,
    files: [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({ path: f.path, sha256: sha256Hex(Buffer.from(f.contents, "utf-8")) })),
  });
  return { manifest, manifestHash: createHash("sha256").update(Buffer.from(manifest, "utf-8")).digest() };
}

export function writeArtifacts(dir: string, meta: unknown, files: ArtifactFile[]): Buffer {
  const { manifest, manifestHash } = buildManifest(meta, files);
  for (const file of files) {
    const target = path.join(dir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.contents, "utf-8"));
  }
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), Buffer.from(manifest, "utf-8"));
  return manifestHash;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Reads a bundle and throws if any listed file is missing, isn't valid UTF-8, or doesn't match its hash. */
export function readArtifacts(dir: string): { manifest: Manifest; manifestHash: Buffer; files: Map<string, string> } {
  const manifestBytes = fs.readFileSync(path.join(dir, MANIFEST_FILE));
  const manifest = JSON.parse(strictUtf8.decode(manifestBytes)) as Manifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("unsupported manifest");
  const files = new Map<string, string>();
  for (const entry of manifest.files) {
    assertSafeRelativePath(entry.path);
    const target = path.join(dir, ...entry.path.split("/"));
    if (!fs.existsSync(target)) throw new Error(`artifact missing: ${entry.path}`);
    const bytes = fs.readFileSync(target);
    if (sha256Hex(bytes) !== entry.sha256) throw new Error(`artifact hash mismatch: ${entry.path}`);
    files.set(entry.path, strictUtf8.decode(bytes));
  }
  return { manifest, manifestHash: createHash("sha256").update(manifestBytes).digest(), files };
}
