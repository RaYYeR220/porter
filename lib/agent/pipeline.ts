import { randomUUID } from "node:crypto";
import { db as defaultDb } from "../db/client";
import type { Db } from "../db/client";
import { getAgentEnv, getMcpServerId } from "../env";
import { createOtariClient } from "../otari/client";
import type { OtariClient } from "../otari/client";
import { OtariError } from "../otari/errors";
import type { GuardrailViolation, OtariErrorKind } from "../otari/errors";
import type { ChatBody, ChatResponse, OtariMeta } from "../otari/types";
import { checkOutput } from "./output-check";
import { createDbRecorder, truncateToolCalls } from "./record";
import type { Proposal, Recorder, StepRecord } from "./record";
import { fixedReply, UNVERIFIED_NOTE } from "./replies";
import { buildReproRequest, extractRepro, shouldRepro } from "./repro";
import type { ReproResult } from "./repro";
import { buildEvidenceBundle, buildReviewRequest, issueSeenInTools, parseReview } from "./review";
import { RUN_DEADLINE_MS, STEP_TIMEOUT_MS } from "./roles";
import type { Role } from "./roles";
import type { TriageResult } from "./schemas";
import { cut } from "./text";
import { buildTriageRequest, MAX_TITLE_CHARS, parseTriage } from "./triage";

export type { TriageResult } from "./schemas";

export type IssueInput = {
  source: "github" | "web" | "eval" | "shadow";
  arm: "porter" | "baseline";
  repo: string;
  number: number | null;
  title: string;
  body: string;
  authorExternalId: string;
  deliveryId?: string;
};

export type RunStatus = "answered" | "held_guardrail" | "refused_budget" | "refused_funds" | "blocked_author" | "failed";

export type RunOutcome = {
  runId: string;
  status: RunStatus;
  reply: string | null;
  proposals: Proposal[];
};

export type PipelineDeps = {
  otari: Pick<OtariClient, "chat">;
  /** Storage; defaults to a Drizzle recorder over `db` (itself defaulting to the lazy Neon client). */
  db?: Db;
  recorder?: Recorder;
  now?: () => Date;
  /** A run row created earlier with startRun (so /try can return the id at once). */
  runId?: string;
  /** Stored MCP server for the arm. undefined → read from env; null → none configured. */
  mcpServerId?: string | null;
  /** The repository's docs/homepage hosts, when known: allowed for web fetch and reply links. */
  docsHosts?: string[];
};

/** Console review queue: one kv item per held run. */
export const reviewKey = (runId: string) => `review:${runId}`;
/** Set on any 402; /try reads it to pause while funds look low. */
export const INSUFFICIENT_FUNDS_FLAG = "flag:insufficient_funds";
export const FUNDS_FLAG_TTL_MS = 10 * 60_000;

const MAX_STORED_BODY_CHARS = 65_536;
const MIN_CALL_MS = 5_000;
const MAX_LABELS = 5;

/** owner/name as GitHub spells them; "." and ".." are no names. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && repo.split("/").every((part) => part !== "." && part !== "..");
}

/**
 * Upstream codes that mean the request may already have been served (and billed): a client-side
 * timeout, or a 2xx whose body was not JSON. They are recorded under their own name, never retried.
 */
const SERVED_MAYBE = new Set(["timeout", "invalid_json"]);

export class DuplicateDeliveryError extends Error {
  constructor(readonly deliveryId: string) {
    super(`a run already exists for delivery ${deliveryId}`);
    this.name = "DuplicateDeliveryError";
  }
}

/** Client and MCP server for an arm: desk strangers key for porter, baseline key for baseline. */
export function armClient(arm: IssueInput["arm"]): { otari: OtariClient; mcpServerId: string | null } {
  const env = getAgentEnv(arm);
  return { otari: createOtariClient({ apiKey: env.apiKey, baseUrl: env.baseUrl }), mcpServerId: env.mcpServerId };
}

function recorderFor(deps: { db?: Db; recorder?: Recorder }): Recorder {
  return deps.recorder ?? createDbRecorder(deps.db ?? defaultDb());
}

/** Creates the run row (status "running") and returns its id. Throws DuplicateDeliveryError on redelivery. */
export async function startRun(input: IssueInput, deps: { db?: Db; recorder?: Recorder }): Promise<string> {
  const id = randomUUID();
  const { created } = await recorderFor(deps).createRun({
    id,
    source: input.source,
    arm: input.arm,
    repo: input.repo,
    issueNumber: input.number,
    deliveryId: input.deliveryId ?? null,
    authorExternalId: input.authorExternalId,
    title: cut(input.title, MAX_TITLE_CHARS),
    body: cut(input.body ?? "", MAX_STORED_BODY_CHARS),
    status: "running",
  });
  if (!created) throw new DuplicateDeliveryError(input.deliveryId ?? "");
  return id;
}

type Failure = { kind: OtariErrorKind | "exception" | "deadline"; error: OtariError | null; role: Role };
type CallResult<T> = { ok: true; data: ChatResponse; value: T } | { ok: false; failure: Failure };
/** Reads a successful response once: the value for the pipeline, extra fields for its step row. */
type Inspect<T> = (data: ChatResponse) => { value: T; step?: Partial<StepRecord> };
type Settled = { status: RunStatus; reply: string | null };

const EMPTY_STEP: Omit<StepRecord, "role"> = {
  requestedModel: null,
  servedModel: null,
  provider: null,
  fallback: false,
  attemptCount: null,
  requestId: null,
  costUsd: null,
  durationMs: null,
  guardrails: null,
  toolCalls: null,
  errorKind: null,
  errorStatus: null,
};

const content = (data: ChatResponse) => data.choices?.[0]?.message?.content ?? null;

/** Held-reply wording follows the most actionable profile (a leaked secret beats an injection). */
function heldProfile(guardrails: GuardrailViolation[]): string | undefined {
  for (const p of ["secrets", "prompt-injection", "harm"]) if (guardrails.some((g) => g.profile === p)) return p;
  return guardrails[0]?.profile;
}

class Run {
  cost = 0;
  private readonly deadlineAt = Date.now() + RUN_DEADLINE_MS;

  constructor(
    readonly id: string,
    readonly input: IssueInput,
    private readonly otari: PipelineDeps["otari"],
    readonly rec: Recorder,
    readonly now: () => Date,
  ) {}

  async step(role: string, s: Partial<StepRecord>): Promise<void> {
    const row: StepRecord = { ...EMPTY_STEP, ...s, role };
    this.cost += row.costUsd ?? 0;
    await this.rec.addStep(this.id, row);
  }

  private metaStep(meta: OtariMeta, body: ChatBody, data: ChatResponse, ms: number): Partial<StepRecord> {
    return {
      requestedModel: body.model,
      servedModel: meta.model,
      provider: meta.provider,
      fallback: meta.fallback,
      attemptCount: meta.attemptCount,
      requestId: meta.requestId,
      costUsd: meta.costUsd,
      durationMs: meta.durationMs ?? ms,
      guardrails: meta.guardrails,
      toolCalls: truncateToolCalls(data.otari_tool_calls),
    };
  }

  /**
   * One Otari call, recorded as one step per attempt. An upstream failure is retried once;
   * refusals (budget, guardrail, funds, blocked) never are. Storage errors propagate.
   */
  async call<T = undefined>(role: Role, body: ChatBody, inspect?: Inspect<T>): Promise<CallResult<T>> {
    for (let attempt = 1; ; attempt++) {
      const left = this.deadlineAt - Date.now();
      if (left < MIN_CALL_MS) {
        await this.step(role, { requestedModel: body.model, errorKind: "deadline" });
        return { ok: false, failure: { kind: "deadline", error: null, role } };
      }
      const t0 = Date.now();
      let res: { data: ChatResponse; meta: OtariMeta } | undefined;
      let err: unknown;
      try {
        res = await this.otari.chat(body, {
          conversationId: `run-${this.id}`,
          tags: { app: "porter", role, arm: this.input.arm },
          // Same key on the retry, so a request Otari already served is not billed twice.
          idempotencyKey: `run-${this.id}-${role}`,
          signal: AbortSignal.timeout(Math.min(STEP_TIMEOUT_MS[role], left)),
        });
      } catch (e) {
        err = e;
      }
      const ms = Date.now() - t0;
      if (res) {
        const seen = inspect ? inspect(res.data) : { value: undefined as T };
        await this.step(role, { ...this.metaStep(res.meta, body, res.data, ms), ...seen.step });
        return { ok: true, data: res.data, value: seen.value };
      }
      if (err instanceof OtariError) {
        const maybeServed = err.kind === "upstream" && SERVED_MAYBE.has(err.code ?? "");
        await this.step(role, {
          requestedModel: body.model,
          durationMs: ms,
          guardrails: err.guardrails.length > 0 ? err.guardrails : null,
          errorKind: maybeServed ? err.code : err.kind,
          errorStatus: err.status,
        });
        if (err.kind === "upstream" && !maybeServed && attempt === 1) continue;
        return { ok: false, failure: { kind: err.kind, error: err, role } };
      }
      await this.step(role, { requestedModel: body.model, durationMs: ms, errorKind: "exception" });
      return { ok: false, failure: { kind: "exception", error: null, role } };
    }
  }

  async hold(reason: "guardrail_violation" | "output_check", profiles: unknown): Promise<void> {
    await this.rec.putKv(
      reviewKey(this.id),
      {
        runId: this.id,
        repo: this.input.repo,
        issueNumber: this.input.number,
        source: this.input.source,
        reason,
        profiles,
        state: "open",
        createdAt: this.now().toISOString(),
      },
      null,
    );
  }

  /** Maps a failed call to the run's outcome; refusals get fixed, model-free replies. */
  async settle(f: Failure): Promise<Settled> {
    const e = f.error;
    switch (f.kind) {
      case "guardrail_violation": {
        await this.hold("guardrail_violation", e?.guardrails ?? []);
        return { status: "held_guardrail", reply: fixedReply("held_guardrail", { profile: heldProfile(e?.guardrails ?? []) }) };
      }
      case "budget_exceeded":
        return {
          status: "refused_budget",
          reply: fixedReply("refused_budget", {
            retryAfterSec: e?.retryAfterSec ?? undefined,
            scope: e?.budgetScope ?? undefined,
            step: f.role,
          }),
        };
      case "insufficient_funds": {
        const at = this.now();
        await this.rec.putKv(INSUFFICIENT_FUNDS_FLAG, { at: at.toISOString(), runId: this.id }, new Date(at.getTime() + FUNDS_FLAG_TTL_MS));
        return { status: "refused_funds", reply: null };
      }
      case "end_user_blocked":
        return { status: "blocked_author", reply: null };
      default:
        return { status: "failed", reply: null };
    }
  }
}

function buildProposals(input: IssueInput, triage: TriageResult, triageToolCalls: unknown): Proposal[] {
  if (input.number === null) return [];
  const out: Proposal[] = [];
  const labels = triage.labels.slice(0, MAX_LABELS);
  if (labels.length > 0) out.push({ action: "add_labels", args: { repo: input.repo, issue_number: input.number, labels } });
  // Only a duplicate the triage model actually saw in a repo tool result counts as evidence.
  const dup = triage.duplicates.find((d) => d.number !== input.number && issueSeenInTools(d.number, triageToolCalls));
  if (dup) out.push({ action: "close_as_duplicate", args: { repo: input.repo, issue_number: input.number, duplicate_of: dup.number } });
  return out;
}

type Driven = Settled & { triage: TriageResult | null; proposals: Proposal[] };

async function drive(run: Run, opts: { mcpServerId: string | null; docsHosts: string[] }): Promise<Driven> {
  const { input } = run;
  let triage: TriageResult | null = null;
  const done = (s: Settled, proposals: Proposal[] = []): Driven => ({ ...s, triage, proposals });

  if (!opts.mcpServerId) await run.step("warning", { errorKind: "mcp_not_configured" });

  // 1. Triage: the gateway runs the tool loop (repo MCP + web fetch); the mandate gates this first call.
  const t = await run.call("triage", buildTriageRequest(input, run.id, opts), (data) => {
    const parsed = parseTriage(content(data));
    return { value: parsed.result, step: parsed.fallback ? { errorKind: "parse_fallback" } : undefined };
  });
  if (!t.ok) return done(await run.settle(t.failure));
  triage = t.value;
  const triageToolCalls = t.data.otari_tool_calls;

  // 2. Repro, only for a Python snippet. Verified only by a recorded sandbox run.
  let repro: ReproResult = { attempted: false };
  if (shouldRepro(t.value)) {
    const r = await run.call("repro", buildReproRequest(input, run.id, t.value));
    if (!r.ok) return done(await run.settle(r.failure));
    repro = extractRepro(r.data);
  }

  // 3. Review: a different model family writes the reply from the evidence and strikes unsupported claims.
  const bundle = buildEvidenceBundle({ input, triage: t.value, repro, toolCalls: triageToolCalls });
  const v = await run.call("review", buildReviewRequest(input, run.id, bundle, opts.docsHosts), (data) => {
    const review = parseReview(content(data));
    return {
      value: review,
      step: {
        toolCalls: [{ type: "struck_claims", claims: review.struck }],
        ...(review.fallback ? { errorKind: "parse_fallback" } : {}),
      },
    };
  });
  if (!v.ok) return done(await run.settle(v.failure));
  if (!v.value.reply) return done({ status: "failed", reply: null });

  let reply = v.value.reply;
  if (repro.attempted && !repro.verified) reply = `${reply}\n\n${UNVERIFIED_NOTE}`;

  if (input.arm === "baseline") return done({ status: "answered", reply });

  // 4. Output check, in-process: detectors + run-marker canary + link allowlist. No model call.
  const check = checkOutput(reply, { repo: input.repo, runId: run.id, docsHosts: opts.docsHosts });
  await run.step("output_check", {
    guardrails: [{ profile: "output_check", mode: "block", valid: check.valid, score: null, status: "evaluated", reason: check.reasons.join(",") || null }],
    errorKind: check.valid ? null : "output_blocked",
  });
  if (!check.valid) {
    await run.hold("output_check", [{ profile: "output_check", reasons: check.reasons }]);
    return done({ status: "held_guardrail", reply: fixedReply("held_guardrail", { profile: "output" }) });
  }

  // 5. Reply + proposals (pending until a maintainer approves).
  return done({ status: "answered", reply }, buildProposals(input, t.value, triageToolCalls));
}

/**
 * Drives one issue: triage → repro (Python only) → review → output check → reply + proposals.
 * Gateway refusals become outcomes; nothing here posts to GitHub.
 */
export async function runIssue(input: IssueInput, deps: PipelineDeps): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const rec = recorderFor(deps);
  const runId = deps.runId ?? (await startRun(input, { recorder: rec }));
  if (!isValidRepo(input.repo)) {
    // Never let a malformed repo reach a prompt or a tool argument.
    await rec.addStep(runId, { ...EMPTY_STEP, role: "warning", errorKind: "invalid_repo" });
    await rec.finishRun(runId, { status: "failed", reply: null, triage: null, totalCostUsd: 0, finishedAt: now() });
    return { runId, status: "failed", reply: null, proposals: [] };
  }
  const mcpServerId = deps.mcpServerId !== undefined ? deps.mcpServerId : getMcpServerId(input.arm);
  const run = new Run(runId, input, deps.otari, rec, now);

  let result: Driven;
  try {
    result = await drive(run, { mcpServerId, docsHosts: deps.docsHosts ?? [] });
    if (result.proposals.length > 0) await rec.addProposals(runId, result.proposals);
    await rec.finishRun(runId, {
      status: result.status,
      reply: result.reply,
      triage: result.triage,
      totalCostUsd: run.cost,
      finishedAt: now(),
    });
  } catch (e) {
    // Storage (or a bug) failed mid-run: try to leave the run marked failed, then surface the error.
    await rec
      .finishRun(runId, { status: "failed", reply: null, triage: null, totalCostUsd: run.cost, finishedAt: now() })
      .catch(() => undefined);
    throw e;
  }
  return { runId, status: result.status, reply: result.reply, proposals: result.proposals };
}
