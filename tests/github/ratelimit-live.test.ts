import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db/client";
import { kv } from "../../lib/db/schema";
import { ratelimit } from "../../lib/ratelimit";

// Runs the real SQL on Neon: DB_LIVE=1 with DATABASE_URL set.
describe.skipIf(process.env.DB_LIVE !== "1")("ratelimit live", () => {
  const key = `rl:test:${randomUUID()}`;
  afterAll(async () => {
    await db().delete(kv).where(eq(kv.key, key));
  });

  it("allows `limit` calls, denies the next, and resets after the window", async () => {
    const limit = 3;
    const windowSec = 2;
    const results: boolean[] = [];
    for (let i = 0; i < limit + 2; i++) results.push(await ratelimit(key, limit, windowSec));
    expect(results).toEqual([true, true, true, false, false]);
    const [row] = await db().select().from(kv).where(eq(kv.key, key));
    expect(row.expiresAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 3100));
    expect(await ratelimit(key, limit, windowSec)).toBe(true);
  }, 30_000);
});
