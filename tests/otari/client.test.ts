import { describe, expect, it } from "vitest";
import { createOtariClient, parseMeta } from "../../lib/otari/client";
import { OtariError } from "../../lib/otari/errors";

type Call = { url: string; init: RequestInit };

function fake(responses: Array<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return r;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });

const BASE = "https://example.test/api/v1";

describe("chat", () => {
  it("sends auth, trace headers and passes extra body fields through", async () => {
    const { calls, fetchImpl } = fake([
      json(
        { choices: [], usage: { cost_usd: 0.0004 } },
        {
          headers: {
            "Otari-Request-ID": "req_1",
            "Otari-Model": "openai/gpt-oss-20b",
            "Otari-Fallback": "true",
            "Otari-Attempt-Count": "2",
          },
        },
      ),
    ]);
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl });
    const { meta } = await client.chat(
      {
        model: "openai/gpt-oss-20b",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
        user: "gh:octocat",
        mcp_server_ids: ["srv"],
        max_tool_iterations: 3,
      },
      { conversationId: "run-1", tags: { app: "porter", role: "triage" } },
    );
    const { url, init } = calls[0];
    const h = init.headers as Record<string, string>;
    expect(url).toBe(`${BASE}/chat/completions`);
    expect(init.method).toBe("POST");
    expect(h.Authorization).toBe("Bearer k");
    expect(h["Otari-Conversation-Id"]).toBe("run-1");
    expect(h["Otari-Tags"]).toBe("app=porter,role=triage");
    expect(h["User-Agent"]).toBe("porter/0.1");
    const sent = JSON.parse(init.body as string);
    expect(sent.user).toBe("gh:octocat");
    expect(sent.mcp_server_ids).toEqual(["srv"]);
    expect(sent.max_tool_iterations).toBe(3);
    expect(meta).toMatchObject({
      requestId: "req_1",
      model: "openai/gpt-oss-20b",
      fallback: true,
      attemptCount: 2,
      costUsd: 0.0004,
    });
  });

  it("throws a classified error and never leaks the key", async () => {
    const { fetchImpl } = fake([
      new Response(JSON.stringify({ detail: "x", code: "budget_exceeded" }), {
        status: 403,
        headers: { "Otari-Error-Code": "budget_exceeded", "Otari-Budget-Scope": "user", "Retry-After": "60" },
      }),
    ]);
    const client = createOtariClient({ apiKey: "sekret-key", baseUrl: BASE, fetchImpl });
    const err = await client.chat({ model: "m", messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OtariError);
    expect((err as OtariError).kind).toBe("budget_exceeded");
    expect((err as OtariError).message).not.toContain("sekret-key");
  });

  it("turns a non-JSON 200 into an upstream error", async () => {
    const { fetchImpl } = fake([new Response("<html>oops</html>", { status: 200 })]);
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl });
    const err = (await client.chat({ model: "m", messages: [] }).catch((e: unknown) => e)) as OtariError;
    expect(err.kind).toBe("upstream");
  });

  it("wraps network failures without leaking the key", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed Bearer sekret-key");
    }) as typeof fetch;
    const client = createOtariClient({ apiKey: "sekret-key", baseUrl: BASE, fetchImpl });
    const err = (await client.chat({ model: "m", messages: [] }).catch((e: unknown) => e)) as OtariError;
    expect(err.kind).toBe("upstream");
    expect(err.message).not.toContain("sekret-key");
  });
});

describe("parseMeta", () => {
  it("reads the guardrails header and tolerates junk", () => {
    const g = [{ profile: "prompt-injection", mode: "monitor", valid: false, score: 0.9, status: "evaluated" }];
    expect(parseMeta(new Headers({ "Otari-Guardrails": JSON.stringify(g) }), {}).guardrails).toEqual(g);
    expect(parseMeta(new Headers({ "Otari-Guardrails": "not json" }), {}).guardrails).toBeNull();
    const empty = parseMeta(new Headers(), null);
    expect(empty).toMatchObject({ requestId: null, fallback: false, attemptCount: null, costUsd: null });
  });
});

describe("embed", () => {
  it("returns vectors in input order", async () => {
    const { calls, fetchImpl } = fake([
      json({
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      }),
    ]);
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl });
    expect(await client.embed(["a", "b"], "emb-model")).toEqual([[1], [2]]);
    expect(calls[0].url).toBe(`${BASE}/embeddings`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ model: "emb-model", input: ["a", "b"] });
  });
});

describe("endUsers and usage", () => {
  it("gets by query form and returns null on empty", async () => {
    const { calls, fetchImpl } = fake([
      json([]),
      json([{ external_id: "gh:octocat", blocked: false, spend: 0, budget_id: "b" }]),
    ]);
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl });
    expect(await client.endUsers.get("gh:octocat")).toBeNull();
    expect(calls[0].url).toBe(`${BASE}/end-users?external_id=gh%3Aoctocat`);
    expect((await client.endUsers.get("gh:octocat"))?.external_id).toBe("gh:octocat");
  });

  it("lists end users with a clamped limit", async () => {
    const { calls, fetchImpl } = fake([json([{ external_id: "gh:a", blocked: false, spend: 1, budget_id: "b" }]), json({ oops: true })]);
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl });
    const rows = await client.endUsers.list(5000);
    expect(calls[0].url).toBe(`${BASE}/end-users?limit=1000`);
    expect(rows).toHaveLength(1);
    expect(await client.endUsers.list(10)).toEqual([]);
  });

  it("puts and patches with the right method and body", async () => {
    const u = { external_id: "gh:a", blocked: true, spend: 0, budget_id: "b" };
    const { calls, fetchImpl } = fake([json(u, { status: 201 }), json(u)]);
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl });
    await client.endUsers.put("gh:a", "b");
    await client.endUsers.patch("gh:a", { blocked: true });
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ budget_id: "b" });
    expect(calls[1].init.method).toBe("PATCH");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ blocked: true });
  });

  it("usageForRequest returns null on 404", async () => {
    const { fetchImpl } = fake([new Response("{}", { status: 404 })]);
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl });
    expect(await client.usageForRequest("req_1")).toBeNull();
  });
});

describe("mcp", () => {
  it("lists tools and executes with the documented body", async () => {
    const { calls, fetchImpl } = fake([
      json({ tools: [{ name: "t" }], server_revision: "r1" }),
      json({ content: [{ type: "text", text: "ok" }] }),
    ]);
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl });
    expect((await client.mcp.tools("srv")).server_revision).toBe("r1");
    expect(calls[0].url).toBe(`${BASE}/mcp/servers/srv/tools`);
    await client.mcp.execute({
      serverId: "srv",
      toolName: "t",
      arguments: { a: 1 },
      serverRevision: "r1",
      clientExecutionId: "x1",
    });
    expect(calls[1].url).toBe(`${BASE}/mcp/execute`);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      mcp_server_id: "srv",
      tool_name: "t",
      arguments: { a: 1 },
      server_revision: "r1",
      client_execution_id: "x1",
    });
  });
});

describe("transport failures", () => {
  /** Never answers; rejects with the signal's reason once it aborts, like fetch does. */
  const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;

  it("classifies a client-side timeout as code timeout, not a network error", async () => {
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl: hanging });
    const err = await client
      .chat({ model: "m", messages: [] }, { signal: AbortSignal.timeout(20) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OtariError);
    expect(err).toMatchObject({ kind: "upstream", code: "timeout", status: 0 });
  });

  it("still rethrows a caller's abort as is", async () => {
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl: hanging });
    const ac = new AbortController();
    const p = client.chat({ model: "m", messages: [] }, { signal: ac.signal });
    ac.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(OtariError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("keeps invalid_json for a 2xx with a non-JSON body", async () => {
    const fetchImpl = (async () => new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    const client = createOtariClient({ apiKey: "k", baseUrl: BASE, fetchImpl });
    const err = await client.chat({ model: "m", messages: [] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "upstream", code: "invalid_json", status: 200 });
  });
});

describe("parseMeta cost", () => {
  const h = new Headers();
  it("reads cost_usd sent as a decimal string, as hosted Otari does", () => {
    expect(parseMeta(h, { usage: { cost_usd: "0.000021", estimated_cost: 0.0000213 } }).costUsd).toBeCloseTo(0.000021, 9);
  });
  it("falls back to estimated_cost when cost_usd is missing or unparseable", () => {
    expect(parseMeta(h, { usage: { estimated_cost: 0.0000213 } }).costUsd).toBeCloseTo(0.0000213, 9);
    expect(parseMeta(h, { usage: { cost_usd: "n/a", estimated_cost: 0.00002 } }).costUsd).toBeCloseTo(0.00002, 9);
  });
  it("rejects negative or non-finite values", () => {
    expect(parseMeta(h, { usage: { cost_usd: "-1" } }).costUsd).toBeNull();
    expect(parseMeta(h, { usage: { cost_usd: "Infinity" } }).costUsd).toBeNull();
    expect(parseMeta(h, { usage: {} }).costUsd).toBeNull();
  });
});
