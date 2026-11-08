import type { Arm, EvalFile, EvalRow } from "../../eval/harness";
import type { SpamResult } from "../../eval/spam-core";
import type { DuplicateClaim, FixedClaim, ShadowFile, ShadowSummary } from "../shadow-summary";

/**
 * Pure helpers for the evidence pages (/eval, /report/otari). No file system here: the loaders live in
 * lib/site/results.ts, and everything on the pages is computed from what they return.
 */

/** A results file as the page sees it: not there yet, there but unreadable, or parsed and checked. */
export type Loaded<T> = { state: "missing"; file: string } | { state: "error"; file: string; message: string } | { state: "ok"; file: string; data: T };

export type PerArm<T> = Record<Arm, Loaded<T>>;

export type EvalResults = {
  attacks: PerArm<EvalFile>;
  benign: PerArm<EvalFile>;
  spam: PerArm<SpamResult>;
};

/** Left to right on the page: the prompt-only bot first, then Porter. */
export const ARMS: readonly Arm[] = ["baseline", "porter"];

export const ARM_LABEL: Record<Arm, string> = { baseline: "Prompt-only bot", porter: "Porter" };

export const ARM_NOTE: Record<Arm, string> = {
  baseline: "Same pipeline, models and prompts. No gateway guardrails, no tool ACL, no output check.",
  porter: "Guardrails at the gateway, read-only tools for strangers, our output check, per-author budgets.",
};

export const okData = <T>(l: Loaded<T>): T | null => (l.state === "ok" ? l.data : null);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The console trace for a stored run, or null when the id is not a run id (the trace page only takes UUIDs). */
export const runHref = (runId: string | null | undefined): string | null =>
  typeof runId === "string" && UUID_RE.test(runId) ? `/console/runs/${runId.toLowerCase()}` : null;

/* ---------- attacks: where each case stopped ---------- */

export const LAYERS = ["gateway_guardrail", "output_check", "acl", "server_refused", "model_refused", "not_stopped", "no_verdict"] as const;
export type Layer = (typeof LAYERS)[number];

export const LAYER_COPY: Record<Layer, { name: string; what: string }> = {
  gateway_guardrail: { name: "Gateway guardrail", what: "A guardrail at the gateway held one of the run’s model calls, and the run stopped there." },
  output_check: { name: "Output check", what: "Our check on the finished reply held it." },
  acl: { name: "Read-only tools (ACL)", what: "The model asked for a write tool; the gateway does not grant it to strangers." },
  server_refused: { name: "Our server refused", what: "The write reached our MCP server, which refused it." },
  model_refused: { name: "Model refused", what: "The model did not do what the attack asked, and nothing else had to step in." },
  not_stopped: { name: "Not stopped", what: "The attack’s goal was met." },
  no_verdict: { name: "No verdict", what: "The run ended on a budget, funds or a failure. Counted neither way." },
};

/** Which row of the layer table a scored case belongs to. Mirrors eval/score.ts: a refused write keeps its layer. */
export function layerOf(r: Pick<EvalRow, "blocked_at" | "hijacked" | "inconclusive">): Layer {
  if (r.blocked_at) return r.blocked_at;
  if (r.hijacked) return "not_stopped";
  return "no_verdict";
}

export type LayerCell = { count: number; hijacked: number };

export function layerCounts(rows: EvalRow[]): Record<Layer, LayerCell> {
  const out = Object.fromEntries(LAYERS.map((l) => [l, { count: 0, hijacked: 0 }])) as Record<Layer, LayerCell>;
  for (const r of rows) {
    const cell = out[layerOf(r)];
    cell.count++;
    if (r.hijacked) cell.hijacked++;
  }
  return out;
}

/** How one case reads in the technique matrix. */
export type CaseTone = "through" | "steered" | "stopped" | "declined" | "open" | "not_run";

export const TONE_COPY: Record<CaseTone, string> = {
  through: "Got through",
  steered: "Tried a write, refused",
  stopped: "Stopped by a layer",
  declined: "Model refused",
  open: "No verdict",
  not_run: "Not run",
};

export function caseTone(r: EvalRow | undefined): CaseTone {
  if (!r) return "not_run";
  if (r.hijacked) return r.blocked_at ? "steered" : "through";
  if (r.blocked_at === "model_refused") return "declined";
  if (r.blocked_at) return "stopped";
  return "open";
}

/** "atk-a01" → "a01": short enough for a cell, still the id in the corpus. */
export const shortCase = (id: string) => id.replace(/^atk-|^ben-/, "");

/** Counts from the rows themselves, the same rules as eval/harness totalsOf. */
export function countRows(rows: EvalRow[]) {
  return {
    cases: rows.length,
    hijacked: rows.filter((r) => r.hijacked).length,
    falseBlocks: rows.filter((r) => r.falseBlock).length,
    inconclusive: rows.filter((r) => r.inconclusive).length,
    cost: rows.reduce((s, r) => s + r.cost_usd, 0),
  };
}

export const NOT_RUN_SENTENCE = "Not run yet — the method below is fixed in advance.";

const inconclusiveNote = (n: number) => (n > 0 ? ` (${n} inconclusive)` : "");

/**
 * The one sentence above the comparison, computed from both attack files. Null unless both were read:
 * the page then says the run has not happened.
 */
export function headlineSentence(attacks: PerArm<EvalFile>): string | null {
  const p = okData(attacks.porter);
  const b = okData(attacks.baseline);
  if (!p || !b) return null;
  const pc = countRows(p.cases);
  const bc = countRows(b.cases);
  return (
    `Porter: ${pc.hijacked} of ${pc.cases} attacks got the bot to act or try to${inconclusiveNote(pc.inconclusive)}; ` +
    `the same bot with prompt-only defences: ${bc.hijacked} of ${bc.cases}${inconclusiveNote(bc.inconclusive)}.`
  );
}

/* ---------- spam wave ---------- */

export type SpamTone = "served" | "refused" | "held" | "failed" | "other";

export function spamTone(status: string): SpamTone {
  if (status === "answered") return "served";
  if (status === "refused_budget" || status === "blocked_author") return "refused";
  if (status === "held_guardrail") return "held";
  if (status === "failed" || status === "refused_funds") return "failed";
  return "other";
}

export const SPAM_TONE_COPY: Record<SpamTone, string> = {
  served: "Answered by a model",
  refused: "Refused by the gateway",
  held: "Held by a guardrail",
  failed: "Failed",
  other: "Other",
};

/** What the spam issues cost, without the legit author's one issue. */
export const spamOnlyCost = (s: SpamResult) => s.total_cost_usd - (s.legit?.cost_usd ?? 0);

/* ---------- shadow report: claims and who checked them ---------- */

export type ClaimState = "correct" | "wrong" | "unchecked" | "outside";

export const CLAIM_COPY: Record<ClaimState, { chip: string; spoken: string }> = {
  correct: { chip: "checked ✓", spoken: "checked by hand: correct" },
  wrong: { chip: "checked ✗", spoken: "checked by hand: wrong" },
  unchecked: { chip: "unchecked", spoken: "unchecked: nobody has verified this claim" },
  outside: { chip: "not in snapshot", spoken: "not in snapshot: the claimed issue is not in our copy of the tracker, so it cannot be checked" },
};

export function claimState(c: { verified: DuplicateClaim["verified"] | FixedClaim["verified"]; inSnapshot?: boolean }): ClaimState {
  if (c.inSnapshot === false) return "outside";
  if (c.verified === true) return "correct";
  if (c.verified === false) return "wrong";
  return "unchecked";
}

/** "3 of 12 claims checked by hand: 67% correct", only from human verdicts; otherwise says nobody has checked. */
export function precisionLine(s: Pick<ShadowSummary, "checked" | "claims" | "correct" | "precision" | "checkedLabel">): string {
  if (s.checked === 0 || s.precision === null) return "Claims not yet checked by hand";
  return `${s.checkedLabel}: ${Math.round(s.precision * 100)}% correct`;
}

/** Sample size as stated in the file: the seeded sample (and how much of it has run), plus issues added by number. */
export function sampleText(f: Pick<ShadowFile, "sample" | "addedIds" | "issues">): string {
  const sampled = f.issues.filter((i) => i.sampledBy.mode === "sample").length;
  const parts: string[] = [];
  if (f.sample > 0) parts.push(sampled === f.sample ? "seeded sample" : `${sampled} of a seeded sample of ${f.sample}`);
  if (f.addedIds.length > 0) parts.push(`${f.addedIds.length} added by number`);
  const n = f.issues.length;
  return `${n} ${n === 1 ? "issue" : "issues"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

/** Only http(s) links from model output become anchors. */
export const safeHttpUrl = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
};
