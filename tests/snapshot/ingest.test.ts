import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { describe, expect, it } from "vitest";
import { ingestRepo, type IngestStore } from "../../lib/snapshot/ingest";
import { batchEmbedder } from "../../lib/snapshot/embed";
import { OtariError } from "../../lib/otari/errors";

async function makeTarball(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((res) => pack.on("end", () => res()));
  pack.on("data", (c: unknown) => chunks.push(c as Buffer));
  for (const [name, body] of Object.entries(entries)) {
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    pack.entry({ name: `acme-widget-abc123/${name}` }, buf);
  }
  pack.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

function memStore() {
  const files = new Map<string, string>();
  const issues = new Map<number, { id: number; title: string; body: string | null; state: string; embedding: number[] | null }>();
  const releases: string[] = [];
  const store: IngestStore = {
    async upsertRepo() {
      return 1;
    },
    async replaceFiles(_r, rows) {
      files.clear();
      for (const f of rows) files.set(f.path, f.content);
    },
    async upsertIssues(_r, rows) {
      for (const i of rows) {
        const prev = issues.get(i.number);
        const same = prev && prev.title === i.title && prev.body === i.body;
        issues.set(i.number, {
          id: prev?.id ?? issues.size + 1,
          title: i.title,
          body: i.body,
          state: i.state,
          embedding: same ? prev.embedding : null,
        });
      }
    },
    async replaceReleases(_r, rows) {
      releases.length = 0;
      releases.push(...rows.map((r) => r.tag));
    },
    async issuesMissingEmbedding() {
      return [...issues.values()].filter((i) => !i.embedding).map((i) => ({ id: i.id, title: i.title, body: i.body }));
    },
    async setEmbeddings(rows) {
      for (const r of rows) for (const i of issues.values()) if (i.id === r.id) i.embedding = r.embedding;
    },
    async markSnapshot() {},
  };
  return { store, files, issues, releases };
}

const issuesJson = [
  { number: 1, title: "Streaming breaks on retry", body: "SSE stream stops", state: "open", author: "a", labels: ["bug"], createdAt: "2026-10-01T00:00:00Z", closedAt: null },
  { number: 2, title: "Add embeddings docs", body: null, state: "closed", author: "b", labels: [], createdAt: "2026-09-01T00:00:00Z", closedAt: "2026-09-05T00:00:00Z" },
];
const releasesJson = [{ tag: "v1.0.0", name: "One", body: "first", publishedAt: "2026-08-01T00:00:00Z" }];

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "porter-ingest-"));
  const tarballPath = join(dir, "repo.tgz");
  writeFileSync(
    tarballPath,
    await makeTarball({
      "README.md": "# Widget\nhello",
      "src/app.ts": "export const a = 1;\n",
      "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
      "data.json": Buffer.from([0x7b, 0, 0x7d]),
      "node_modules/dep/index.js": "module.exports = 1",
      "vendor/x.py": "print(1)",
      "big.md": "x".repeat(200 * 1024 + 1),
      "notes.xyz": "unknown extension",
      "pnpm-lock.yaml": "lock: true",
    }),
  );
  const issuesJsonPath = join(dir, "issues.json");
  writeFileSync(issuesJsonPath, JSON.stringify(issuesJson));
  const releasesJsonPath = join(dir, "releases.json");
  writeFileSync(releasesJsonPath, JSON.stringify(releasesJson));
  return { tarballPath, issuesJsonPath, releasesJsonPath };
}

const vec = (dims: number, hot: number) => Array.from({ length: dims }, (_, i) => (i === hot ? 3 : 1));

describe("ingestRepo", () => {
  it("stores text files, issues and releases and skips binary/vendored/oversize files", async () => {
    const m = memStore();
    const src = await fixture();
    const out = await ingestRepo("acme/widget", "shadow", src, { store: m.store, embed: async (t) => t.map(() => null) });
    expect([...m.files.keys()].sort()).toEqual(["README.md", "src/app.ts"]);
    expect(out).toMatchObject({ files: 2, issues: 2, releases: 1 });
    expect(m.releases).toEqual(["v1.0.0"]);
  });

  it("stores issues with NULL embeddings when embedding fails", async () => {
    const m = memStore();
    const src = await fixture();
    const embed = batchEmbedder({
      embed: async () => {
        throw new OtariError({ kind: "insufficient_funds", status: 402 });
      },
    });
    const out = await ingestRepo("acme/widget", "shadow", src, { store: m.store, embed });
    expect(out.issues).toBe(2);
    expect(out.embedded).toBe(0);
    expect([...m.issues.values()].every((i) => i.embedding === null)).toBe(true);
  });

  it("stores normalised 1024-dim embeddings when the embedder works", async () => {
    const m = memStore();
    const src = await fixture();
    const embed = batchEmbedder({ embed: async (inputs: string[]) => inputs.map((_, i) => vec(4096, i)) });
    const out = await ingestRepo("acme/widget", "shadow", src, { store: m.store, embed });
    expect(out.embedded).toBe(2);
    for (const i of m.issues.values()) {
      expect(i.embedding).toHaveLength(1024);
      expect(Math.sqrt(i.embedding!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    }
  });
});

describe("batchEmbedder", () => {
  it("calls the client with at most 32 inputs per request", async () => {
    const sizes: number[] = [];
    const embed = batchEmbedder({
      embed: async (inputs: string[]) => {
        sizes.push(inputs.length);
        return inputs.map(() => vec(1024, 0));
      },
    });
    const out = await embed(Array.from({ length: 70 }, (_, i) => `t${i}`));
    expect(sizes).toEqual([32, 32, 6]);
    expect(out.every((v) => v !== null)).toBe(true);
  });

  it("stops calling after insufficient_funds", async () => {
    let calls = 0;
    const embed = batchEmbedder({
      embed: async () => {
        calls++;
        throw new OtariError({ kind: "insufficient_funds", status: 402 });
      },
    });
    const out = await embed(Array.from({ length: 70 }, () => "t"));
    expect(calls).toBe(1);
    expect(out.every((v) => v === null)).toBe(true);
  });
});
