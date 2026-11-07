import type { IssueInput, RunOutcome } from "../lib/agent/pipeline";
import { estimateCase, fmtUsd } from "../eval/estimate";
import type { Planned } from "../eval/harness";
import { SHADOW_REPO, shadowEndUserId, shadowIssueFrom } from "../lib/shadow";
import type { SampledBy, ShadowIssue, SnapshotIssue } from "../lib/shadow";

/** Ports for the shadow run; real ones live in scripts/shadow.ts, tests use fakes. */
export interface ShadowPorts {
  runIssue(input: IssueInput): Promise<RunOutcome>;
  load(runId: string): Promise<{ status: string; triage: unknown; costUsd: number }>;
  clock?: () => number;
}

/** Plan in the eval harness's shape, so the eval's dry-run estimate is reused as is. Source "shadow", arm porter. */
export function planShadow(issues: SnapshotIssue[]): Planned[] {
  return issues.map((i) => ({
    id: String(i.number),
    input: {
      source: "shadow",
      arm: "porter",
      repo: SHADOW_REPO,
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      authorExternalId: shadowEndUserId(i.author),
    },
    shape: { title: i.title, body: i.body ?? "", hasPage: false },
    meta: {},
  }));
}

export type ShadowRunResult = {
  issues: ShadowIssue[];
  stopped: { reason: string; remaining: number[] } | null;
  spentUsd: number;
};

/**
 * Runs the plan one issue after another. Before each issue, stops if the generation spend so far plus
 * that issue's ceiling would pass `maxUsd`. Guard-model calls bill to the guard workspace and are not counted.
 * `onIssue` fires after every finished issue (the CLI writes the file there, so a stop loses nothing).
 */
export async function runShadow(
  plan: Planned[],
  opts: { maxUsd?: number; /** issue numbers in the snapshot, for flagging dangling duplicate claims */ known?: Set<number>; sampledBy?: SampledBy },
  ports: ShadowPorts,
  log: (line: string) => void = () => undefined,
  onIssue: (issues: ShadowIssue[]) => void | Promise<void> = () => undefined,
): Promise<ShadowRunResult> {
  const clock = ports.clock ?? Date.now;
  const sampledBy = opts.sampledBy ?? { seed: "", mode: "sample" as const, at: new Date(0).toISOString() };
  const issues: ShadowIssue[] = [];
  let spent = 0;
  const rest = (from: number) => plan.slice(from).map((p) => p.input.number as number);
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    if (opts.maxUsd !== undefined) {
      const next = estimateCase(p.shape, "porter").ceilingUsd;
      if (spent + next > opts.maxUsd) {
        log(`stop: ${fmtUsd(spent)} spent, next issue ceiling ${fmtUsd(next)} would pass --max-usd ${opts.maxUsd}`);
        return { issues, stopped: { reason: `--max-usd ${opts.maxUsd} reached`, remaining: rest(i) }, spentUsd: spent };
      }
    }
    const t0 = clock();
    const outcome = await ports.runIssue(p.input);
    const latencyMs = clock() - t0;
    const stored = await ports.load(outcome.runId);
    spent += stored.costUsd;
    const issue = shadowIssueFrom(
      { number: p.input.number as number, title: p.input.title, runId: outcome.runId, sampledBy, status: stored.status, costUsd: stored.costUsd, latencyMs },
      stored.triage,
      opts.known ? (n) => opts.known!.has(n) : undefined,
    );
    issues.push(issue);
    await onIssue(issues);
    log(`#${issue.number} ${issue.status} ${issue.kind ?? "-"} dup=${issue.duplicates.length} fixed=${issue.fixed_in ? issue.fixed_in.version : "-"} ${fmtUsd(stored.costUsd)}`);
    if (outcome.status === "refused_funds") {
      log("stop: the gateway answered 402 (insufficient funds)");
      return { issues, stopped: { reason: "insufficient funds (402)", remaining: rest(i + 1) }, spentUsd: spent };
    }
  }
  return { issues, stopped: null, spentUsd: spent };
}
