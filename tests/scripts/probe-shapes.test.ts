import { describe, expect, it } from "vitest";
import { canaryDecision, listSummary, recordingFetch, redact, row, secretValues, verdict } from "../../scripts/probe-shapes-core";
import type { Exchange } from "../../scripts/probe-shapes-core";

describe("probe-shapes: the funds canary fails closed", () => {
  it("402 (insufficient funds) lets the model probes run", () => {
    expect(canaryDecision([402], false)).toEqual({ runModels: true, note: null });
  });

  it.each([429, 500, 502, 503, 401, 404, 400])("status %i skips the model probes as inconclusive", (status) => {
    const d = canaryDecision([status], false);
    expect(d.runModels).toBe(false);
    expect(d.note).toBe(`canary inconclusive (status ${status}), skipping model probes`);
  });

  it("a canary that threw (timeout, network) skips the model probes", () => {
    expect(canaryDecision([], false)).toEqual({ runModels: false, note: "canary inconclusive (status none), skipping model probes" });
  });

  it.each([200, 201])("a served canary (%i) means the org has funds: skip unless --allow-spend", (status) => {
    const d = canaryDecision([status], false);
    expect(d.runModels).toBe(false);
    expect(d.note).toMatch(/has funds/);
    expect(canaryDecision([status], true)).toEqual({ runModels: true, note: null });
  });

  it("--allow-spend sends the model probes whatever the canary said", () => {
    for (const s of [[], [429], [500]]) expect(canaryDecision(s, true).runModels).toBe(true);
  });

  it("the last exchange decides when the canary made more than one", () => {
    expect(canaryDecision([500, 402], false).runModels).toBe(true);
    expect(canaryDecision([402, 500], false).runModels).toBe(false);
  });
});

describe("probe-shapes: list routes print counts, not bodies", () => {
  it("counts a JSON array and never echoes it", () => {
    const body = JSON.stringify([{ external_id: "web:0b772a7c84c08af9", spend: 0 }, { external_id: "gh:alice" }]);
    expect(listSummary(body)).toBe("2 items (body omitted)");
    expect(listSummary("[{}]")).toBe("1 item (body omitted)");
    expect(listSummary("not json")).toBe("body omitted");
    expect(listSummary('{"a":1}')).toBe("body omitted");
  });
});

describe("probe-shapes: never prints a secret", () => {
  const env = {
    OTARI_KEY_STRANGERS: "otk_live_abcdefghijklmnop",
    GUARD_TOKEN: "guard-token-1234567890",
    DATABASE_URL: "postgres://user:pw@host/db",
    OTARI_BASE_URL: "https://eu.api.otari.ai/api/v1",
    OTARI_BUDGET_NEWCOMER_ID: "b079c24e-787d-4be5-95e5-94f5de293346",
  };

  it("collects key, token and connection-string values only", () => {
    expect(secretValues(env).sort()).toEqual([env.DATABASE_URL, env.GUARD_TOKEN, env.OTARI_KEY_STRANGERS].sort());
  });

  it("redacts env secrets, anything shaped like an Otari key and bearer tokens, and cuts long bodies", () => {
    const body = `{"detail":"bad key otk_live_abcdefghijklmnop, also otk_other1234567 and Bearer xyz.abc; token guard-token-1234567890"}`;
    const out = redact(body, secretValues(env));
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("other1234567");
    expect(out).not.toContain("xyz.abc");
    expect(out).not.toContain("guard-token-1234567890");
    expect(redact("x".repeat(500), [], 100)).toHaveLength(101);
  });
});

describe("probe-shapes: what a status means on a $0 balance", () => {
  it.each([
    [402, '{"code":"insufficient_funds"}', "model", "shape accepted (stopped at funds)"],
    [400, '{"detail":"otari_web_fetch declarations may contain only the type field"}', "model", "SHAPE REJECTED"],
    [422, "{}", "model", "SHAPE REJECTED"],
    [200, "{}", "model", "SERVED: the balance is not zero"],
    [200, "{}", "api", "ok"],
    [403, '{"detail":{"code":"guardrail_violation"}}', "model", "shape accepted (stopped at guardrail)"],
    [403, '{"detail":"web access is not enabled for this workspace"}', "model", "shape accepted; workspace web access is OFF (dashboard)"],
    [404, '{"code":"mcp_server_not_found"}', "api", "not found"],
  ] as const)("%i %s (%s) → %s", (status, body, kind, expected) => {
    expect(verdict(status, body, kind)).toBe(expected);
  });

  it("escapes pipes in table cells", () => {
    expect(row(["a|b", null, 3])).toBe("| a\\|b | – | 3 |");
  });
});

describe("probe-shapes: recording fetch", () => {
  it("records method, path without the API prefix, model and status, and passes the response on", async () => {
    const log: Exchange[] = [];
    const base = (async () => new Response('{"code":"insufficient_funds"}', { status: 402 })) as typeof fetch;
    const f = recordingFetch(log, base);
    const res = await f("https://eu.api.otari.ai/api/v1/chat/completions?x=1", {
      method: "POST",
      body: JSON.stringify({ model: "porter-triage", messages: [] }),
    });
    expect(res.status).toBe(402);
    expect(await res.text()).toBe('{"code":"insufficient_funds"}');
    expect(log).toEqual([{ method: "POST", path: "/chat/completions?x=1", model: "porter-triage", status: 402, body: '{"code":"insufficient_funds"}' }]);
  });
});
