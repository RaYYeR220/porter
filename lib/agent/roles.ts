export type Role = "triage" | "repro" | "review";

/** Model = an Otari routing-policy name (configured per workspace), never a raw model id. */
export const ROLES: Record<Role, { model: string; maxTokens: number }> = {
  triage: { model: "porter-triage", maxTokens: 900 },
  repro: { model: "porter-repro", maxTokens: 700 },
  review: { model: "porter-review", maxTokens: 1200 },
};

/** Gateway tool-loop rounds per role. The last round offers no tools and forces an answer. */
export const MAX_TOOL_ITERATIONS = { triage: 6, repro: 3 } as const;

/** Client-side ceiling per call; the whole run must fit a 300 s function. */
export const STEP_TIMEOUT_MS: Record<Role, number> = { triage: 120_000, repro: 90_000, review: 60_000 };
export const RUN_DEADLINE_MS = 270_000;
