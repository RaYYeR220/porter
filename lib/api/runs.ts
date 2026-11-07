import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db as defaultDb } from "../db/client";
import { guardVerdicts, proposals, runs, steps } from "../db/schema";
import type { KvStore } from "../kv";
import { reviewKey } from "../agent/pipeline";
import { errorJson, safeJson } from "./common";

export const RUN_SOURCES = ["github", "web", "eval", "shadow"] as const;
export const MAX_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunListRow = {
  id: string;
  source: string;
  arm: string;
  repo: string;
  issueNumber: number | null;
  authorExternalId: string | null;
  title: string | null;
  status: string;
  totalCostUsd: number;
  createdAt: Date;
  finishedAt: Date | null;
  /** created_at as Postgres prints it (microseconds). Keyset cursor only; never sent to clients. */
  createdAtKey: string;
};

export type RunDetail = {
  run: RunListRow & { body: string | null; reply: string | null; triage: unknown };
  steps: Array<Record<string, unknown>>;
  guardVerdicts: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
};

export interface RunsReadStore {
  list(q: { source?: string; status?: string; limit: number; before?: { at: string; id: string } }): Promise<RunListRow[]>;
  get(id: string): Promise<RunDetail | null>;
}

const listCols = {
  id: runs.id,
  source: runs.source,
  arm: runs.arm,
  repo: runs.repo,
  issueNumber: runs.issueNumber,
  authorExternalId: runs.authorExternalId,
  title: runs.title,
  status: runs.status,
  totalCostUsd: runs.totalCostUsd,
  createdAt: runs.createdAt,
  finishedAt: runs.finishedAt,
  createdAtKey: sql<string>`${runs.createdAt}::text`,
};

export function drizzleRunsStore(getDb = defaultDb): RunsReadStore {
  return {
    async list(q) {
      const conds: SQL[] = [];
      if (q.source) conds.push(eq(runs.source, q.source as (typeof RUN_SOURCES)[number]));
      if (q.status) conds.push(eq(runs.status, q.status));
      if (q.before) {
        conds.push(sql`(${runs.createdAt}, ${runs.id}) < (${q.before.at}::timestamptz, ${q.before.id}::uuid)`);
      }
      return getDb()
        .select(listCols)
        .from(runs)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(q.limit);
    },
    async get(id) {
      const d = getDb();
      const [run] = await d.select({ ...listCols, body: runs.body, reply: runs.reply, triage: runs.triage }).from(runs).where(eq(runs.id, id)).limit(1);
      if (!run) return null;
      const [s, g, p] = await Promise.all([
        d.select().from(steps).where(eq(steps.runId, id)).orderBy(steps.id),
        d.select().from(guardVerdicts).where(eq(guardVerdicts.runId, id)).orderBy(guardVerdicts.id),
        d.select().from(proposals).where(eq(proposals.runId, id)).orderBy(proposals.id),
      ]);
      return { run, steps: s, guardVerdicts: g, proposals: p };
    },
  };
}

const TS_RE = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/;

export const encodeCursor = (createdAtKey: string, id: string) => Buffer.from(`${createdAtKey}|${id}`).toString("base64url");

export function decodeCursor(c: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(c, "base64url").toString("utf8").split("|");
    return TS_RE.test(at ?? "") && UUID_RE.test(id ?? "") ? { at, id } : null;
  } catch {
    return null;
  }
}

function publicRow<T extends { createdAtKey: string }>(r: T): Omit<T, "createdAtKey"> {
  const copy: Partial<T> = { ...r };
  delete copy.createdAtKey;
  return copy as Omit<T, "createdAtKey">;
}

/** GET /api/runs?source=&status=&limit=&cursor= */
export async function handleRunsList(req: Request, store: RunsReadStore): Promise<Response> {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  if (source !== undefined && !(RUN_SOURCES as readonly string[]).includes(source)) return errorJson(400, "invalid_request", "unknown source");
  if (status !== undefined && !/^[a-z_]{1,40}$/.test(status)) return errorJson(400, "invalid_request", "unknown status");
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) return errorJson(400, "invalid_request", "limit must be a positive integer");
  const limit = Math.min(MAX_LIMIT, parsedLimit);
  const cursor = url.searchParams.get("cursor");
  const before = cursor ? decodeCursor(cursor) : undefined;
  if (cursor && !before) return errorJson(400, "invalid_request", "bad cursor");

  const rows = await store.list({ source, status, limit: limit + 1, before: before ?? undefined });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return safeJson({
    runs: page.map(publicRow),
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAtKey, last.id) : null,
  });
}

/** GET /api/runs/:id → run, steps, guard verdicts, proposals, and the queue flags. */
export async function handleRunGet(id: string, store: RunsReadStore, kv: KvStore): Promise<Response> {
  if (!UUID_RE.test(id)) return errorJson(404, "not_found");
  const detail = await store.get(id);
  if (!detail) return errorJson(404, "not_found");
  const [queued, review] = await Promise.all([kv.get(`queued_reply:${id}`), kv.get(reviewKey(id))]);
  return safeJson({
    run: publicRow(detail.run),
    steps: detail.steps,
    guardVerdicts: detail.guardVerdicts,
    proposals: detail.proposals,
    queued: queued !== null,
    reviewItem: review !== null,
  });
}
