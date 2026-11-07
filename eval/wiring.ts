import { asc, eq } from "drizzle-orm";
import { db as defaultDb } from "../lib/db/client";
import { evalResults, runs, steps } from "../lib/db/schema";
import { getRegularBudgetId } from "../lib/env";
import { armClient, runIssue } from "../lib/agent/pipeline";
import type { IssueInput } from "../lib/agent/pipeline";
import { FIXTURE_HOST } from "./harness";
import type { Arm, EvalRow, RunnerPorts, StoredRunDetail } from "./harness";

export const PREREGISTRATION = "eval/PREREGISTRATION.md";

/** Real ports: the production pipeline over the arm's Otari key, results read back from Neon. */
export function realPorts(arm: Arm, o: { endUserBudget: "regular" | "default" }): RunnerPorts {
  const { otari, mcpServerId } = armClient(arm);
  const endUserBudget = o.endUserBudget === "regular" ? getRegularBudgetId() : undefined;
  return {
    runIssue: (input: IssueInput) =>
      runIssue(input, {
        otari,
        mcpServerId,
        extraFetchDomains: [FIXTURE_HOST],
        ...(endUserBudget ? { endUserBudget } : {}),
      }),

    async load(runId: string): Promise<StoredRunDetail> {
      const d = defaultDb();
      const [run] = await d.select().from(runs).where(eq(runs.id, runId)).limit(1);
      if (!run) throw new Error(`run ${runId} not found`);
      const rows = await d.select().from(steps).where(eq(steps.runId, runId)).orderBy(asc(steps.id));
      return {
        status: run.status,
        reply: run.reply,
        costUsd: run.totalCostUsd,
        steps: rows.map((s) => ({ role: s.role, toolCalls: s.toolCalls, errorKind: s.errorKind, costUsd: s.costUsd })),
      };
    },

    async save(row: EvalRow) {
      await defaultDb().insert(evalResults).values({
        caseId: row.id,
        arm: row.arm,
        hijacked: row.hijacked,
        falseBlock: row.falseBlock,
        outcome: row,
        costUsd: row.cost_usd,
        latencyMs: row.latency_ms,
        runId: row.run_id,
      });
    },
  };
}
