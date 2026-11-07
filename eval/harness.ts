import type { IssueInput, RunOutcome } from "../lib/agent/pipeline";
import { FIXTURE_HOST } from "./corpus";
import type { AttackCase, BenignCase } from "./corpus";
import { estimateCase, fmtUsd, sumEstimates } from "./estimate";
import type { Estimate } from "./estimate";
import { scoreAttack, scoreBenign } from "./score";
import type { BlockedAt, StoredRun } from "./score";

export type Arm = "porter" | "baseline";
export type EvalSet = "attacks" | "benign";

export const EVAL_REPO = "mozilla-ai/otari";
export { FIXTURE_HOST };
/** Attack cases get a number that looks filed; benign cases keep the issue's real number. */
export const ATTACK_NUMBER_BASE = 910_000;

export const authorFor = (arm: Arm, caseId: string) => `eval:${arm}:${caseId}`;

/** What the harness reads back about a finished run: the stored row and steps. */
export type StoredRunDetail = StoredRun & {
  costUsd: number;
  steps: Array<StoredRun["steps"][number] & { costUsd?: number | null }>;
};

export interface RunnerPorts {
  runIssue(input: IssueInput): Promise<RunOutcome>;
  load(runId: string): Promise<StoredRunDetail>;
  save(row: EvalRow): Promise<void>;
  clock?: () => number;
}

export type EvalRow = {
  id: string;
  set: EvalSet;
  arm: Arm;
  technique?: string;
  goal?: AttackCase["goal"];
  securityWorded?: boolean;
  status: string;
  hijacked: boolean;
  falseBlock: boolean;
  blocked_at: BlockedAt;
  inconclusive: boolean;
  reason: string;
  /** Sum of the run's step costUsd. Guard-model calls bill to a separate workspace and are not in it. */
  cost_usd: number;
  latency_ms: number;
  run_id: string;
};

export type EvalFile = {
  arm: Arm;
  set: EvalSet;
  repo: string;
  updated_at: string;
  preregistration: string;
  totals: Totals;
  stopped: { reason: string; remaining: string[] } | null;
  cases: EvalRow[];
};

export type Totals = {
  cases: number;
  /** Cases with a verdict: cases minus inconclusive. */
  conclusive: number;
  hijacked: number;
  falseBlocks: number;
  inconclusive: number;
  blocked_at: Record<string, number>;
  cost_usd: number;
};

export function totalsOf(rows: EvalRow[]): Totals {
  const blocked_at: Record<string, number> = {};
  for (const r of rows) {
    const k = r.blocked_at ?? "none";
    blocked_at[k] = (blocked_at[k] ?? 0) + 1;
  }
  return {
    cases: rows.length,
    conclusive: rows.filter((r) => !r.inconclusive).length,
    hijacked: rows.filter((r) => r.hijacked).length,
    falseBlocks: rows.filter((r) => r.falseBlock).length,
    inconclusive: rows.filter((r) => r.inconclusive).length,
    blocked_at,
    cost_usd: rows.reduce((s, r) => s + r.cost_usd, 0),
  };
}

/** Rows from a new invocation replace stored rows with the same id, so a resumed run never loses finished cases. */
export function mergeRows(previous: EvalRow[], fresh: EvalRow[], order: string[]): EvalRow[] {
  const byId = new Map(previous.map((r) => [r.id, r]));
  for (const r of fresh) byId.set(r.id, r);
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...byId.values()].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
}

export type Planned = {
  id: string;
  input: IssueInput;
  shape: { title: string; body: string; hasPage: boolean };
  meta: { technique?: string; goal?: AttackCase["goal"]; securityWorded?: boolean };
  attack?: AttackCase;
};

export function planAttacks(arm: Arm, cases: AttackCase[]): Planned[] {
  return cases.map((c, i) => ({
    id: c.id,
    input: {
      source: "eval",
      arm,
      repo: EVAL_REPO,
      number: ATTACK_NUMBER_BASE + i,
      title: c.title,
      body: c.body,
      authorExternalId: authorFor(arm, c.id),
    },
    shape: { title: c.title, body: c.body, hasPage: Boolean(c.page) },
    meta: { technique: c.technique, goal: c.goal },
    attack: c,
  }));
}

export function planBenign(arm: Arm, cases: BenignCase[]): Planned[] {
  return cases.map((c, i) => ({
    id: c.id,
    input: {
      source: "eval",
      arm,
      repo: EVAL_REPO,
      number: c.number ?? ATTACK_NUMBER_BASE + 5_000 + i,
      title: c.title,
      body: c.body,
      authorExternalId: authorFor(arm, c.id),
    },
    shape: { title: c.title, body: c.body, hasPage: false },
    meta: { securityWorded: c.securityWorded },
  }));
}

export function filterIds<T extends { id: string }>(all: T[], ids?: string[]): T[] {
  if (!ids || ids.length === 0) return all;
  const unknown = ids.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`unknown case ids: ${unknown.join(", ")}`);
  return all.filter((c) => ids.includes(c.id));
}

export type DryRun = { cases: Array<{ id: string; estimate: Estimate }>; total: Estimate };

export function dryRun(arm: Arm, plan: Planned[]): DryRun {
  const cases = plan.map((p) => ({ id: p.id, estimate: estimateCase(p.shape, arm) }));
  return { cases, total: sumEstimates(cases.map((c) => c.estimate)) };
}

export function formatDryRun(arm: Arm, set: string, d: DryRun): string {
  return [
    `[dry-run] arm=${arm} set=${set} cases=${d.cases.length} (no Otari calls)`,
    `  expected ${fmtUsd(d.total.expectedUsd)}   ceiling ${fmtUsd(d.total.ceilingUsd)}   guard workspace ${fmtUsd(d.total.guardUsd)} (billed apart)`,
  ].join("\n");
}

export type RunOptions = { arm: Arm; set: EvalSet; maxUsd?: number };

/**
 * Runs the planned cases one after another. Before each case, stops if the money spent in this
 * invocation plus that case's ceiling would pass `maxUsd`. Scores from the stored run, never the reply's own words.
 */
export async function runCases(
  plan: Planned[],
  opts: RunOptions,
  ports: RunnerPorts,
  log: (line: string) => void = () => undefined,
): Promise<{ rows: EvalRow[]; stopped: EvalFile["stopped"]; spentUsd: number }> {
  const clock = ports.clock ?? Date.now;
  const rows: EvalRow[] = [];
  let spent = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (opts.maxUsd !== undefined) {
      const next = estimateCase(p.shape, opts.arm).ceilingUsd;
      if (spent + next > opts.maxUsd) {
        const remaining = plan.slice(i).map((x) => x.id);
        log(`stop: ${fmtUsd(spent)} spent, next case ceiling ${fmtUsd(next)} would pass --max-usd ${opts.maxUsd}`);
        return { rows, stopped: { reason: `--max-usd ${opts.maxUsd} reached`, remaining }, spentUsd: spent };
      }
    }
    const t0 = clock();
    const outcome = await ports.runIssue(p.input);
    const latency = clock() - t0;
    const stored = await ports.load(outcome.runId);
    const cost = stored.steps.reduce((s, x) => s + (x.costUsd ?? 0), 0);
    spent += cost;

    let row: EvalRow;
    if (opts.set === "attacks") {
      const s = scoreAttack(p.attack!, stored);
      row = {
        id: p.id, set: "attacks", arm: opts.arm, ...p.meta, status: stored.status,
        hijacked: s.hijacked, falseBlock: false, blocked_at: s.blocked_at, inconclusive: s.inconclusive,
        reason: s.reason, cost_usd: cost, latency_ms: latency, run_id: outcome.runId,
      };
    } else {
      const s = scoreBenign(stored);
      row = {
        id: p.id, set: "benign", arm: opts.arm, ...p.meta, status: stored.status,
        hijacked: false, falseBlock: s.falseBlock, blocked_at: s.blocked_at, inconclusive: s.inconclusive,
        reason: s.falseBlock ? `held at ${s.blocked_at}` : s.inconclusive ? `inconclusive: run ended ${stored.status}` : "answered",
        cost_usd: cost, latency_ms: latency, run_id: outcome.runId,
      };
    }
    await ports.save(row);
    rows.push(row);
    if (outcome.status === "refused_funds") {
      const remaining = plan.slice(i + 1).map((x) => x.id);
      log("stop: the gateway answered 402 (insufficient funds)");
      return { rows, stopped: { reason: "insufficient funds (402)", remaining }, spentUsd: spent };
    }
    log(`${row.id} ${row.status} ${opts.set === "attacks" ? (row.hijacked ? "HIJACKED" : "held-off") : row.falseBlock ? "FALSE-BLOCK" : "ok"} ${fmtUsd(cost)}`);
  }
  return { rows, stopped: null, spentUsd: spent };
}

export function buildEvalFile(
  arm: Arm,
  set: EvalSet,
  rows: EvalRow[],
  stopped: EvalFile["stopped"],
  now: Date = new Date(),
): EvalFile {
  return {
    arm,
    set,
    repo: EVAL_REPO,
    updated_at: now.toISOString(),
    preregistration: "eval/PREREGISTRATION.md",
    totals: totalsOf(rows),
    stopped,
    cases: rows,
  };
}
