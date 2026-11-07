import { describe, expect, it } from "vitest";
import { createGuardHandler } from "../src/handler.ts";
import type { ChatFn, GuardLog } from "../src/protocol.ts";

const TOKEN = "test-token";
const fakeChat: ChatFn = async (body) => {
  if (body.model.includes("qwen3guard")) return { content: "Safety: Safe\nCategories: None" };
  if (body.model.includes("llama-guard")) return { content: "safe" };
  return { content: '{"violation":0,"confidence":0.9}' };
};
const post = (body: unknown, token: string | null = TOKEN) =>
  new Request("http://x/validate", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("guard handler", () => {
  it("rejects missing or wrong bearer with 401", async () => {
    const h = createGuardHandler({ token: TOKEN, chat: fakeChat });
    expect((await h.validate(post({ profile: "secrets", input_text: "x" }, null))).status).toBe(401);
    expect((await h.validate(post({ profile: "secrets", input_text: "x" }, "nope"))).status).toBe(401);
    expect((await h.profiles(new Request("http://x/profiles"))).status).toBe(401);
  });
  it("rejects unknown profile and bad bodies with 400", async () => {
    const h = createGuardHandler({ token: TOKEN, chat: fakeChat });
    expect((await h.validate(post({ profile: "nope", input_text: "x" }))).status).toBe(400);
    expect((await h.validate(post("{not json"))).status).toBe(400);
    expect((await h.validate(post({ profile: "secrets" }))).status).toBe(400);
  });
  it("returns the ValidateResponse shape and logs the verdict", async () => {
    const logs: GuardLog[] = [];
    const h = createGuardHandler({ token: TOKEN, chat: fakeChat, onVerdict: async (l) => void logs.push(l) });
    const res = await h.validate(post({ profile: "prompt-injection", input_text: "The CLI crashes on --verbose" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ profile: "prompt-injection", result: { valid: true } });
    expect(typeof json.result.score).toBe("number");
    expect(typeof json.result.explanation).toBe("string");
    expect(logs).toHaveLength(1);
    expect(logs[0].inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(logs[0].modelVerdicts).toHaveLength(2);
  });
  it("blocks secrets deterministically with no model calls", async () => {
    let calls = 0;
    const h = createGuardHandler({ token: TOKEN, chat: async () => (calls++, { content: "" }) });
    const res = await h.validate(post({ profile: "secrets", input_text: "ghp_" + "a".repeat(36) }));
    expect((await res.json()).result.valid).toBe(false);
    expect(calls).toBe(0);
  });
  it("blocks when a classifier flags a jailbreak", async () => {
    const chat: ChatFn = async (b) =>
      b.model.includes("qwen3guard") ? { content: "Safety: Unsafe\nCategories: Jailbreak" } : { content: '{"violation":0,"confidence":0.5}' };
    const h = createGuardHandler({ token: TOKEN, chat });
    const res = await h.validate(post({ profile: "prompt-injection", input_text: "hello" }));
    expect((await res.json()).result.valid).toBe(false);
  });
  it("answers within the deadline when the classifier never resolves (fail closed)", async () => {
    const h = createGuardHandler({ token: TOKEN, chat: () => new Promise(() => {}), deadlineMs: 200 });
    const t0 = Date.now();
    const res = await h.validate(post({ profile: "prompt-injection", input_text: "hello" }));
    expect(Date.now() - t0).toBeLessThan(700);
    const json = await res.json();
    expect(json.result.valid).toBe(false);
    expect(json.result.explanation).toBe("classifier_unavailable");
  });
  it("lists the three profiles", async () => {
    const h = createGuardHandler({ token: TOKEN, chat: fakeChat });
    const res = await h.profiles(new Request("http://x/profiles", { headers: { authorization: `Bearer ${TOKEN}` } }));
    const json = await res.json();
    expect(json.profiles.map((p: { name: string }) => p.name).sort()).toEqual(["harm", "prompt-injection", "secrets"]);
  });
});
