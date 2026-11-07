import { and, cosineDistance, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { issues, releases, repoFiles, repos } from "../db/schema";
import type { RepoStore } from "./tools";

const SEARCH_BODY_CHARS = 2000;
const MAX_FILES_PER_SEARCH = 60;

export function drizzleRepoStore(): RepoStore {
  return {
    async getRepo(fullName) {
      const [row] = await db()
        .select({ id: repos.id, fullName: repos.fullName, kind: repos.kind, installationId: repos.installationId })
        .from(repos)
        .where(eq(repos.fullName, fullName))
        .limit(1);
      return row ?? null;
    },

    async issuesForSearch(repoId, queryEmbedding) {
      const cosine = queryEmbedding
        ? sql<number | null>`case when ${issues.embedding} is null then null else 1 - (${cosineDistance(issues.embedding, queryEmbedding)}) end`
        : sql<number | null>`null`;
      return db()
        .select({
          number: issues.number,
          title: issues.title,
          body: sql<string | null>`left(${issues.body}, ${SEARCH_BODY_CHARS})`,
          state: issues.state,
          cosine,
        })
        .from(issues)
        .where(eq(issues.repoId, repoId));
    },

    async getIssue(repoId, number) {
      const [row] = await db()
        .select({
          number: issues.number,
          title: issues.title,
          body: issues.body,
          state: issues.state,
          author: issues.author,
          labels: issues.labels,
          createdAt: issues.createdAt,
          closedAt: issues.closedAt,
        })
        .from(issues)
        .where(and(eq(issues.repoId, repoId), eq(issues.number, number)))
        .limit(1);
      return row ?? null;
    },

    async getFile(repoId, path) {
      const [row] = await db()
        .select({ path: repoFiles.path, content: repoFiles.content })
        .from(repoFiles)
        .where(and(eq(repoFiles.repoId, repoId), eq(repoFiles.path, path)))
        .limit(1);
      return row ?? null;
    },

    async filesContaining(repoId, pattern) {
      return db()
        .select({ path: repoFiles.path, content: repoFiles.content })
        .from(repoFiles)
        .where(and(eq(repoFiles.repoId, repoId), sql`strpos(lower(${repoFiles.content}), ${pattern.toLowerCase()}) > 0`))
        .limit(MAX_FILES_PER_SEARCH);
    },

    async listReleases(repoId, limit) {
      return db()
        .select({ tag: releases.tag, name: releases.name, body: releases.body, publishedAt: releases.publishedAt })
        .from(releases)
        .where(eq(releases.repoId, repoId))
        .orderBy(desc(releases.publishedAt))
        .limit(limit);
    },
  };
}
