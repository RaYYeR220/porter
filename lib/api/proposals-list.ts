import { and, desc, eq, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { proposals, runs } from "../db/schema";
import { errorJson, safeJson } from "./common";
import { MAX_LIMIT } from "./runs";

export const PROPOSAL_STATUSES = ["pending", "executed", "rejected", "failed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** A proposal with the issue it belongs to. Who decided it is left out. */
export type ProposalListRow = {
  id: number;
  runId: string;
  repo: string;
  issueNumber: number | null;
  title: string | null;
  action: string;
  args: unknown;
  status: string;
  execution: unknown;
  createdAt: Date;
  decidedAt: Date | null;
};

export type ProposalListQuery = { repo: string; status: ProposalStatus; limit: number };

export interface ProposalsReadStore {
  list(q: ProposalListQuery): Promise<ProposalListRow[]>;
}

/** Proposals of one repository (compared case-insensitively, as the decision endpoint does), newest first. */
export function proposalsListQuery(d: Db, q: ProposalListQuery) {
  return d
    .select({
      id: proposals.id,
      runId: proposals.runId,
      repo: runs.repo,
      issueNumber: runs.issueNumber,
      title: runs.title,
      action: proposals.action,
      args: proposals.args,
      status: proposals.status,
      execution: proposals.execution,
      createdAt: proposals.createdAt,
      decidedAt: proposals.decidedAt,
    })
    .from(proposals)
    .innerJoin(runs, eq(runs.id, proposals.runId))
    .where(and(sql`lower(${runs.repo}) = lower(${q.repo})`, eq(proposals.status, q.status)))
    .orderBy(desc(proposals.id))
    .limit(q.limit);
}

export function drizzleProposalsReadStore(getDb = defaultDb): ProposalsReadStore {
  return {
    async list(q) {
      return proposalsListQuery(getDb(), q);
    },
  };
}

export type ProposalsListDeps = { store: ProposalsReadStore; demoRepo: string | null };

const isStatus = (v: string): v is ProposalStatus => (PROPOSAL_STATUSES as readonly string[]).includes(v);

/** GET /api/proposals?status=pending&limit= → the demo repository's proposals only. */
export async function handleProposalsList(req: Request, d: ProposalsListDeps): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "pending";
  if (!isStatus(status)) return errorJson(400, "invalid_request", "status must be pending, executed, rejected or failed");
  const rawLimit = url.searchParams.get("limit");
  const parsed = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed < 1) return errorJson(400, "invalid_request", "limit must be a positive integer");
  if (!d.demoRepo) return errorJson(503, "unavailable", "The demo repository is not configured yet.");
  const rows = await d.store.list({ repo: d.demoRepo, status, limit: Math.min(MAX_LIMIT, parsed) });
  return safeJson({ proposals: rows });
}
