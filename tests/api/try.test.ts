import { describe, expect, it } from "vitest";
import { dailySalt, ipHash, webUserId } from "../../lib/api/common";
import { INSUFFICIENT_FUNDS_FLAG } from "../../lib/agent/pipeline";
import { parseFloor } from "../../lib/balance";
import { handleTry, type TryDeps } from "../../lib/try/handler";
import { DUPLICATE_OF, presetIssues } from "../../lib/try/presets";
import type { IssueInput } from "../../lib/agent/pipeline";
import type { KeyBudget } from "../../lib/otari/types";
import { memoryKv, memoryLimiter, req } from "./fakes";

const IP = "203.0.113.77";

function setup(over: Partial<TryDeps> & { budget?: KeyBudget | Error } = {}) {
  const { budget: budgetOver, ...depsOver } = over;
  const { kv, m } = memoryKv();
  const lim = memoryLimiter();
  const started: IssueInput[] = [];
  const ran: Array<{ input: IssueInput; runId: string }> = [];
  const deferred: Array<() => Promise<void>> = [];
  let budgetCalls = 0;
  const budget = budgetOver ?? { budgets_enforced: true, remaining_usd: 10, limits: [] };
  const deps: TryDeps = {
    demoRepo: "acme/widgets",
    salt: () => "salt-1",
    limit: lim.limit,
    funds: {
      kv,
      floorUsd: 3,
      keyBudget: async () => {
        budgetCalls++;
        if (budget instanceof Error) throw budget;
        return budget;
      },
    },
    startRun: async (input) => {
      started.push(input);
      return `run-${started.length}`;
    },
    runIssue: async (input, runId) => {
      ran.push({ input, runId });
    },
    defer: (w) => deferred.push(w),
    ...depsOver,
  };
  const post = (body: unknown, ip = IP) => handleTry(req("http://x/api/try", { body, ip }), deps);
  const flush = async () => {
    for (const w of deferred.splice(0)) await w();
  };
  return { deps, post, flush, started, ran, kv, m, lim, budgetCalls: () => budgetCalls };
}

describe("POST /api/try", () => {
  it("503 with a notice when DEMO_REPO is not configured", async () => {
    const t = setup({ demoRepo: null });
    const res = await t.post({ title: "hi" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("unavailable");
  });

  it("validates title, body and preset", async () => {
    const t = setup();
    expect((await t.post({ title: "   " })).status).toBe(400);
    expect((await t.post({ title: "a".repeat(201) })).status).toBe(400);
    expect((await t.post({ title: "ok", body: "x".repeat(20_001) })).status).toBe(400);
    expect((await t.post({ title: "ok", preset: "nope" })).status).toBe(400);
    expect((await t.post([1])).status).toBe(400);
    expect((await handleTry(req("http://x/api/try", { raw: "{not json", ip: IP }), t.deps)).status).toBe(400);
    expect(t.started).toHaveLength(0);
  });

  it("collapses whitespace in the title and returns the run id at once; work happens after", async () => {
    const t = setup();
    const res = await t.post({ title: "  Crash \n on   start  ", body: "details" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "run-1" });
    expect(t.started[0]).toMatchObject({ source: "web", arm: "porter", repo: "acme/widgets", number: null, title: "Crash on start", body: "details" });
    expect(t.ran).toHaveLength(0);
    await t.flush();
    expect(t.ran).toEqual([{ input: t.started[0], runId: "run-1" }]);
  });

  it("503 paused when the insufficient-funds flag is set", async () => {
    const t = setup();
    await t.kv.put(INSUFFICIENT_FUNDS_FLAG, { at: "now" }, new Date(Date.now() + 60_000));
    const res = await t.post({ title: "hi" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "paused", reason: "funds_low" });
    expect(t.started).toHaveLength(0);
  });

  it("an expired flag does not pause", async () => {
    const t = setup();
    await t.kv.put(INSUFFICIENT_FUNDS_FLAG, { at: "then" }, new Date(Date.now() - 1000));
    expect((await t.post({ title: "hi" })).status).toBe(202);
  });

  it("503 paused when the key budget is below the floor (tightest limit counts)", async () => {
    const t = setup({ budget: { budgets_enforced: true, remaining_usd: 50, limits: [{ remaining_usd: 2.5 }] } });
    expect((await t.post({ title: "hi" })).status).toBe(503);
    const t2 = setup({ budget: { budgets_enforced: true, remaining_usd: 2.99, limits: [] } });
    expect((await t2.post({ title: "hi" })).status).toBe(503);
  });

  it("caches the key budget for 60 s", async () => {
    const t = setup();
    await t.post({ title: "a" });
    await t.post({ title: "b" });
    await t.post({ title: "c" });
    expect(t.budgetCalls()).toBe(1);
  });

  it("does not pause when the budget cannot be read or is not enforced", async () => {
    expect((await setup({ budget: new Error("down") }).post({ title: "hi" })).status).toBe(202);
    expect((await setup({ budget: { budgets_enforced: false, remaining_usd: null, limits: [] } }).post({ title: "hi" })).status).toBe(202);
  });

  it("parseFloor defaults to 3", () => {
    expect(parseFloor(undefined)).toBe(3);
    expect(parseFloor("")).toBe(3);
    expect(parseFloor("abc")).toBe(3);
    expect(parseFloor("5")).toBe(5);
  });

  it("spam creates 12 runs for one end user and runs them in order", async () => {
    const t = setup();
    const res = await t.post({ preset: "spam" });
    const { runIds } = await res.json();
    expect(runIds).toHaveLength(12);
    expect(new Set(t.started.map((s) => s.authorExternalId)).size).toBe(1);
    expect(t.started[0].authorExternalId).toMatch(/^web:[0-9a-f]{16}$/);
    await t.flush();
    expect(t.ran.map((r) => r.runId)).toEqual(runIds);
  });

  it("a failing run does not stop the rest of the wave", async () => {
    let n = 0;
    const t = setup({
      runIssue: async () => {
        if (++n === 3) throw new Error("boom");
      },
    });
    await t.post({ preset: "spam" });
    await t.flush();
    expect(n).toBe(12);
  });

  it("429 on the 7th request in an hour from one IP; the spam preset counts as one", async () => {
    const t = setup();
    for (let i = 0; i < 6; i++) expect((await t.post({ preset: "spam" })).status).toBe(202);
    const res = await t.post({ title: "again" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect((await t.post({ title: "other ip" }, "198.51.100.9")).status).toBe(202);
  });

  it("derives the web id from ip + daily salt and never stores the raw IP", async () => {
    const t = setup();
    await t.post({ title: "hi", body: "b" });
    await t.post({ preset: "repro" });
    const dump = JSON.stringify([t.started, [...t.m.entries()], [...t.lim.counts.keys()]]);
    expect(dump).not.toContain(IP);
    expect(t.started[0].authorExternalId).toBe(webUserId(ipHash(IP, "salt-1")));
    expect(t.started[0].authorExternalId).toBe(t.started[1].authorExternalId);
  });

  it("503 when neither IP_SALT nor CRON_SECRET exists, and the salt rotates daily", async () => {
    const t = setup({ salt: () => dailySalt({}, new Date("2026-11-07T00:00:00Z")) });
    expect((await t.post({ title: "hi" })).status).toBe(503);
    const a = dailySalt({ CRON_SECRET: "c" }, new Date("2026-11-07T10:00:00Z"));
    const b = dailySalt({ CRON_SECRET: "c" }, new Date("2026-11-08T10:00:00Z"));
    expect(a).not.toBe(b);
    expect(dailySalt({ IP_SALT: "s", CRON_SECRET: "c" }, new Date("2026-11-07T00:00:00Z"))).toContain("s:");
    expect(ipHash(IP, a)).not.toBe(ipHash(IP, b));
  });

  it("falls back to x-real-ip", async () => {
    const t = setup();
    const r = new Request("http://x/api/try", { method: "POST", headers: { "x-real-ip": "192.0.2.5" }, body: JSON.stringify({ title: "hi" }) });
    expect((await handleTry(r, t.deps)).status).toBe(202);
    expect(t.started[0].authorExternalId).toBe(webUserId(ipHash("192.0.2.5", "salt-1")));
  });
});

describe("presets", () => {
  it("has a hidden-comment injection, a repro snippet, a duplicate and 12 spam issues", () => {
    expect(presetIssues("injection")[0].body).toContain("<!--");
    expect(presetIssues("repro")[0].body).toContain("```python");
    expect(presetIssues("duplicate")).toHaveLength(1);
    expect(presetIssues("spam")).toHaveLength(12);
    expect(DUPLICATE_OF).toHaveProperty("title");
  });
});
