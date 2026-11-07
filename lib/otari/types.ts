export type GuardrailHeaderEntry = {
  profile: string;
  mode?: string;
  valid: boolean | null;
  score: number | null;
  status?: "evaluated" | "inconclusive" | "unavailable" | string;
  reason?: string | null;
};

export type OtariMeta = {
  requestId: string | null;
  model: string | null;
  provider: string | null;
  fallback: boolean;
  attemptCount: number | null;
  guardrails: GuardrailHeaderEntry[] | null;
  endUserBudget: string | null;
  containerId: string | null;
  costUsd: number | null;
  durationMs: number | null;
};

export type CallOpts = {
  conversationId?: string;
  tags?: Record<string, string>;
  endUserBudget?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

/** Loose body: the fields we use are typed, everything else (Otari extras included) passes through. */
export type ChatBody = {
  model: string;
  messages: Array<Record<string, unknown>>;
  max_tokens?: number;
  user?: string;
  mcp_server_ids?: string[];
  max_tool_iterations?: number;
  guardrails?: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

export type ResponsesBody = {
  model: string;
  input: unknown;
  max_output_tokens?: number;
  user?: string;
  [k: string]: unknown;
};

export type ChatResponse = {
  choices?: Array<{
    message?: { role?: string; content?: string | null; [k: string]: unknown };
    finish_reason?: string | null;
    [k: string]: unknown;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost_usd?: number; [k: string]: unknown };
  otari_tool_calls?: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

export type ResponsesResponse = Record<string, unknown>;

export type OtariResult<T> = { data: T; meta: OtariMeta };

export type EndUser = {
  user_id?: string;
  external_id: string;
  budget_id: string | null;
  blocked: boolean;
  spend: number;
  reserved?: number;
  current_tokens?: number;
  current_requests?: number;
  next_budget_reset_at?: string | null;
  created_at?: string;
  [k: string]: unknown;
};

export type EndUserBudget = {
  budget_id: string;
  name?: string | null;
  max_budget?: number | null;
  [k: string]: unknown;
};

export type KeyBudget = {
  budgets_enforced: boolean;
  remaining_usd: number | null;
  limits: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; [k: string]: unknown };

export type McpCallResult = {
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
  [k: string]: unknown;
};
