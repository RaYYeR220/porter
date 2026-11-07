import { sql } from "drizzle-orm";
import { db as defaultDb } from "./db/client";

/** Runs one SQL statement and returns its result. The default is the lazy Neon client. */
export type SqlRunner = (query: ReturnType<typeof sql>) => Promise<unknown>;

const defaultRunner: SqlRunner = (q) => defaultDb().execute(q);

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  const rows = (res as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/**
 * Fixed-window counter on the kv table. One atomic INSERT .. ON CONFLICT DO UPDATE, because the
 * Neon HTTP driver has no interactive transactions. The window start lives in the value, so a
 * stale row restarts at 1. Returns true while the caller is within `limit` for this window.
 * Rejected calls still count (the row only expires with its window).
 */
export async function ratelimit(
  key: string,
  limit: number,
  windowSec: number,
  run: SqlRunner = defaultRunner,
): Promise<boolean> {
  const res = await run(sql`
    INSERT INTO kv (key, value, expires_at, updated_at)
    VALUES (
      ${key},
      jsonb_build_object('start', floor(extract(epoch from now()))::bigint, 'count', 1),
      now() + make_interval(secs => ${windowSec}::double precision),
      now()
    )
    ON CONFLICT (key) DO UPDATE SET
      value = CASE
        WHEN (kv.value->>'start')::bigint + ${windowSec}::bigint <= floor(extract(epoch from now()))::bigint
          THEN jsonb_build_object('start', floor(extract(epoch from now()))::bigint, 'count', 1)
        ELSE jsonb_build_object('start', (kv.value->>'start')::bigint, 'count', (kv.value->>'count')::int + 1)
      END,
      expires_at = CASE
        WHEN (kv.value->>'start')::bigint + ${windowSec}::bigint <= floor(extract(epoch from now()))::bigint
          THEN now() + make_interval(secs => ${windowSec}::double precision)
        ELSE kv.expires_at
      END,
      updated_at = now()
    RETURNING (value->>'count')::int AS count
  `);
  const count = Number(rowsOf(res)[0]?.count);
  if (!Number.isFinite(count)) throw new Error("ratelimit: no count returned");
  return count <= limit;
}

export const WRITES_PER_HOUR = 20;
export const repoWriteKey = (repo: string) => `rl:gh-write:${repo.toLowerCase()}`;
