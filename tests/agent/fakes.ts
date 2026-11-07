import type { Proposal, Recorder, RunFinish, RunStart, StepRecord } from "../../lib/agent/record";
import { OtariError } from "../../lib/otari/errors";
import type { CallOpts, ChatBody, ChatResponse, OtariMeta, OtariResult } from "../../lib/otari/types";

export const META: OtariMeta = {
  requestId: "req_1",
  model: "openai/gpt-oss-120b",
  provider: "deepinfra",
  fallback: false,
  attemptCount: 1,
  guardrails: null,
  endUserBudget: null,
  containerId: null,
  costUsd: 0.001,
  durationMs: 120,
};

/** A successful chat completion with `content`, extra top-level fields (otari_tool_calls) and meta overrides. */
export function ok(
  content: string | null,
  extra: Partial<ChatResponse> = {},
  meta: Partial<OtariMeta> = {},
): OtariResult<ChatResponse> {
  const m = { ...META, ...meta };
  return {
    data: {
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { cost_usd: m.costUsd ?? undefined },
      ...extra,
    },
    meta: m,
  };
}

export type Scripted = OtariResult<ChatResponse> | Error | ((body: ChatBody) => OtariResult<ChatResponse> | Error);

/** Fake Otari client: each chat() call consumes the next scripted result; an Error is thrown. */
export function scriptedOtari(script: Scripted[]) {
  const queue = [...script];
  const calls: { body: ChatBody; opts: CallOpts }[] = [];
  const otari = {
    async chat(body: ChatBody, opts: CallOpts = {}): Promise<OtariResult<ChatResponse>> {
      calls.push({ body, opts });
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected Otari call #${calls.length}`);
      const r = typeof next === "function" ? next(body) : next;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { otari, calls, remaining: () => queue.length };
}

export const guardrailError = (profile = "prompt-injection") =>
  new OtariError({
    kind: "guardrail_violation",
    status: 403,
    code: "guardrail_violation",
    guardrails: [{ profile, explanation: "deterministic: hidden_html_comment", score: 0.97 }],
  });

export const budgetError = (retryAfterSec: number | null = 5400, budgetScope = "user") =>
  new OtariError({ kind: "budget_exceeded", status: 403, code: "budget_exceeded", budgetScope, retryAfterSec });

export const fundsError = () => new OtariError({ kind: "insufficient_funds", status: 402, code: "insufficient_funds" });

export const upstreamError = () => new OtariError({ kind: "upstream", status: 502, code: null });

export const blockedError = () => new OtariError({ kind: "end_user_blocked", status: 403, code: "end_user_blocked" });

type RunRow = RunStart & Partial<RunFinish>;

/** In-memory Recorder with the same conflict rule as the runs table (unique deliveryId). */
export function memoryRecorder() {
  const runs = new Map<string, RunRow>();
  const steps: Array<StepRecord & { runId: string }> = [];
  const proposals: Array<Proposal & { runId: string; status: "pending" }> = [];
  const kv = new Map<string, { value: unknown; expiresAt: Date | null }>();

  const recorder: Recorder = {
    async createRun(row) {
      if (row.deliveryId && [...runs.values()].some((r) => r.deliveryId === row.deliveryId)) return { created: false };
      runs.set(row.id, { ...row });
      return { created: true };
    },
    async addStep(runId, step) {
      steps.push({ runId, ...step });
    },
    async finishRun(runId, fin) {
      const r = runs.get(runId);
      if (!r) throw new Error(`no run ${runId}`);
      Object.assign(r, fin);
    },
    async addProposals(runId, list) {
      for (const p of list) proposals.push({ runId, status: "pending", ...p });
    },
    async putKv(key, value, expiresAt) {
      kv.set(key, { value, expiresAt });
    },
  };
  return { recorder, runs, steps, proposals, kv };
}
