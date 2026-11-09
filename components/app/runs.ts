import type { RunDetail, RunRow, Step } from "./types";

export type Tone = "live" | "ok" | "hold" | "warn" | "muted";

/** What each run status means to a maintainer. "hold" is the gateway doing its job. */
export const STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "live" },
  answered: { label: "Answered", tone: "ok" },
  held_guardrail: { label: "Held", tone: "hold" },
  refused_budget: { label: "Refused: budget", tone: "hold" },
  blocked_author: { label: "Refused: blocked", tone: "hold" },
  refused_funds: { label: "Paused: funds low", tone: "warn" },
  failed: { label: "Failed", tone: "warn" },
};

export const statusMeta = (status: string) => STATUS[status] ?? { label: status.replace(/_/g, " "), tone: "muted" as Tone };

/** Every status except "running" is final: the pipeline writes it once, at the end. */
export const isTerminal = (status: string | undefined) => status !== undefined && status !== "running";

export const FILTERS = ["all", "answered", "held", "refused", "failed"] as const;
export type Filter = (typeof FILTERS)[number];

const GROUP: Record<Exclude<Filter, "all">, readonly string[]> = {
  answered: ["answered"],
  held: ["held_guardrail"],
  refused: ["refused_budget", "blocked_author", "refused_funds"],
  failed: ["failed"],
};

export const matchesFilter = (row: Pick<RunRow, "status">, f: Filter) => f === "all" || GROUP[f].includes(row.status);

export const ROLE_LABEL: Record<string, string> = {
  triage: "Triage",
  repro: "Repro",
  review: "Review",
  output_check: "Output check",
  warning: "Note",
};

/** The cheaper model the porter-triage routing policy moves an author to near their cap (served as deepseek/deepseek-v4-flash-0731). */
export const TIER_DOWN_MODEL = "deepseek-v4-flash-0731";
export const TIER_DOWN_AT_PCT = 80;

/** The served id, with or without its namespace ("deepseek/…"), is exactly the tier-down model. */
export function isTierDown(servedModel: string | null | undefined): boolean {
  if (typeof servedModel !== "string") return false;
  const id = servedModel.trim().toLowerCase();
  const want = TIER_DOWN_MODEL.toLowerCase();
  return id === want || id.endsWith(`/${want}`);
}

/** The step where the gateway refused to pass the text to a model, if any. */
export const gatewayHoldStep = (steps: Step[]) => steps.find((s) => s.errorKind === "guardrail_violation");

/** Porter's own output check stopped the draft. */
export const outputHoldStep = (steps: Step[]) => steps.find((s) => s.role === "output_check" && s.errorKind === "output_blocked");

export type HoldKind = "gateway" | "output" | null;

export function holdKind(d: Pick<RunDetail, "steps"> & { run: Pick<RunRow, "status"> }): HoldKind {
  if (d.run.status !== "held_guardrail") return null;
  if (gatewayHoldStep(d.steps)) return "gateway";
  if (outputHoldStep(d.steps)) return "output";
  return null;
}

/** True when no model produced any output before the hold: the answering model never ran. */
export function heldBeforeAnyAnswer(steps: Step[]): boolean {
  const at = steps.findIndex((s) => s.errorKind === "guardrail_violation");
  if (at < 0) return false;
  return !steps.slice(0, at).some((s) => s.servedModel !== null);
}

/** "deepseek/deepseek-v4.1-flash-1017" → "deepseek-v4.1-flash-1017" for tight columns; the trace keeps the full id. */
export const modelName = (id: string | null | undefined) => (id ? id.slice(id.lastIndexOf("/") + 1) : null);

/** The served model of the run's triage call (the one the author's budget tier decides). */
export const triageModel = (steps: Step[]) => steps.find((s) => s.role === "triage" && s.servedModel)?.servedModel ?? null;

/** The model that wrote the reply when there is one, else the last model that served a call. */
export function servedModelOf(steps: Step[]): string | null {
  const review = steps.find((s) => s.role === "review" && s.servedModel);
  if (review) return review.servedModel;
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].servedModel) return steps[i].servedModel;
  return null;
}

export type GuardEntry = { profile: string; valid: boolean | null; score: number | null; status: string | null; detail: string | null };

/** Otari-Guardrails header entries on a served call, or the violations in a 4xx, in one shape. */
export function guardEntries(raw: unknown): GuardEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object" && !Array.isArray(g))
    .map((g) => {
      const isViolation = typeof g.explanation === "string" && g.valid === undefined;
      return {
        profile: typeof g.profile === "string" ? g.profile : "unknown",
        valid: isViolation ? false : typeof g.valid === "boolean" ? g.valid : null,
        score: typeof g.score === "number" && Number.isFinite(g.score) ? g.score : null,
        status: typeof g.status === "string" ? g.status : null,
        detail: typeof g.reason === "string" && g.reason ? g.reason : typeof g.explanation === "string" && g.explanation ? g.explanation : null,
      };
    });
}

export type ToolCall =
  | { kind: "mcp"; name: string; server: string | null; status: string | null; output: string; error: string | null }
  | { kind: "fetch"; url: string | null; status: string | null; error: string | null }
  | { kind: "search"; query: string | null; sources: Array<{ url: string; title: string }>; status: string | null; error: string | null }
  | { kind: "code"; code: string; stdout: string; stderr: string; exitCode: number | null; truncated: boolean }
  | { kind: "struck"; claims: string[] }
  | { kind: "truncated"; dropped: number }
  | { kind: "other"; type: string };

const s = (v: unknown) => (typeof v === "string" ? v : null);

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** `otari_tool_calls` (and Porter's own markers) as the trace shows them. */
export function toolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const r = c as Record<string, unknown>;
    const type = s(r.type) ?? "";
    const id = s(r.id) ?? "";
    if (type === "mcp") {
      out.push({ kind: "mcp", name: s(r.name) ?? "tool", server: s(r.server), status: s(r.status), output: text(r.output), error: s(r.error) });
    } else if (type === "code_execution") {
      out.push({
        kind: "code",
        code: s(r.code) ?? "",
        stdout: s(r.stdout) ?? "",
        stderr: s(r.stderr) ?? "",
        exitCode: typeof r.exit_code === "number" && Number.isFinite(r.exit_code) ? r.exit_code : null,
        truncated: r.truncated === true,
      });
    } else if (type === "struck_claims") {
      out.push({ kind: "struck", claims: Array.isArray(r.claims) ? r.claims.filter((x): x is string => typeof x === "string") : [] });
    } else if (type === "porter_truncated") {
      out.push({ kind: "truncated", dropped: typeof r.dropped === "number" ? r.dropped : 0 });
    } else if (/fetch/.test(type) || id.startsWith("otari_wf_")) {
      out.push({ kind: "fetch", url: s(r.url), status: s(r.status), error: s(r.error) });
    } else if (/search/.test(type) || id.startsWith("otari_ws_")) {
      const sources = Array.isArray(r.sources)
        ? r.sources
            .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
            .map((x) => ({ url: s(x.url) ?? "", title: s(x.title) ?? "" }))
            .filter((x) => x.url !== "")
        : [];
      out.push({ kind: "search", query: s(r.query), sources, status: s(r.status), error: s(r.error) });
    } else {
      out.push({ kind: "other", type: type || "unknown" });
    }
  }
  return out;
}

/** A sandbox run counts only when Otari recorded a code_execution entry with a numeric exit code. */
export const sandboxProof = (raw: unknown) => toolCalls(raw).find((c): c is Extract<ToolCall, { kind: "code" }> => c.kind === "code" && c.exitCode !== null) ?? null;

/** Plain words for the error kinds the pipeline records on a step. */
export function errorText(kind: string | null, status: number | null): string | null {
  if (!kind) return null;
  const code = status ? ` (${status})` : "";
  switch (kind) {
    case "guardrail_violation":
      return `Held at the gateway${code}`;
    case "budget_exceeded":
      return `Refused by the author's budget${code}`;
    case "end_user_blocked":
      return `Refused: the author is blocked${code}`;
    case "insufficient_funds":
      return `Refused: Porter's balance is too low${code}`;
    case "rate_limited":
      return `Rate limited by the gateway${code}`;
    case "upstream":
      return `Provider error after fallback${code}`;
    case "timeout":
      return "Timed out waiting for the gateway";
    case "invalid_json":
      return "The gateway answered with a body that was not JSON";
    case "deadline":
      return "Stopped: the run reached its time limit";
    case "exception":
      return "The call failed before a response came back";
    case "output_blocked":
      return "The output check stopped the draft";
    case "parse_fallback":
      return "The model's answer was not valid JSON; read as plain text";
    case "mcp_not_configured":
      return "No repository tool server is configured for this run";
    case "invalid_repo":
      return "The repository name is not valid; nothing ran";
    case "skipped: funds_low":
      return "Not run: Porter's balance fell below the floor";
    case "skipped: deadline":
      return "Not run: the batch reached its time limit";
    default:
      return `${kind.replace(/_/g, " ")}${code}`;
  }
}

/** Notes that are information rather than a failure of the step. */
export const isSoftError = (kind: string | null) => kind === "parse_fallback" || kind === "mcp_not_configured";
