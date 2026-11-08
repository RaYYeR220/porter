/** The JSON the public APIs return, as the browser receives it (dates are ISO strings). */

export type RunRow = {
  id: string;
  source: string;
  arm: string;
  repo: string;
  issueNumber: number | null;
  authorExternalId: string | null;
  title: string | null;
  status: string;
  totalCostUsd: number;
  createdAt: string;
  finishedAt: string | null;
};

export type Step = {
  id: number;
  runId: string;
  role: string;
  requestedModel: string | null;
  servedModel: string | null;
  provider: string | null;
  fallback: boolean;
  attemptCount: number | null;
  requestId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  guardrails: unknown;
  toolCalls: unknown;
  errorKind: string | null;
  errorStatus: number | null;
  createdAt: string;
};

export type GuardVerdict = {
  id: number;
  runId: string | null;
  profile: string;
  valid: boolean;
  score: number | null;
  explanation: string | null;
  latencyMs: number | null;
  createdAt: string;
};

export type Proposal = {
  id: number;
  runId: string;
  action: string;
  args: Record<string, unknown> | null;
  status: string;
  decidedBy: string | null;
  execution: unknown;
  createdAt: string;
  decidedAt: string | null;
};

export type RunDetail = {
  run: RunRow & { body: string | null; reply: string | null; triage: unknown };
  steps: Step[];
  guardVerdicts: GuardVerdict[];
  proposals: Proposal[];
  queued: boolean;
  reviewItem: boolean;
};

export type RunsPage = { runs: RunRow[]; nextCursor: string | null };

export type Author = {
  id: string;
  display: string;
  tier: "newcomer" | "regular";
  budgetId: string | null;
  budgetName: string | null;
  budgetLimitUsd: number | null;
  spendUsd: number;
  remainingUsd: number | null;
  requests: number;
  nextResetAt: string | null;
  blocked: boolean;
  refreshedAt: string | null;
};
