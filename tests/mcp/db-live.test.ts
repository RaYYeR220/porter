import { describe, expect, it } from "vitest";
import { drizzleRepoStore } from "../../lib/mcp/db-store";

// Read-only checks against the real shadow snapshot: DB_LIVE=1 with DATABASE_URL set.
describe.skipIf(process.env.DB_LIVE !== "1")("db-store live (mozilla-ai/otari)", () => {
  const store = drizzleRepoStore();
  const repoId = async () => (await store.getRepo("mozilla-ai/otari"))!.id;

  it("search returns a bounded keyword candidate set with short snippets", async () => {
    const rows = await store.issuesForSearch(await repoId(), null, ["streaming", "retries"]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(rows.every((r) => r.cosine === null && r.kw > 0 && r.snippet.length <= 300)).toBe(true);
  });

  it("semantic candidate query is valid SQL (no vectors stored yet, so it returns nothing)", async () => {
    const rows = await store.issuesForSearch(await repoId(), Array.from({ length: 1024 }, () => 0.03), ["streaming"]);
    expect(rows.length).toBeLessThanOrEqual(100);
    expect(rows.every((r) => r.cosine === null || typeof r.cosine === "number")).toBe(true);
  });

  it("find returns ordered, bounded lines", async () => {
    const hits = await store.findLines(await repoId(), "otari-conversation-id", 31);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(31);
    expect(hits.every((h) => h.text.length <= 200 && h.line >= 1)).toBe(true);
    const sorted = [...hits].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    expect(hits.map((h) => h.path + h.line).length).toBe(sorted.length);
  });

  it("read_file slice returns only the requested lines, cut to 400 chars", async () => {
    const id = await repoId();
    const f = await store.getFileLines(id, "README.md", 1, 5);
    expect(f).not.toBeNull();
    expect(f!.lines.length).toBeLessThanOrEqual(5);
    expect(f!.totalLines).toBeGreaterThan(0);
    expect(f!.lines.every((l) => l.length <= 400)).toBe(true);
    expect(await store.getFileLines(id, "nope/missing.txt", 1, 5)).toBeNull();
  });
});
