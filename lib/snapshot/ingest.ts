import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import type { Octokit } from "octokit";
import type { Embedder } from "./embed";
import { issueEmbeddingText, otariEmbedderFromEnv } from "./embed";

export const MAX_FILE_BYTES = 200 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".json", ".yaml", ".yml",
  ".toml", ".go", ".rs", ".java", ".kt", ".rb", ".sh", ".sql", ".css", ".html", ".cfg", ".ini", ".proto", ".graphql",
]);
const TEXT_BASENAMES = new Set(["LICENSE", "Dockerfile", "Makefile", "CODEOWNERS", "NOTICE"]);
const SKIP_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", ".git", ".next", ".venv", "venv", "__pycache__", "third_party",
  "site-packages", "coverage", ".tox", "target", ".idea", ".vscode",
]);
const SKIP_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Cargo.lock", "go.sum"]);

export type SnapshotFile = { path: string; content: string; sha: string | null };
export type SnapshotIssue = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  author: string | null;
  labels: string[];
  createdAt: string | null;
  closedAt: string | null;
};
export type SnapshotRelease = { tag: string; name: string | null; body: string | null; publishedAt: string | null };

export interface IngestStore {
  upsertRepo(fullName: string, kind: "demo" | "shadow"): Promise<number>;
  replaceFiles(repoId: number, files: SnapshotFile[]): Promise<void>;
  upsertIssues(repoId: number, issues: SnapshotIssue[]): Promise<void>;
  replaceReleases(repoId: number, releases: SnapshotRelease[]): Promise<void>;
  issuesMissingEmbedding(repoId: number, limit?: number): Promise<Array<{ id: number; title: string; body: string | null }>>;
  setEmbeddings(rows: Array<{ id: number; embedding: number[] }>): Promise<void>;
  markSnapshot(repoId: number): Promise<void>;
}

export function wantFile(path: string): boolean {
  const parts = path.split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return false;
  if (SKIP_NAMES.has(base) || base.endsWith(".min.js") || base.endsWith(".min.css")) return false;
  if (TEXT_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

/** Extracts allowlisted text files (200 KB max, valid UTF-8, no NUL bytes) from a gzipped GitHub tarball. */
export async function extractFiles(tarball: Buffer): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  const extract = tar.extract();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  extract.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    const slash = header.name.indexOf("/");
    const path = slash === -1 ? header.name : header.name.slice(slash + 1);
    const keep = header.type === "file" && path !== "" && (header.size ?? 0) <= MAX_FILE_BYTES && wantFile(path);
    stream.on("data", (c: unknown) => {
      if (keep) chunks.push(c as Buffer);
    });
    stream.on("end", () => {
      if (keep) {
        const buf = Buffer.concat(chunks);
        if (buf.length <= MAX_FILE_BYTES && !buf.includes(0)) {
          try {
            files.push({ path, content: decoder.decode(buf), sha: null });
          } catch {
            // not valid UTF-8: treat as binary
          }
        }
      }
      next();
    });
    stream.resume();
  });
  await new Promise<void>((resolve, reject) => {
    extract.on("finish", resolve);
    extract.on("error", reject);
    const gunzip = createGunzip();
    gunzip.on("error", reject);
    Readable.from([tarball]).pipe(gunzip).pipe(extract);
  });
  return files;
}

export type IngestSource = {
  tarballPath?: string;
  issuesJsonPath?: string;
  releasesJsonPath?: string;
  /** Cron path: an installation-scoped Octokit. */
  octokit?: Octokit;
};
export type IngestDeps = { store?: IngestStore; embed?: Embedder | null };
export type IngestResult = { files: number; issues: number; releases: number; embedded: number };

/** Embeds issues that have no vector yet and returns how many got one. Shared with scripts/embed-backfill.ts. */
export async function embedMissing(store: IngestStore, repoId: number, embed: Embedder, limit = 500): Promise<number> {
  const rows = await store.issuesMissingEmbedding(repoId, limit);
  if (rows.length === 0) return 0;
  const vectors = await embed(rows.map((r) => issueEmbeddingText(r.title, r.body)));
  const done: Array<{ id: number; embedding: number[] }> = [];
  rows.forEach((r, i) => {
    const v = vectors[i];
    if (v) done.push({ id: r.id, embedding: v });
  });
  if (done.length > 0) await store.setEmbeddings(done);
  return done.length;
}

export async function ingestRepo(
  fullName: string,
  kind: "demo" | "shadow",
  source: IngestSource,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const store = deps.store ?? (await import("./drizzle-store")).drizzleIngestStore();
  const embed = deps.embed === undefined ? otariEmbedderFromEnv() : deps.embed;

  let tarball: Buffer | null = null;
  let issues: SnapshotIssue[] = [];
  let releases: SnapshotRelease[] = [];
  if (source.tarballPath) tarball = await readFile(source.tarballPath);
  if (source.issuesJsonPath) issues = JSON.parse(await readFile(source.issuesJsonPath, "utf8")) as SnapshotIssue[];
  if (source.releasesJsonPath) releases = JSON.parse(await readFile(source.releasesJsonPath, "utf8")) as SnapshotRelease[];
  if (source.octokit) {
    const { fetchViaOctokit } = await import("./octokit-source");
    const got = await fetchViaOctokit(source.octokit, fullName);
    tarball = got.tarball;
    issues = got.issues;
    releases = got.releases;
  }

  const repoId = await store.upsertRepo(fullName, kind);
  const files = tarball ? await extractFiles(tarball) : [];
  if (tarball) await store.replaceFiles(repoId, files);
  await store.upsertIssues(repoId, issues);
  await store.replaceReleases(repoId, releases);
  const embedded = embed ? await embedMissing(store, repoId, embed) : 0;
  await store.markSnapshot(repoId);
  return { files: files.length, issues: issues.length, releases: releases.length, embedded };
}
