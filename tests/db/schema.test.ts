import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../lib/db/client";
import { issues, repos, runs } from "../../lib/db/schema";
import { toStoredEmbedding } from "../../lib/db/vector";

const live = process.env.DB_LIVE === "1";

function unit(i: number): number[] {
  const v = new Array(1024).fill(0);
  v[i] = 1;
  return toStoredEmbedding(v);
}

describe.skipIf(!live)("schema (live Neon)", () => {
  const fullName = `test/${randomBytes(6).toString("hex")}`;
  const deliveryId = `test-${randomBytes(6).toString("hex")}`;
  let repoId: number;

  beforeAll(() => {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  });

  afterAll(async () => {
    const d = db();
    await d.delete(runs).where(eq(runs.deliveryId, deliveryId));
    await d.delete(repos).where(eq(repos.fullName, fullName)); // cascades to issues
  });

  it("orders issues by cosine distance", async () => {
    const d = db();
    const [repo] = await d.insert(repos).values({ fullName, kind: "demo" }).returning();
    repoId = repo.id;
    await d.insert(issues).values([
      { repoId, number: 1, title: "far", state: "open", embedding: unit(5) },
      { repoId, number: 2, title: "near", state: "open", embedding: unit(0) },
    ]);
    const q = `[${unit(0).join(",")}]`;
    const rows = await d
      .select({ number: issues.number })
      .from(issues)
      .where(eq(issues.repoId, repoId))
      .orderBy(sql`${issues.embedding} <=> ${q}::vector`);
    expect(rows.map((r) => r.number)).toEqual([2, 1]);
  });

  it("rejects a duplicate (repoId, number)", async () => {
    await expect(
      db().insert(issues).values({ repoId, number: 1, title: "dup", state: "open" }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate runs.deliveryId", async () => {
    const d = db();
    const row = { source: "github" as const, arm: "porter" as const, repo: fullName, issueNumber: 1, deliveryId, status: "queued" };
    await d.insert(runs).values(row);
    await expect(d.insert(runs).values(row)).rejects.toThrow();
  });
});
