import type { Arm, EvalFile, EvalSet } from "../../eval/harness";
import type { SpamResult } from "../../eval/spam-core";
import type { Loaded } from "./evidence";

/**
 * Runs made after the pre-registered eval, each changing one thing. Pure: the README renderer and the /eval
 * page build the same tables here, from files the loaders in lib/site/results.ts have read and checked.
 * Every number comes from those files; the definitions below only say which files, and what changed.
 */

export const POST_HOC_TITLE = "After the pre-registered run (post-hoc, not pre-registered)";
export const POST_HOC_NOTE =
  "Each run below changed one thing after the pre-registered results above were in. None of them was fixed in advance; the tables above remain the pre-registered result.";

/** One row of an experiment's table: a tagged results file, or (tag null) the pre-registered file it is compared with. */
export type PostHocRun = { label: string; arm: Arm; tag: string | null };

type Base = {
  key: string;
  title: string;
  /** Lower-case clause: what this run changed against the pre-registered setup. */
  changed: string;
  commit: string;
  runs: PostHocRun[];
  /** What a tagged run's row says while its file is not there. */
  whenMissing: string;
};
export type PostHocEvalDef = Base & { kind: "eval"; set: EvalSet };
export type PostHocSpamDef = Base & { kind: "spam" };
export type PostHocDef = PostHocEvalDef | PostHocSpamDef;

export const POST_HOC: readonly PostHocDef[] = [
  {
    kind: "eval",
    key: "small-model",
    set: "attacks",
    title: "Smaller model on triage and review, same attacks",
    runs: [
      { label: "Porter", arm: "porter", tag: "small-model" },
      { label: "Baseline", arm: "baseline", tag: "small-model" },
    ],
    changed:
      "triage and review were sent straight to `google/gemma-3-27b-it` instead of the routing policies, with `pnpm eval --model google/gemma-3-27b-it --tag small-model`",
    commit: "cbec9dc",
    whenMissing: "Not run yet.",
  },
  {
    kind: "spam",
    key: "request-cap",
    title: "Spam wave with a request cap",
    runs: [
      { label: "Porter, request cap", arm: "porter", tag: "request-cap" },
      { label: "Porter, pre-registered", arm: "porter", tag: null },
    ],
    changed:
      "the newcomer end-user budget also carries a limit of 12 requests a day (`request_limit` on the Otari end-user budget), and the wave files as fresh authors",
    commit: "c0bc516",
    whenMissing: "Not run yet.",
  },
  {
    kind: "eval",
    key: "benign-after-fix",
    set: "benign",
    title: "The real issues again, after the evidence fix",
    runs: [
      { label: "Porter, after the fix", arm: "porter", tag: "after-fix" },
      { label: "Porter, pre-registered", arm: "porter", tag: null },
    ],
    changed:
      "other people's text reaches the reviewer with closed HTML comments removed, and addresses outside the link allowlist are written without a scheme",
    commit: "5a999a7",
    whenMissing: "Running.",
  },
];

export const evalFileName = (arm: Arm, set: EvalSet, tag: string | null = null) =>
  tag ? `eval-${arm}-${set}-${tag}.json` : `eval-${arm}-${set}.json`;
export const spamFileName = (arm: Arm, tag: string | null = null) => (tag ? `spam-${arm}-${tag}.json` : `spam-${arm}.json`);

export type PostHocData =
  | { def: PostHocEvalDef; expected: number; runs: Array<PostHocRun & { loaded: Loaded<EvalFile> }> }
  | { def: PostHocSpamDef; runs: Array<PostHocRun & { loaded: Loaded<SpamResult> }> };

/* ---------- cells, shared with the pre-registered tables ---------- */

export const usd = (n: number) => `$${n.toFixed(4)}`;
const inconclusiveNote = (f: EvalFile) => (f.totals.inconclusive > 0 ? ` (${f.totals.inconclusive} inconclusive)` : "");
const stoppedNote = (f: EvalFile) => (f.stopped ? ` (stopped: ${f.stopped.reason})` : "");
/** A file with fewer cases than the corpus, and not stopped, is a run still writing. */
const runningNote = (f: EvalFile, expected?: number) =>
  expected !== undefined && !f.stopped && f.totals.cases < expected ? ` (running: ${f.totals.cases} of ${expected} cases)` : "";

export const ATTACK_COLUMNS = ["Hijacked", "Gateway guardrail", "Output check", "ACL", "Server refused", "Model refused", "Not blocked", "Inconclusive", "Cost"];
export const BENIGN_COLUMNS = ["False blocks", "At gateway guardrail", "At output check", "Inconclusive", "Cost"];
export const SPAM_COLUMNS = ["Spam issues filed", "Answered", "Refused at the gateway", "First budget refusal", "Spam cost", "Legit author served", "Cost at N=100 (modeled)"];

export function attackCells(f: EvalFile, expected?: number): string[] {
  const b = f.totals.blocked_at;
  // Hijacked cases that were contained (refused write) count under their block; "Not blocked" is the rest of the hijacks.
  return [
    `${f.totals.hijacked}/${f.totals.cases}${inconclusiveNote(f)}${stoppedNote(f)}${runningNote(f, expected)}`,
    String(b.gateway_guardrail ?? 0),
    String(b.output_check ?? 0),
    String(b.acl ?? 0),
    String(b.server_refused ?? 0),
    String(b.model_refused ?? 0),
    String(f.cases.filter((c) => c.hijacked && c.blocked_at === null).length),
    String(f.totals.inconclusive),
    usd(f.totals.cost_usd),
  ];
}

export function benignCells(f: EvalFile, expected?: number): string[] {
  return [
    `${f.totals.falseBlocks}/${f.totals.cases}${inconclusiveNote(f)}${stoppedNote(f)}${runningNote(f, expected)}`,
    String(f.cases.filter((c) => c.falseBlock && c.blocked_at === "gateway_guardrail").length),
    String(f.cases.filter((c) => c.falseBlock && c.blocked_at === "output_check").length),
    String(f.totals.inconclusive),
    usd(f.totals.cost_usd),
  ];
}

const REFUSED = new Set(["refused_budget", "blocked_author"]);

export function spamCells(s: SpamResult): string[] {
  return [
    `${s.issues.length}/${s.n}${s.stopped ? ` (stopped: ${s.stopped})` : ""}`,
    String(s.issues.filter((i) => i.status === "answered").length),
    String(s.issues.filter((i) => REFUSED.has(i.status)).length),
    s.first_refusal_index === null ? "none" : `issue ${s.first_refusal_index}`,
    usd(s.total_cost_usd - (s.legit?.cost_usd ?? 0)),
    s.legit === null ? "-" : s.legit.served ? "yes" : `no (${s.legit.status})`,
    s.modeled ? `${usd(s.modeled.cost_usd)} (modeled)` : "-",
  ];
}

/* ---------- one experiment as a table ---------- */

export type PostHocTable = {
  key: string;
  title: string;
  head: string[];
  /** First cell is the run's label. Cells may hold `code` spans, written with backticks. */
  rows: string[][];
  notes: string[];
  changed: string;
  commit: string;
  sources: string[];
};

/** What a row says when its file cannot be used. Never a number. */
function stateText(loaded: Exclude<Loaded<unknown>, { state: "ok" }>, run: PostHocRun, whenMissing: string): string {
  if (loaded.state === "missing") return run.tag ? whenMissing : "Not run yet.";
  return `Can't read \`${loaded.file}\`: ${loaded.message.replace(/\|/g, "/")}`;
}

export function postHocTable(d: PostHocData): PostHocTable {
  const { def } = d;
  const base = { key: def.key, title: def.title, changed: def.changed, commit: def.commit };
  if (def.kind === "spam") {
    const runs = (d as Extract<PostHocData, { def: PostHocSpamDef }>).runs;
    return {
      ...base,
      head: ["Run", ...SPAM_COLUMNS],
      rows: runs.map((r) =>
        r.loaded.state === "ok"
          ? [r.label, ...spamCells(r.loaded.data)]
          : [r.label, stateText(r.loaded, r, def.whenMissing), ...SPAM_COLUMNS.slice(1).map(() => "-")],
      ),
      notes: runs.flatMap((r) => (r.loaded.state === "ok" && r.loaded.data.modeled ? [`${r.label}: ${r.loaded.data.modeled.formula}`] : [])),
      sources: runs.map((r) => `results/${spamFileName(r.arm, r.tag)}`),
    };
  }
  const data = d as Extract<PostHocData, { def: PostHocEvalDef }>;
  const attacks = data.def.set === "attacks";
  const columns = attacks ? ATTACK_COLUMNS : BENIGN_COLUMNS;
  const notes: string[] = [];
  for (const r of data.runs) {
    if (r.loaded.state !== "ok") continue;
    const cases = r.loaded.data.cases;
    if (attacks) {
      const hit = cases.filter((c) => c.hijacked).map((c) => `${c.id}${c.goal ? ` (${c.goal.kind})` : ""}`);
      if (hit.length > 0) notes.push(`Hijacked (${r.label}): ${hit.join(", ")}.`);
    } else {
      const held = cases.filter((c) => c.falseBlock).map((c) => `${c.id}${c.blocked_at ? ` (${c.blocked_at})` : ""}`);
      if (held.length > 0) notes.push(`False blocks (${r.label}): ${held.join(", ")}.`);
    }
  }
  return {
    ...base,
    head: ["Run", ...columns],
    rows: data.runs.map((r) =>
      r.loaded.state === "ok"
        ? [r.label, ...(attacks ? attackCells(r.loaded.data, data.expected) : benignCells(r.loaded.data, data.expected))]
        : [r.label, stateText(r.loaded, r, def.whenMissing), ...columns.slice(1).map(() => "-")],
    ),
    notes,
    sources: data.runs.map((r) => `results/${evalFileName(r.arm, data.def.set, r.tag)}`),
  };
}

/** "triage and review…" → "Triage and review…". */
export const sentence = (clause: string) => clause.charAt(0).toUpperCase() + clause.slice(1);
