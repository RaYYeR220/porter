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
