export type OtariErrorKind =
  | "budget_exceeded"
  | "guardrail_violation"
  | "insufficient_funds"
  | "rate_limited"
  | "end_user_blocked"
  | "upstream"
  | "other";

export type GuardrailViolation = { profile: string; explanation: string; score: number | null };

export class OtariError extends Error {
  kind: OtariErrorKind;
  status: number;
  code: string | null;
  budgetScope: string | null;
  retryAfterSec: number | null;
  guardrails: GuardrailViolation[];
  requestId: string | null;

  constructor(init: {
    kind: OtariErrorKind;
    status: number;
    message?: string;
    code?: string | null;
    budgetScope?: string | null;
    retryAfterSec?: number | null;
    guardrails?: GuardrailViolation[];
    requestId?: string | null;
  }) {
    super(init.message ?? `Otari ${init.status} ${init.code ?? init.kind}`);
    this.name = "OtariError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code ?? null;
    this.budgetScope = init.budgetScope ?? null;
    this.retryAfterSec = init.retryAfterSec ?? null;
    this.guardrails = init.guardrails ?? [];
    this.requestId = init.requestId ?? null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseGuardrails(v: unknown): GuardrailViolation[] {
  if (!Array.isArray(v)) return [];
  const out: GuardrailViolation[] = [];
  for (const item of v) {
    const r = asRecord(item);
    if (!r) continue;
    out.push({
      profile: typeof r.profile === "string" ? r.profile : "unknown",
      explanation: typeof r.explanation === "string" ? r.explanation : "",
      score: typeof r.score === "number" ? r.score : null,
    });
  }
  return out;
}

/** Builds an OtariError from a failed response. Never throws, whatever the body looks like. Never includes the body in the message. */
export function classifyOtariError(status: number, headers: Headers, bodyText: string): OtariError {
  let body: Record<string, unknown> | null = null;
  try {
    body = asRecord(JSON.parse(bodyText));
  } catch {
    body = null;
  }
  const detail = asRecord(body?.detail);

  const headerCode = headers.get("Otari-Error-Code");
  const bodyCode =
    (typeof body?.code === "string" ? body.code : null) ?? (typeof detail?.code === "string" ? detail.code : null);
  const code = headerCode || bodyCode || null;

  const retryRaw = headers.get("Retry-After");
  const retryNum = retryRaw === null ? NaN : Number(retryRaw);
  const retryAfterSec = Number.isFinite(retryNum) ? retryNum : null;
  const budgetScope = headers.get("Otari-Budget-Scope");
  const guardrails = parseGuardrails(detail?.guardrails ?? body?.guardrails);

  let kind: OtariErrorKind;
  if (code === "budget_exceeded") kind = "budget_exceeded";
  else if (code === "guardrail_violation") kind = "guardrail_violation";
  else if (code === "insufficient_funds") kind = "insufficient_funds";
  else if (code === "rate_limited" || status === 429) kind = "rate_limited";
  else if (code === "end_user_blocked") kind = "end_user_blocked";
  else if (status === 402 && !code) kind = "insufficient_funds";
  else if (status >= 500 || status === 424) kind = "upstream";
  else kind = "other";

  const requestId = headers.get("Otari-Request-Id");
  return new OtariError({ kind, status, code, budgetScope, retryAfterSec, guardrails, requestId });
}
