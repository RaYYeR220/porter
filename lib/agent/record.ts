import { eq } from "drizzle-orm";
import { after } from "next/server";
import type { GuardLog } from "porter-guard";
import type { Db } from "../db/client";
import { guardVerdicts, kv, proposals, runs, steps } from "../db/schema";
import { parseRunMarker } from "./prompts";
import { cut, pgJson, pgText } from "./text";

/** One row per Otari call (failed ones included), plus Porter's own checks (output check, warnings). */
export type StepRecord = {
  role: string;
  requestedModel: string | null;
  servedModel: string | null;
  provider: string | null;
  fallback: boolean;
  attemptCount: number | null;
  requestId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  guardrails: unknown;
  toolCalls: unknown;
  errorKind: string | null;
  errorStatus: number | null;
};

export type RunStart = {
  id: string;
  source: "github" | "web" | "eval" | "shadow";
  arm: "porter" | "baseline";
  repo: string;
  issueNumber: number | null;
  deliveryId: string | null;
  authorExternalId: string;
  title: string;
  body: string;
  status: string;
};

export type RunFinish = {
  status: string;
  reply: string | null;
  triage: unknown;
  totalCostUsd: number;
  finishedAt: Date;
};

export type Proposal = { action: "add_labels" | "close_as_duplicate"; args: Record<string, unknown> };

/** The pipeline's only window on storage, so tests can run it in memory. */
export interface Recorder {
  /** `created: false` when the delivery id already has a run (webhook redelivery). */
  createRun(row: RunStart): Promise<{ created: boolean }>;
  addStep(runId: string, step: StepRecord): Promise<void>;
  finishRun(runId: string, fin: RunFinish): Promise<void>;
  addProposals(runId: string, list: Proposal[]): Promise<void>;
  putKv(key: string, value: unknown, expiresAt: Date | null): Promise<void>;
}

const int = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n));

export function createDbRecorder(d: Db): Recorder {
  return {
    async createRun(row) {
      const inserted = await d
        .insert(runs)
        .values({
          id: row.id,
          source: row.source,
          arm: row.arm,
          repo: row.repo,
          issueNumber: row.issueNumber,
          deliveryId: row.deliveryId,
          authorExternalId: pgText(row.authorExternalId),
          title: pgText(row.title),
          body: pgText(row.body),
          status: row.status,
        })
        .onConflictDoNothing({ target: runs.deliveryId })
        .returning({ id: runs.id });
      return { created: inserted.length > 0 };
    },

    async addStep(runId, s) {
      await d.insert(steps).values({
        runId,
        role: s.role,
        requestedModel: s.requestedModel,
        servedModel: s.servedModel,
        provider: s.provider,
        fallback: s.fallback,
        attemptCount: int(s.attemptCount),
        requestId: s.requestId,
        costUsd: s.costUsd,
        durationMs: int(s.durationMs),
        guardrails: pgJson(s.guardrails ?? null),
        toolCalls: pgJson(s.toolCalls ?? null),
        errorKind: s.errorKind,
        errorStatus: s.errorStatus,
      });
    },

    async finishRun(runId, f) {
      await d
        .update(runs)
        .set({
          status: f.status,
          reply: f.reply === null ? null : pgText(f.reply),
          triage: pgJson(f.triage ?? null),
          totalCostUsd: f.totalCostUsd,
          finishedAt: f.finishedAt,
        })
        .where(eq(runs.id, runId));
    },

    async addProposals(runId, list) {
      if (list.length === 0) return;
      await d.insert(proposals).values(list.map((p) => ({ runId, action: p.action, args: pgJson(p.args) as Record<string, unknown> })));
    },

    async putKv(key, value, expiresAt) {
      const v = pgJson(value);
      await d
        .insert(kv)
        .values({ key, value: v, expiresAt })
        .onConflictDoUpdate({ target: kv.key, set: { value: v, expiresAt, updatedAt: new Date() } });
    },
  };
}

export const TOOL_CALLS_MAX_BYTES = 32 * 1024;

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

function shrink(v: unknown, cap: number, depth = 0): unknown {
  if (typeof v === "string") return v.length > cap ? `${cut(v, cap)}…[${v.length - cap} chars cut]` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth >= 6) return "[nested]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => shrink(x, cap, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, cap, depth + 1)]));
}

/** `otari_tool_calls` for the trace, kept near 32 KB: long strings are cut first, then trailing entries dropped. */
export function truncateToolCalls(calls: unknown, maxBytes = TOOL_CALLS_MAX_BYTES): unknown[] | null {
  if (!Array.isArray(calls)) return null;
  if (bytes(calls) <= maxBytes) return calls;
  for (const cap of [4000, 1000, 200]) {
    const cutCalls = calls.map((c) => shrink(c, cap));
    if (bytes(cutCalls) <= maxBytes) return cutCalls;
  }
  // Keep the longest prefix that fits next to the marker; sizes are measured once per entry.
  const reserve = bytes({ type: "porter_truncated", dropped: calls.length }) + 2;
  const kept: unknown[] = [];
  let total = 2;
  for (const c of calls) {
    const s = shrink(c, 200);
    const b = bytes(s) + 1;
    if (total + b + reserve > maxBytes) break;
    kept.push(s);
    total += b;
  }
  return [...kept, { type: "porter_truncated", dropped: calls.length - kept.length }];
}

export function guardVerdictRow(log: GuardLog, runId: string | null = null) {
  return {
    runId,
    inputSha256: log.inputSha256,
    profile: log.profile,
    valid: log.valid,
    score: Number.isFinite(log.score) ? log.score : null,
    explanation: log.explanation,
    signals: log.signals,
    modelVerdicts: log.modelVerdicts,
    latencyMs: int(log.latencyMs),
  };
}

/**
 * Runs `task` after the response is sent (Next's after(), which Vercel keeps alive); outside a
 * request scope it just starts it. Failures are swallowed: logging must never affect a verdict.
 */
export function afterResponse(task: () => Promise<void>): void {
  const run = () =>
    task().catch((e: unknown) => {
      console.warn(`background write failed: ${e instanceof Error ? e.name : "error"}`);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

/** porter-guard's onVerdict hook: schedules a guard_verdicts insert and returns at once (ruling R1). */
export function guardVerdictLogger(getDb: () => Db, schedule: (task: () => Promise<void>) => void = afterResponse) {
  return async (log: GuardLog, rawInput?: string): Promise<void> => {
    const runId = rawInput === undefined ? null : parseRunMarker(rawInput);
    schedule(async () => {
      // The marker is only a label: a forged one can mislabel a row, never change a verdict. Its shape
      // is checked, not its existence (no read on the hot path); if the run is unknown the foreign key
      // rejects the insert and the row is stored unlinked instead.
      try {
        await getDb().insert(guardVerdicts).values(guardVerdictRow(log, runId));
      } catch (e) {
        if (runId === null) throw e;
        await getDb().insert(guardVerdicts).values(guardVerdictRow(log, null));
      }
    });
  };
}
