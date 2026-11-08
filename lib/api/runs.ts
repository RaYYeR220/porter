import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
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

/** What the console needs from a run's steps and proposals, computed in the list query itself. */
export type RunListFacts = {
  /** The model Otari served for the run's triage call, or null when none was served. */
  servedModel: string | null;
  /** Proposals of this run still waiting for a maintainer. */
  pendingProposals: number;
  /** For a held run: whether the gateway held it or Porter's output check did. Null otherwise. */
  heldBy: "gateway" | "output" | null;
};

export type RunListItem = RunListRow & RunListFacts;

export type RunListQuery = { source?: string; status?: string; limit: number; before?: { at: string; id: string } };

export type RunDetail = {
  run: RunListRow & { body: string | null; reply: string | null; triage: unknown };
  steps: Array<Record<string, unknown>>;
  guardVerdicts: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
};

export interface RunsReadStore {
  list(q: RunListQuery): Promise<RunListItem[]>;
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

/**
 * The list in one statement: a lateral aggregate over each run's steps (indexed by run id) gives the
 * triage model and how a hold happened, and a grouped count of pending proposals is joined on.
 * Step bodies (guardrails, tool calls) never leave the database here.
 */
export function runsListQuery(d: Db, q: RunListQuery) {
  const conds: SQL[] = [];
  if (q.source) conds.push(eq(runs.source, q.source as (typeof RUN_SOURCES)[number]));
  if (q.status) conds.push(eq(runs.status, q.status));
  if (q.before) {
    conds.push(sql`(${runs.createdAt}, ${runs.id}) < (${q.before.at}::timestamptz, ${q.before.id}::uuid)`);
  }
  const facts = d
    .select({
      servedModel: sql<string | null>`(array_agg(${steps.servedModel} order by ${steps.id}) filter (where ${steps.role} = 'triage' and ${steps.servedModel} is not null))[1]`.as(
        "served_model",
      ),
      gatewayHold: sql<boolean>`coalesce(bool_or(${steps.errorKind} = 'guardrail_violation'), false)`.as("gateway_hold"),
      outputHold: sql<boolean>`coalesce(bool_or(${steps.role} = 'output_check' and ${steps.errorKind} = 'output_blocked'), false)`.as("output_hold"),
    })
    .from(steps)
    .where(eq(steps.runId, runs.id))
    .as("run_facts");
  const pending = d
    .select({ runId: proposals.runId, n: sql<number>`count(*)::int`.as("pending_n") })
    .from(proposals)
    .where(eq(proposals.status, "pending"))
    .groupBy(proposals.runId)
    .as("pending_proposals");
  return d
    .select({
      ...listCols,
      servedModel: facts.servedModel,
      pendingProposals: sql<number>`coalesce(${pending.n}, 0)`.mapWith(Number),
      heldBy: sql<"gateway" | "output" | null>`case when ${runs.status} = 'held_guardrail' then case when ${facts.gatewayHold} then 'gateway' when ${facts.outputHold} then 'output' end end`,
    })
    .from(runs)
    .leftJoinLateral(facts, sql`true`)
    .leftJoin(pending, eq(pending.runId, runs.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(q.limit);
}

export function drizzleRunsStore(getDb = defaultDb): RunsReadStore {
  return {
    async list(q) {
      return runsListQuery(getDb(), q);
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
