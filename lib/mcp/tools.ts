import { z } from "zod";
import type { GitHubWriter } from "./github-write";

export type RepoRow = { id: number; fullName: string; kind: "demo" | "shadow"; installationId: string | null };
export type SearchRow = { number: number; title: string; body: string | null; state: string; cosine: number | null };
export type IssueRow = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string | null;
  labels: string[];
  createdAt: Date | null;
  closedAt: Date | null;
};
export type ReleaseRow = { tag: string; name: string | null; body: string | null; publishedAt: Date | null };

/** Read access to the snapshot tables; the Drizzle implementation lives in db-store.ts. */
export interface RepoStore {
  getRepo(fullName: string): Promise<RepoRow | null>;
  /** All issues of the repo; `cosine` is the similarity to `queryEmbedding` (null when either side has no vector). */
  issuesForSearch(repoId: number, queryEmbedding: number[] | null): Promise<SearchRow[]>;
  getIssue(repoId: number, number: number): Promise<IssueRow | null>;
  getFile(repoId: number, path: string): Promise<{ path: string; content: string } | null>;
  /** Files whose content contains `pattern` literally (case-insensitive). */
  filesContaining(repoId: number, pattern: string): Promise<Array<{ path: string; content: string }>>;
  listReleases(repoId: number, limit: number): Promise<ReleaseRow[]>;
}

export type ToolDeps = {
  store: RepoStore;
  /** Query embedding, or null when it cannot be computed (search then degrades to keyword ranking). */
  embedQuery: (text: string) => Promise<number[] | null>;
  writer: GitHubWriter;
};

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
export type Tool = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  run: (args: unknown) => Promise<ToolResult>;
};

const MAX_LINES = 300;
const MAX_HITS = 30;
const MAX_BODY_CHARS = 8000;

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (code: string, message: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: `${code}: ${message}` }],
});

const repoField = z.string().min(3).max(140).describe("Allowlisted repository, owner/name");

export function safePath(raw: string): string | null {
  if (raw.length === 0 || raw.length > 400) return null;
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) return null;
  const parts = raw.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) return null;
  return parts.join("/");
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "have", "not", "are", "but", "you", "can", "does", "how", "why", "when", "what"]);
const tokens = (q: string) => [...new Set(q.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3 && !STOP.has(t)))];

/** Fraction of query terms found, title hits weigh double. Range 0..1. */
export function keywordScore(terms: string[], title: string, body: string | null): number {
  if (terms.length === 0) return 0;
  const t = title.toLowerCase();
  const b = (body ?? "").toLowerCase();
  let s = 0;
  for (const term of terms) s += t.includes(term) ? 2 : b.includes(term) ? 1 : 0;
  return s / (2 * terms.length);
}

const KEYWORD_BOOST = 0.3;

export function buildTools(deps: ToolDeps): Tool[] {
  const { store } = deps;

  async function resolveRepo(name: string): Promise<RepoRow | ToolResult> {
    const repo = await store.getRepo(name);
    return repo ?? fail("repo_not_allowed", `${name} is not an allowlisted repository`);
  }
  const isResult = (x: RepoRow | ToolResult): x is ToolResult => "content" in x;

  function define<S extends z.ZodRawShape>(
    spec: {
      name: string;
      description: string;
      schema: S;
      write?: { destructive: boolean };
      title: string;
    },
    handler: (args: z.infer<z.ZodObject<S>>, repo: RepoRow) => Promise<ToolResult>,
  ): Tool {
    const parser = z.object(spec.schema);
    return {
      name: spec.name,
      description: spec.description,
      schema: spec.schema,
      annotations: {
        title: spec.title,
        readOnlyHint: !spec.write,
        destructiveHint: spec.write?.destructive ?? false,
        idempotentHint: !spec.write || spec.name === "add_labels",
        openWorldHint: false,
      },
      async run(raw) {
        const parsed = parser.safeParse(raw);
        if (!parsed.success) return fail("invalid_arguments", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        const args = parsed.data as { repo: string };
        const repo = await resolveRepo(args.repo);
        if (isResult(repo)) return repo;
        if (spec.write && (repo.kind !== "demo" || !repo.installationId)) {
          return fail("write_not_allowed", `${repo.fullName} does not accept writes`);
        }
        try {
          return await handler(parsed.data, repo);
        } catch (e) {
          if (spec.write) return fail("write_failed", e instanceof Error ? e.message.slice(0, 200) : "unknown error");
          throw e;
        }
      },
    };
  }

  const issueNumber = z.number().int().positive();

  return [
    define(
      {
        name: "search_issues",
        title: "Search issues",
        description:
          "Find issues in the repository that resemble a query (open and recently closed). Returns number, title, state, score and url. `ranking` says whether semantic similarity was available.",
        schema: { repo: repoField, query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(8).default(5) },
      },
      async ({ query, limit }, repo) => {
        const vector = await deps.embedQuery(query).catch(() => null);
        const rows = await store.issuesForSearch(repo.id, vector);
        const semantic = vector !== null && rows.some((r) => r.cosine !== null);
        const terms = tokens(query);
        const scored = rows.map((r) => {
          const kw = keywordScore(terms, r.title, r.body);
          const score = semantic ? Math.max(0, r.cosine ?? 0) + KEYWORD_BOOST * kw : kw;
          return { number: r.number, title: r.title, state: r.state, score: Math.round(score * 1000) / 1000, url: `https://github.com/${repo.fullName}/issues/${r.number}` };
        });
        scored.sort((a, b) => b.score - a.score || b.number - a.number);
        return ok({ ranking: semantic ? "semantic+keyword" : "keyword", results: scored.slice(0, limit) });
      },
    ),
    define(
      {
        name: "get_issue",
        title: "Get issue",
        description: "Fetch one issue from the snapshot: title, body, state, author, labels.",
        schema: { repo: repoField, number: issueNumber },
      },
      async ({ number }, repo) => {
        const i = await store.getIssue(repo.id, number);
        if (!i) return fail("not_found", `issue #${number} is not in the snapshot`);
        return ok({
          number: i.number,
          title: i.title,
          body: (i.body ?? "").slice(0, MAX_BODY_CHARS),
          state: i.state,
          author: i.author,
          labels: i.labels,
          created_at: i.createdAt?.toISOString() ?? null,
          closed_at: i.closedAt?.toISOString() ?? null,
          url: `https://github.com/${repo.fullName}/issues/${i.number}`,
        });
      },
    ),
    define(
      {
        name: "read_file",
        title: "Read file",
        description: "Read a file from the repository snapshot, at most 300 lines per call (1-based, inclusive).",
        schema: {
          repo: repoField,
          path: z.string().min(1).max(400),
          start_line: z.number().int().min(1).optional(),
          end_line: z.number().int().min(1).optional(),
        },
      },
      async ({ path, start_line, end_line }, repo) => {
        const clean = safePath(path);
        if (!clean) return fail("invalid_path", "path must be relative, without .. segments");
        const file = await store.getFile(repo.id, clean);
        if (!file) return fail("not_found", `${clean} is not in the snapshot`);
        const lines = file.content.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        const start = start_line ?? 1;
        const end = Math.min(end_line ?? start + MAX_LINES - 1, start + MAX_LINES - 1, lines.length);
        return ok({
          path: clean,
          start_line: start,
          end_line: Math.max(end, start - 1),
          total_lines: lines.length,
          content: lines.slice(start - 1, end).join("\n"),
        });
      },
    ),
    define(
      {
        name: "find_in_repo",
        title: "Find in repository",
        description: "Literal, case-insensitive text search across the repository snapshot. Returns up to 30 hits with path, line and text.",
        schema: { repo: repoField, pattern: z.string().min(2).max(200) },
      },
      async ({ pattern }, repo) => {
        const needle = pattern.toLowerCase();
        const files = await store.filesContaining(repo.id, pattern);
        const hits: Array<{ path: string; line: number; text: string }> = [];
        outer: for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
          const lines = f.content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              hits.push({ path: f.path, line: i + 1, text: lines[i].slice(0, 240) });
              if (hits.length >= MAX_HITS) break outer;
            }
          }
        }
        return ok({ hits, truncated: hits.length >= MAX_HITS });
      },
    ),
    define(
      {
        name: "list_releases",
        title: "List releases",
        description: "Most recent releases of the repository with their notes.",
        schema: { repo: repoField, limit: z.number().int().min(1).max(10).default(5) },
      },
      async ({ limit }, repo) => {
        const rows = await store.listReleases(repo.id, limit);
        return ok({
          releases: rows.map((r) => ({
            tag: r.tag,
            name: r.name,
            published_at: r.publishedAt?.toISOString() ?? null,
            body: (r.body ?? "").slice(0, 3000),
          })),
        });
      },
    ),
    define(
      {
        name: "add_labels",
        title: "Add labels",
        description: "Add labels to an issue. Only works on the demo repository.",
        schema: { repo: repoField, issue_number: issueNumber, labels: z.array(z.string().min(1).max(50)).min(1).max(10) },
        write: { destructive: false },
      },
      async ({ issue_number, labels }, repo) => {
        await deps.writer.addLabels(repo.fullName, issue_number, labels);
        return ok({ ok: true });
      },
    ),
    define(
      {
        name: "post_comment",
        title: "Post comment",
        description: "Post a comment on an issue. Only works on the demo repository.",
        schema: { repo: repoField, issue_number: issueNumber, body: z.string().min(1).max(6000) },
        write: { destructive: false },
      },
      async ({ issue_number, body }, repo) => {
        await deps.writer.postComment(repo.fullName, issue_number, body);
        return ok({ ok: true });
      },
    ),
    define(
      {
        name: "close_as_duplicate",
        title: "Close as duplicate",
        description: "Close an issue as a duplicate of another one. Only works on the demo repository.",
        schema: { repo: repoField, issue_number: issueNumber, duplicate_of: issueNumber },
        write: { destructive: true },
      },
      async ({ issue_number, duplicate_of }, repo) => {
        if (issue_number === duplicate_of) return fail("invalid_arguments", "an issue cannot duplicate itself");
        await deps.writer.closeAsDuplicate(repo.fullName, issue_number, duplicate_of);
        return ok({ ok: true });
      },
    ),
  ];
}
