import { classifyOtariError, OtariError } from "./errors";
import type {
  CallOpts,
  ChatBody,
  ChatResponse,
  EndUser,
  EndUserBudget,
  GuardrailHeaderEntry,
  KeyBudget,
  McpCallResult,
  McpTool,
  OtariMeta,
  OtariResult,
  ResponsesBody,
  ResponsesResponse,
} from "./types";

export const DEFAULT_BASE_URL = "https://api.otari.ai/api/v1";
const USER_AGENT = "porter/0.1";

function numHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseMeta(headers: Headers, body: unknown): OtariMeta {
  let guardrails: GuardrailHeaderEntry[] | null = null;
  const g = headers.get("Otari-Guardrails");
  if (g) {
    try {
      const parsed: unknown = JSON.parse(g);
      if (Array.isArray(parsed)) guardrails = parsed as GuardrailHeaderEntry[];
    } catch {
      guardrails = null;
    }
  }
  let costUsd: number | null = null;
  if (body && typeof body === "object") {
    const usage = (body as { usage?: unknown }).usage;
    if (usage && typeof usage === "object") {
      const c = (usage as { cost_usd?: unknown }).cost_usd;
      if (typeof c === "number" && Number.isFinite(c)) costUsd = c;
    }
  }
  return {
    requestId: headers.get("Otari-Request-ID"),
    model: headers.get("Otari-Model"),
    provider: headers.get("Otari-Provider"),
    fallback: (headers.get("Otari-Fallback") ?? "").toLowerCase() === "true",
    attemptCount: numHeader(headers, "Otari-Attempt-Count"),
    guardrails,
    endUserBudget: headers.get("Otari-End-User-Budget"),
    containerId: headers.get("Otari-Container-Id"),
    costUsd,
    durationMs: numHeader(headers, "Otari-Response-Duration-Ms"),
  };
}

export type OtariClient = ReturnType<typeof createOtariClient>;

export function createOtariClient(cfg: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
  const base = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch: typeof fetch = cfg.fetchImpl ?? ((input, init) => fetch(input, init));

  async function send(
    method: string,
    path: string,
    o: { body?: unknown; opts?: CallOpts; signal?: AbortSignal } = {},
  ): Promise<{ res: Response; text: string }> {
    const opts = o.opts ?? {};
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.apiKey}`,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.conversationId) headers["Otari-Conversation-Id"] = opts.conversationId;
    if (opts.tags && Object.keys(opts.tags).length > 0) {
      headers["Otari-Tags"] = Object.entries(opts.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
    }
    if (opts.endUserBudget) headers["Otari-End-User-Budget"] = opts.endUserBudget;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: o.signal ?? opts.signal,
      });
      text = await res.text();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw e;
      // AbortSignal.timeout(): the request may still be running and billed upstream, so callers must not blindly retry.
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new OtariError({ kind: "upstream", status: 0, code: "timeout", message: "Otari request timed out" });
      }
      // Keep only the error class: the original message may echo request details.
      throw new OtariError({
        kind: "upstream",
        status: 0,
        code: "network_error",
        message: `Otari request failed: ${e instanceof Error ? e.name : "unknown"}`,
      });
    }
    if (!res.ok) throw classifyOtariError(res.status, res.headers, text);
    return { res, text };
  }

  function parseJson<T>(res: Response, text: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OtariError({
        kind: "upstream",
        status: res.status,
        code: "invalid_json",
        message: `Otari returned a non-JSON body (status ${res.status})`,
      });
    }
  }

  async function post<T>(path: string, body: unknown, opts: CallOpts): Promise<OtariResult<T>> {
    const { res, text } = await send("POST", path, { body, opts });
    const data = parseJson<T>(res, text);
    return { data, meta: parseMeta(res.headers, data) };
  }

  async function getJson<T>(path: string): Promise<T> {
    const { res, text } = await send("GET", path);
    return parseJson<T>(res, text);
  }

  const endUserPath = (externalId: string) => `/end-users?external_id=${encodeURIComponent(externalId)}`;

  async function writeEndUser(method: "PUT" | "PATCH", externalId: string, body: unknown): Promise<EndUser> {
    const { res, text } = await send(method, endUserPath(externalId), { body });
    return parseJson<EndUser>(res, text);
  }

  return {
    chat: (body: ChatBody, opts: CallOpts = {}) => post<ChatResponse>("/chat/completions", body, opts),
    responses: (body: ResponsesBody, opts: CallOpts = {}) => post<ResponsesResponse>("/responses", body, opts),

    async embed(input: string[], model: string, opts: CallOpts = {}): Promise<number[][]> {
      const { data } = await post<{ data?: Array<{ index?: number; embedding: number[] }> }>(
        "/embeddings",
        { model, input },
        opts,
      );
      const rows = data.data ?? [];
      const ordered = rows.every((r) => typeof r.index === "number")
        ? [...rows].sort((a, b) => (a.index as number) - (b.index as number))
        : rows;
      return ordered.map((r) => r.embedding);
    },

    endUsers: {
      async get(externalId: string): Promise<EndUser | null> {
        const list = await getJson<EndUser[]>(endUserPath(externalId));
        return Array.isArray(list) && list.length > 0 ? list[0] : null;
      },
      put: (externalId: string, budgetId: string) => writeEndUser("PUT", externalId, { budget_id: budgetId }),
      patch: (externalId: string, patch: { blocked?: boolean; budget_id?: string }) =>
        writeEndUser("PATCH", externalId, patch),
    },

    endUserBudgets: () => getJson<EndUserBudget[]>("/end-user-budgets"),
    keyBudget: () => getJson<KeyBudget>("/key/budget"),

    /** Cost settles in the background, so 404 means "not yet" and returns null. */
    async usageForRequest(requestId: string): Promise<{ cost_usd: number; status: string } | null> {
      try {
        return await getJson<{ cost_usd: number; status: string }>(`/usage/requests/${encodeURIComponent(requestId)}`);
      } catch (e) {
        if (e instanceof OtariError && e.status === 404) return null;
        throw e;
      }
    },

    mcp: {
      tools: (serverId: string) =>
        getJson<{ tools: McpTool[]; server_revision: string }>(`/mcp/servers/${encodeURIComponent(serverId)}/tools`),
      /** Never auto-retried: an execute may have side effects. */
      async execute(p: {
        serverId: string;
        toolName: string;
        arguments: Record<string, unknown>;
        serverRevision: string;
        clientExecutionId: string;
        conversationId?: string;
      }): Promise<McpCallResult> {
        const { res, text } = await send("POST", "/mcp/execute", {
          opts: { conversationId: p.conversationId },
          body: {
            mcp_server_id: p.serverId,
            tool_name: p.toolName,
            arguments: p.arguments,
            server_revision: p.serverRevision,
            client_execution_id: p.clientExecutionId,
          },
        });
        return parseJson<McpCallResult>(res, text);
      },
    },
  };
}
