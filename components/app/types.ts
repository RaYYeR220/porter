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
  /** List rows only: the model Otari served for the triage call. */
  servedModel?: string | null;
  /** List rows only: proposals of this run still waiting for a maintainer. */
  pendingProposals?: number;
  /** List rows only: for a held run, whether the gateway or the output check held it. */
  heldBy?: "gateway" | "output" | null;
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
  decidedBy?: string | null;
  execution: unknown;
  createdAt: string;
  decidedAt: string | null;
  /** From GET /api/proposals: the issue it belongs to. */
  repo?: string;
  issueNumber?: number | null;
  title?: string | null;
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
