import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import { db as defaultDb } from "../db/client";
import { guardVerdicts, proposals, runs, steps } from "../db/schema";
import type { KvStore } from "../kv";
import { reviewKey } from "../agent/pipeline";
import { errorJson, safeJson, stripSecretFields } from "./common";

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
};

export type RunDetail = {
  run: RunListRow & { body: string | null; reply: string | null; triage: unknown };
  steps: Array<Record<string, unknown>>;
  guardVerdicts: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
};

export interface RunsReadStore {
  list(q: { source?: string; status?: string; limit: number; before?: { at: Date; id: string } }): Promise<RunListRow[]>;
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
};

export function drizzleRunsStore(getDb = defaultDb): RunsReadStore {
  return {
    async list(q) {
      const conds: SQL[] = [];
      if (q.source) conds.push(eq(runs.source, q.source as (typeof RUN_SOURCES)[number]));
      if (q.status) conds.push(eq(runs.status, q.status));
      if (q.before) {
        const c = or(lt(runs.createdAt, q.before.at), and(eq(runs.createdAt, q.before.at), sql`${runs.id} < ${q.before.id}`));
        if (c) conds.push(c);
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

export const encodeCursor = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");

export function decodeCursor(c: string): { at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(c, "base64url").toString("utf8").split("|");
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) || !UUID_RE.test(id ?? "") ? null : { at, id };
  } catch {
    return null;
  }
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
  return safeJson({ runs: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null });
}

/** GET /api/runs/:id → run, steps, guard verdicts, proposals, and the queue flags. */
export async function handleRunGet(id: string, store: RunsReadStore, kv: KvStore): Promise<Response> {
  if (!UUID_RE.test(id)) return errorJson(404, "not_found");
  const detail = await store.get(id);
  if (!detail) return errorJson(404, "not_found");
  const [queued, review] = await Promise.all([kv.get(`queued_reply:${id}`), kv.get(reviewKey(id))]);
  return safeJson({
    run: detail.run,
    steps: stripSecretFields(detail.steps),
    guardVerdicts: detail.guardVerdicts,
    proposals: detail.proposals,
    queued: queued !== null,
    reviewItem: review !== null,
  });
}
