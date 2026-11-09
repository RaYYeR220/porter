import { armClient, runIssue, startRun } from "../agent/pipeline";
import { createDbRecorder } from "../agent/record";
import { db } from "../db/client";
import { drizzleAuthorsStore, type AuthorsDeps } from "../authors";
import { parseFloor } from "../balance";
import { getMaintainerEnv, getRegularBudgetId } from "../env";
import { drizzleProposalStore } from "../github/commands";
import { drizzleKv } from "../kv";
import { createOtariClient } from "../otari/client";
import { ratelimit } from "../ratelimit";
import type { TryDeps } from "../try/handler";
import { dailySalt } from "./common";
import type { AuthorActionDeps } from "./author-actions";
import type { CeilingDeps } from "./ceiling";
import type { ProposalDecisionDeps } from "./proposal-decision";
import { drizzleProposalsReadStore, type ProposalsListDeps } from "./proposals-list";
import { drizzleRunsStore } from "./runs";

const nonEmpty = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);

function newcomerBudgetId(): string {
  const id = nonEmpty(process.env.OTARI_BUDGET_NEWCOMER_ID);
  if (!id) throw new Error("Missing or invalid environment variables: OTARI_BUDGET_NEWCOMER_ID");
  return id;
}

/** Production wiring for the public APIs. Built per call; nothing reads env at import time. */
export const productionApi = {
  kv: () => drizzleKv(),
  runs: () => drizzleRunsStore(),
  /** The one repository whose proposals a maintainer can approve; null until configured. */
  demoRepo: () => nonEmpty(process.env.DEMO_REPO),

  authors(): AuthorsDeps {
    return {
      kv: drizzleKv(),
      store: drizzleAuthorsStore(),
      otari: armClient("porter").otari,
      regularBudgetId: getRegularBudgetId(),
      newcomerBudgetId: newcomerBudgetId(),
    };
  },

  authorActions(): AuthorActionDeps {
    return { limit: (k, n, w) => ratelimit(k, n, w), salt: () => dailySalt(), authors: productionApi.authors(), kv: drizzleKv() };
  },

  try(defer: (work: () => Promise<void>) => void): TryDeps {
    return {
      demoRepo: nonEmpty(process.env.DEMO_REPO),
      salt: () => dailySalt(),
      limit: (k, n, w) => ratelimit(k, n, w),
      funds: {
        kv: drizzleKv(),
        // Lazy: a missing Otari key must not break the paused / unconfigured paths.
        keyBudget: () => armClient("porter").otari.keyBudget(),
        floorUsd: parseFloor(process.env.BALANCE_FLOOR_USD),
      },
      startRun: (input) => startRun(input, {}),
      runIssue: (input, runId) => runIssue(input, { otari: armClient("porter").otari, runId }),
      skipRun: async (runId, reason) => {
        const rec = createDbRecorder(db());
        await rec.addStep(runId, {
          role: "warning", requestedModel: null, servedModel: null, provider: null, fallback: false, attemptCount: null,
          requestId: null, costUsd: null, durationMs: null, guardrails: null, toolCalls: null,
          errorKind: `skipped: ${reason}`, errorStatus: null,
        });
        await rec.finishRun(runId, { status: "failed", reply: null, triage: null, totalCostUsd: 0, finishedAt: new Date() });
      },
      defer,
    };
  },

  ceiling(): CeilingDeps {
    // Lazy: a missing Otari key becomes "unavailable", not a failed console.
    return { kv: drizzleKv(), keyBudget: () => armClient("porter").otari.keyBudget() };
  },

  proposalsList(): ProposalsListDeps {
    return { store: drizzleProposalsReadStore(), demoRepo: nonEmpty(process.env.DEMO_REPO) };
  },

  proposals(): ProposalDecisionDeps {
    const m = getMaintainerEnv();
    return {
      store: drizzleProposalStore(),
      otari: createOtariClient({ apiKey: m.apiKey, baseUrl: m.baseUrl }),
      mcpServerId: m.mcpServerId,
      limit: (k, n, w) => ratelimit(k, n, w),
      salt: () => dailySalt(),
      demoRepo: nonEmpty(process.env.DEMO_REPO),
    };
  },
};
