import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../lib/db/client";
import { authors, kv, proposals, runs, steps } from "../lib/db/schema";

/**
 * Screenshot data for the app surfaces. Everything lives under a repository that does not exist
 * and four author ids that no real person has; the cleanup removes exactly these.
 */
export const SEED_REPO = "demo/porter-ui-seed";

export const SEED_AUTHORS = {
  wave: "web:5eed00000000a001",
  visitor: "web:5eed00000000a002",
  reporter: "gh:porter-ui-seed-reporter",
  blocked: "gh:porter-ui-seed-spammer",
} as const;

export const SEED_AUTHOR_IDS: string[] = Object.values(SEED_AUTHORS);

/** The host part of DATABASE_URL, or null when it is missing or not a URL. */
export function databaseHost(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).hostname || null;
  } catch {
    return null;
  }
}

export const CONSENT_FLAG = "--yes-write-to";

/**
 * Both scripts write to whatever DATABASE_URL points at, so they only run when the caller names that
 * host: `--yes-write-to <host>`. Anything else (no flag, another host, no DATABASE_URL) is a refusal.
 */
export function writeConsent(argv: string[], databaseUrl: string | undefined): { ok: true; host: string } | { ok: false; host: string | null; reason: string } {
  const host = databaseHost(databaseUrl);
  if (!host) return { ok: false, host: null, reason: "DATABASE_URL is missing or is not a URL" };
  const at = argv.indexOf(CONSENT_FLAG);
  const named = at >= 0 ? argv[at + 1]?.trim() : undefined;
  if (!named) return { ok: false, host, reason: `refusing to write: pass ${CONSENT_FLAG} ${host} to confirm the target` };
  if (named.toLowerCase() !== host.toLowerCase()) {
    return { ok: false, host, reason: `refusing to write: ${CONSENT_FLAG} names ${named}, but DATABASE_URL points at ${host}` };
  }
  return { ok: true, host };
}

/** Prints the target host first, then exits with code 2 unless the caller named it. */
export function requireWriteConsent(what: string, argv = process.argv.slice(2), databaseUrl = process.env.DATABASE_URL): string {
  const c = writeConsent(argv, databaseUrl);
  console.log(`${what}: target database host ${c.host ?? "(none)"}`);
  if (!c.ok) {
    console.error(c.reason);
    process.exit(2);
  }
  return c.host;
}

/** Deletes every seeded run (steps and proposals cascade), its kv flags, and the seeded authors. */
export async function cleanUiDemo(d: Db): Promise<{ runs: number; kv: number; authors: number }> {
  const seeded = await d.select({ id: runs.id }).from(runs).where(eq(runs.repo, SEED_REPO));
  const ids = seeded.map((r) => r.id);
  const keys = ids.flatMap((id) => [`review:${id}`, `queued_reply:${id}`]);
  const kvGone = keys.length ? await d.delete(kv).where(inArray(kv.key, keys)).returning({ key: kv.key }) : [];
  const runsGone = await d.delete(runs).where(eq(runs.repo, SEED_REPO)).returning({ id: runs.id });
  const authorsGone = await d.delete(authors).where(inArray(authors.externalId, SEED_AUTHOR_IDS)).returning({ id: authors.externalId });
  return { runs: runsGone.length, kv: kvGone.length, authors: authorsGone.length };
}

/** What is left of the seed: all zeros after a cleanup. */
export async function countUiDemo(d: Db): Promise<{ runs: number; steps: number; proposals: number; authors: number }> {
  const n = sql<number>`count(*)::int`;
  const [[r], [s], [p], [a]] = await Promise.all([
    d.select({ n }).from(runs).where(eq(runs.repo, SEED_REPO)),
    d.select({ n }).from(steps).innerJoin(runs, eq(runs.id, steps.runId)).where(eq(runs.repo, SEED_REPO)),
    d.select({ n }).from(proposals).innerJoin(runs, eq(runs.id, proposals.runId)).where(eq(runs.repo, SEED_REPO)),
    d.select({ n }).from(authors).where(inArray(authors.externalId, SEED_AUTHOR_IDS)),
  ]);
  return { runs: r.n, steps: s.n, proposals: p.n, authors: a.n };
}
