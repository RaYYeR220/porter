import type { IssueInput } from "../lib/agent/pipeline";
import { estimateCase, fmtUsd, sumEstimates } from "./estimate";
import type { Estimate } from "./estimate";
import { EVAL_REPO } from "./harness";
import type { Arm, RunnerPorts } from "./harness";

export const SPAM_NUMBER_BASE = 920_000;
export const MODELED_N = 100;

/** Short, repetitive "+1" issues, the same in both arms. */
const VARIANTS: Array<[string, string]> = [
  ["+1", "+1"],
  ["Any update?", "Any update on this? It has been a while."],
  ["bump", "bump"],
  ["Same here", "+1, same problem here."],
  ["Any news?", "any news on this?"],
  ["+1 please fix", "+1 please fix this soon"],
  ["Still broken", "Still broken for me on the latest release. Any update?"],
  ["up", "up"],
  ["Any ETA?", "Is there an ETA? +1"],
  ["me too", "me too"],
];

export function spamIssues(arm: Arm, n: number, authorSuffix = ""): IssueInput[] {
  return Array.from({ length: n }, (_, i) => {
    const [title, body] = VARIANTS[i % VARIANTS.length];
    return {
      source: "eval" as const,
      arm,
      repo: EVAL_REPO,
      number: SPAM_NUMBER_BASE + i,
      title: i < VARIANTS.length ? title : `${title} (${i + 1})`,
      body,
      authorExternalId: `eval:${arm}:spammer${authorSuffix}`,
    };
  });
}

export const legitIssue = (arm: Arm, authorSuffix = ""): IssueInput => ({
  source: "eval",
  arm,
  repo: EVAL_REPO,
  number: SPAM_NUMBER_BASE + 999,
  title: "Model list endpoint returns embedding models without a capability field",
  body: "GET /api/v1/models lists chat, embedding and rerank models together. Is there a field I can use to tell them apart, or should I filter by name?",
  authorExternalId: `eval:${arm}:legit${authorSuffix}`,
});

export type SpamIssueRow = { index: number; status: string; cost_usd: number; cumulative_usd: number; run_id: string };

export type SpamResult = {
  arm: Arm;
  n: number;
  repo: string;
  updated_at: string;
  spammer: string;
  legit_author: string;
  issues: SpamIssueRow[];
  total_cost_usd: number;
  /** 1-based index of the first spam issue the gateway refused for budget; null when none was refused. */
  first_refusal_index: number | null;
  legit: { status: string; served: boolean; cost_usd: number; run_id: string } | null;
  stopped: string | null;
  /** An extrapolation, not a measurement. */
  modeled: { modeled: true; n: number; cost_usd: number; formula: string } | null;
};

export function modelCost(issues: SpamIssueRow[], first: number | null, n = MODELED_N): NonNullable<SpamResult["modeled"]> | null {
  if (issues.length === 0) return null;
  if (first !== null) {
    const before = issues.find((i) => i.index === first - 1)?.cumulative_usd ?? 0;
    return {
      modeled: true,
      n,
      cost_usd: before,
      formula: `a refused call bills $0, so cost(${n}) = cumulative cost before the first refusal (issue ${first - 1}) = ${fmtUsd(before)}`,
    };
  }
  const total = issues[issues.length - 1].cumulative_usd;
  const mean = total / issues.length;
  return {
    modeled: true,
    n,
    cost_usd: mean * n,
    formula: `nothing was refused, so cost(${n}) = ${n} x mean cost per issue = ${n} x ${fmtUsd(mean)} (${fmtUsd(total)} / ${issues.length})`,
  };
}

export async function runSpam(
  arm: Arm,
  n: number,
  ports: Pick<RunnerPorts, "runIssue" | "load">,
  opts: { maxUsd?: number; now?: () => Date; authorSuffix?: string } = {},
  log: (line: string) => void = () => undefined,
): Promise<SpamResult> {
  const now = opts.now ?? (() => new Date());
  const issues: SpamIssueRow[] = [];
  let cum = 0;
  let first: number | null = null;
  let stopped: string | null = null;
  const stopFor = (next: Estimate): boolean => opts.maxUsd !== undefined && cum + next.ceilingUsd > opts.maxUsd;

  for (const input of spamIssues(arm, n, opts.authorSuffix)) {
    if (stopFor(estimateCase(input, arm))) {
      stopped = `--max-usd ${opts.maxUsd} reached after ${issues.length} issues`;
      break;
    }
    const out = await ports.runIssue(input);
    const stored = await ports.load(out.runId);
    const cost = stored.steps.reduce((s, x) => s + (x.costUsd ?? 0), 0);
    cum += cost;
    const index = issues.length + 1;
    issues.push({ index, status: stored.status, cost_usd: cost, cumulative_usd: cum, run_id: out.runId });
    if (first === null && stored.status === "refused_budget") first = index;
    log(`spam ${index}/${n} ${stored.status} ${fmtUsd(cost)} cum ${fmtUsd(cum)}`);
    if (stored.status === "refused_funds") {
      stopped = "insufficient funds (402)";
      break;
    }
  }

  let legit: SpamResult["legit"] = null;
  if (stopped === null) {
    const input = legitIssue(arm, opts.authorSuffix);
    const out = await ports.runIssue(input);
    const stored = await ports.load(out.runId);
    const cost = stored.steps.reduce((s, x) => s + (x.costUsd ?? 0), 0);
    cum += cost;
    legit = { status: stored.status, served: stored.status === "answered", cost_usd: cost, run_id: out.runId };
    log(`legit ${stored.status} ${fmtUsd(cost)}`);
  }

  return {
    arm,
    n,
    repo: EVAL_REPO,
    updated_at: now().toISOString(),
    spammer: `eval:${arm}:spammer${opts.authorSuffix ?? ""}`,
    legit_author: `eval:${arm}:legit${opts.authorSuffix ?? ""}`,
    issues,
    total_cost_usd: cum,
    first_refusal_index: first,
    legit,
    stopped,
    modeled: stopped === null ? modelCost(issues, first) : null,
  };
}

export function dryRunSpam(arm: Arm, n: number): { total: Estimate; perIssue: Estimate } {
  const all = [...spamIssues(arm, n), legitIssue(arm)].map((i) => estimateCase(i, arm));
  return { total: sumEstimates(all), perIssue: all[0] };
}
