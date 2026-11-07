import { and, desc, eq } from "drizzle-orm";
import { db } from "../lib/db/client";
import { issues, releases, repos } from "../lib/db/schema";
import { SHADOW_REPO } from "../lib/shadow";
import type { ReleaseRow, SnapshotIssue } from "../lib/shadow";

/** Read-only view of the stored snapshot of the shadow repo. No GitHub call. */
export async function loadSnapshot(): Promise<{ snapshotAt: Date | null; issues: Array<SnapshotIssue & { state: string }>; releases: ReleaseRow[] }> {
  const d = db();
  const [repo] = await d.select().from(repos).where(and(eq(repos.fullName, SHADOW_REPO), eq(repos.kind, "shadow"))).limit(1);
  if (!repo) throw new Error(`${SHADOW_REPO} is not in the snapshot (run: pnpm snapshot ${SHADOW_REPO} shadow)`);
  const rows = await d
    .select({
      number: issues.number,
      title: issues.title,
      body: issues.body,
      state: issues.state,
      author: issues.author,
      labels: issues.labels,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(eq(issues.repoId, repo.id));
  const rel = await d
    .select({ tag: releases.tag, name: releases.name, body: releases.body })
    .from(releases)
    .where(eq(releases.repoId, repo.id))
    .orderBy(desc(releases.publishedAt));
  return { snapshotAt: repo.snapshotAt, issues: rows, releases: rel };
}

/** GitHub spells the open state "open" or "OPEN" depending on the API; the snapshot keeps what it was given. */
export const isOpen = (state: string) => state.toLowerCase() === "open";
