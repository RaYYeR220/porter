import { and, cosineDistance, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { issues, releases, repos } from "../db/schema";
import type { RepoStore, SearchRow } from "./tools";

const SNIPPET_CHARS = 300;
const CANDIDATES = 50;

const like = (t: string) => "%" + t.replace(/[%_]/g, (c) => "\\" + c) + "%";

/** Mirror of keywordScore, evaluated in SQL: title hit = 2, body hit = 1, normalised to 0..1. */
function keywordExpr(terms: string[]) {
  if (terms.length === 0) return sql`0::float`;
  const parts = terms.map(
    (t) => sql`(case when ${issues.title} ilike ${like(t)} then 2 when coalesce(${issues.body}, '') ilike ${like(t)} then 1 else 0 end)`,
  );
  return sql`((${sql.join(parts, sql` + `)})::float / ${2 * terms.length})`;
}

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

    async issuesForSearch(repoId, queryEmbedding, terms) {
      const kw = keywordExpr(terms);
      const cols = {
        number: issues.number,
        title: issues.title,
        state: issues.state,
        snippet: sql<string>`left(coalesce(${issues.body}, ''), ${SNIPPET_CHARS})`,
        kw: sql<number>`${kw}`,
      };
      const out = new Map<number, SearchRow>();
      if (queryEmbedding) {
        const dist = cosineDistance(issues.embedding, queryEmbedding);
        const rows = await db()
          .select({ ...cols, cosine: sql<number>`1 - (${dist})` })
          .from(issues)
          .where(and(eq(issues.repoId, repoId), isNotNull(issues.embedding)))
          .orderBy(dist)
          .limit(CANDIDATES);
        for (const r of rows) out.set(r.number, { ...r, kw: Number(r.kw), cosine: Number(r.cosine) });
      }
      if (terms.length > 0) {
        const rows = await db()
          .select({ ...cols, cosine: queryEmbedding ? sql<number | null>`case when ${issues.embedding} is null then null else 1 - (${cosineDistance(issues.embedding, queryEmbedding)}) end` : sql<number | null>`null` })
          .from(issues)
          .where(and(eq(issues.repoId, repoId), sql`${kw} > 0`))
          .orderBy(desc(kw))
          .limit(CANDIDATES);
        for (const r of rows) {
          if (!out.has(r.number)) out.set(r.number, { ...r, kw: Number(r.kw), cosine: r.cosine === null ? null : Number(r.cosine) });
        }
      }
      return [...out.values()];
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

    async getFileLines(repoId, path, start, end) {
      const res = await db().execute(sql`
        select cardinality(a) - case when a[cardinality(a)] = '' then 1 else 0 end as total,
               to_jsonb(array(select left(l, 400) from unnest(a[${start}::int:${end}::int]) with ordinality as u(l, i) order by i)) as lines
        from (select string_to_array(content, chr(10)) as a from repo_files where repo_id = ${repoId} and path = ${path}) f`);
      const row = res.rows[0] as { total: number | null; lines: string[] } | undefined;
      return row ? { totalLines: Number(row.total ?? 0), lines: row.lines } : null;
    },

    async findLines(repoId, pattern, limit) {
      const res = await db().execute(sql`
        select f.path as path, t.n::int as line, left(t.line, 200) as text
        from repo_files f, regexp_split_to_table(f.content, chr(10)) with ordinality as t(line, n)
        where f.repo_id = ${repoId}
          and strpos(lower(f.content), ${pattern.toLowerCase()}) > 0
          and strpos(lower(t.line), ${pattern.toLowerCase()}) > 0
        order by f.path, t.n
        limit ${limit}`);
      return res.rows as Array<{ path: string; line: number; text: string }>;
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
