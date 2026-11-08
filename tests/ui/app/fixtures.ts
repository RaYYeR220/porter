import type { Author, RunDetail, Step } from "../../../components/app/types";

export const RUN_ID = "0b6a3c8e-5d1f-4c2a-9e7b-2f4d6a8c0e11";

let nextStep = 1;

export function step(s: Partial<Step> & { role: string }): Step {
  return {
    id: nextStep++,
    runId: RUN_ID,
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
    createdAt: "2026-11-08T10:00:01.000Z",
    ...s,
  };
}

export function detail(status: string, steps: Step[] = [], over: Partial<RunDetail["run"]> = {}): RunDetail {
  return {
    run: {
      id: RUN_ID,
      source: "web",
      arm: "porter",
      repo: "demo/porter-ui-seed",
      issueNumber: null,
      authorExternalId: "web:5eed000000000001",
      title: "Export button does nothing in Firefox",
      status,
      totalCostUsd: steps.reduce((n, s) => n + (s.costUsd ?? 0), 0),
      createdAt: "2026-11-08T10:00:00.000Z",
      finishedAt: status === "running" ? null : "2026-11-08T10:00:09.000Z",
      body: "Clicking Export does nothing.",
      reply: null,
      triage: null,
      ...over,
    },
    steps,
    guardVerdicts: [],
    proposals: [],
    queued: false,
    reviewItem: false,
  };
}

export const triageOk = (over: Partial<Step> = {}) =>
  step({
    role: "triage",
    requestedModel: "porter-triage",
    servedModel: "openai/gpt-oss-120b",
    provider: "groq",
    requestId: "req_triage_1",
    costUsd: 0.00042,
    durationMs: 2140,
    guardrails: [
      { profile: "prompt-injection", mode: "block", valid: true, score: 0.03, status: "evaluated" },
      { profile: "secrets", mode: "block", valid: true, score: 0, status: "evaluated" },
    ],
    ...over,
  });

export function author(over: Partial<Author> = {}): Author {
  return {
    id: "web:5eed000000000001",
    display: "visitor 5eed…",
    tier: "newcomer",
    budgetId: "b_newcomer",
    budgetName: "newcomer",
    budgetLimitUsd: 0.05,
    spendUsd: 0.0125,
    remainingUsd: 0.0375,
    requests: 4,
    nextResetAt: "2026-11-09T00:00:00.000Z",
    blocked: false,
    refreshedAt: "2026-11-08T10:00:00.000Z",
    ...over,
  };
}
