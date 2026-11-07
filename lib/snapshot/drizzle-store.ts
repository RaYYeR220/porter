import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { issues, releases, repoFiles, repos } from "../db/schema";
import type { IngestStore } from "./ingest";

const FILE_BATCH_BYTES = 2_000_000;
const ISSUE_BATCH = 50;
const toDate = (s: string | null) => (s ? new Date(s) : null);

export function drizzleIngestStore(): IngestStore {
  return {
    async upsertRepo(fullName, kind) {
      const [row] = await db()
        .insert(repos)
        .values({ fullName, kind })
        .onConflictDoUpdate({ target: repos.fullName, set: { kind } })
        .returning({ id: repos.id });
      return row.id;
    },

    async replaceFiles(repoId, files) {
      let batch: typeof files = [];
      let bytes = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        await db()
          .insert(repoFiles)
          .values(batch.map((f) => ({ repoId, path: f.path, content: f.content, sha: f.sha })))
          .onConflictDoUpdate({
            target: [repoFiles.repoId, repoFiles.path],
            set: { content: sql`excluded.content`, sha: sql`excluded.sha` },
          });
        batch = [];
        bytes = 0;
      };
      for (const f of files) {
        batch.push(f);
        bytes += f.content.length;
        if (bytes >= FILE_BATCH_BYTES) await flush();
      }
      await flush();
      const keep = files.map((f) => f.path);
      if (keep.length > 0) {
        await db().delete(repoFiles).where(and(eq(repoFiles.repoId, repoId), notInArray(repoFiles.path, keep)));
      }
    },

    async upsertIssues(repoId, rows) {
      for (let i = 0; i < rows.length; i += ISSUE_BATCH) {
        const slice = rows.slice(i, i + ISSUE_BATCH);
        await db()
          .insert(issues)
          .values(
            slice.map((r) => ({
              repoId,
              number: r.number,
              title: r.title,
              body: r.body,
              state: r.state,
              author: r.author,
              labels: r.labels,
              createdAt: toDate(r.createdAt),
              closedAt: toDate(r.closedAt),
            })),
          )
          .onConflictDoUpdate({
            target: [issues.repoId, issues.number],
            set: {
              // keep the stored vector only while the text it was computed from is unchanged
              embedding: sql`case when ${issues.title} = excluded.title and ${issues.body} is not distinct from excluded.body then ${issues.embedding} else null end`,
              title: sql`excluded.title`,
              body: sql`excluded.body`,
              state: sql`excluded.state`,
              author: sql`excluded.author`,
              labels: sql`excluded.labels`,
              createdAt: sql`excluded.created_at`,
              closedAt: sql`excluded.closed_at`,
            },
          });
      }
    },

    async replaceReleases(repoId, rows) {
      await db().delete(releases).where(eq(releases.repoId, repoId));
      if (rows.length === 0) return;
      await db()
        .insert(releases)
        .values(rows.map((r) => ({ repoId, tag: r.tag, name: r.name, body: r.body, publishedAt: toDate(r.publishedAt) })))
        .onConflictDoNothing();
    },

    async issuesMissingEmbedding(repoId, limit = 500) {
      return db()
        .select({ id: issues.id, title: issues.title, body: issues.body })
        .from(issues)
        .where(and(eq(issues.repoId, repoId), isNull(issues.embedding)))
        .limit(limit);
    },

    async setEmbeddings(rows) {
      for (const r of rows) {
        await db().update(issues).set({ embedding: r.embedding }).where(eq(issues.id, r.id));
      }
    },

    async markSnapshot(repoId) {
      await db().update(repos).set({ snapshotAt: new Date() }).where(eq(repos.id, repoId));
    },
  };
}
