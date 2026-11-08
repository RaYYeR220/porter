import { describe, expect, it } from "vitest";
import { recordingFetch, redact, row, secretValues, verdict } from "../../scripts/probe-shapes-core";
import type { Exchange } from "../../scripts/probe-shapes-core";

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
