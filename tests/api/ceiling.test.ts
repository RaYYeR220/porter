import { describe, expect, it } from "vitest";
import { CEILING_CACHE_KEY, CEILING_TTL_MS, handleCeiling } from "../../lib/api/ceiling";
import { workspaceCeiling } from "../../lib/balance";
import type { KvStore } from "../../lib/kv";
import type { KeyBudget } from "../../lib/otari/types";
import { memoryKv } from "./fakes";

/** GET /key/budget on the strangers key, as hosted Otari answers it today. */
const HOSTED: KeyBudget = {
  budgets_enforced: true,
  remaining_usd: 0.67,
  limits: [
    {
      scope: "workspace",
      provider: null,
      resets_at: "2026-11-10T00:00:00Z",
      limit_usd: null,
      used_usd: 0.33,
      remaining_usd: null,
      limit_requests: null,
    },
  ],
};

describe("workspaceCeiling", () => {
  it("reads the hosted shape: what is left today, and when the workspace limit resets", () => {
    expect(workspaceCeiling(HOSTED)).toEqual({
      remainingUsd: 0.67,
      limitUsd: null,
      usedUsd: 0.33,
      resetsAt: "2026-11-10T00:00:00.000Z",
      scope: "workspace",
      enforced: true,
    });
  });

  it("the tightest limit decides, as it does for the /try floor", () => {
    const b: KeyBudget = {
      budgets_enforced: true,
      remaining_usd: 5,
      limits: [
        { scope: "workspace", resets_at: "2026-11-10T00:00:00Z", limit_usd: 3, used_usd: 1, remaining_usd: 2 },
        { scope: "key", resets_at: "2026-11-09T18:00:00Z", limit_usd: 1, used_usd: 0.5, remaining_usd: 0.5 },
      ],
    };
    expect(workspaceCeiling(b)).toEqual({
      remainingUsd: 0.5,
      limitUsd: 1,
      usedUsd: 0.5,
      resetsAt: "2026-11-09T18:00:00.000Z",
      scope: "key",
      enforced: true,
    });
  });

  it("with no limits there is no reset to show and nothing is guessed", () => {
    expect(workspaceCeiling({ budgets_enforced: false, remaining_usd: null, limits: [] })).toEqual({
      remainingUsd: null,
      limitUsd: null,
      usedUsd: null,
      resetsAt: null,
      scope: null,
      enforced: false,
    });
  });

  it("ignores junk in the limits instead of throwing", () => {
    const b = {
      budgets_enforced: "yes",
      remaining_usd: "0.5",
      limits: [null, "x", { scope: 7, resets_at: "not a date", limit_usd: "1", used_usd: Number.NaN, remaining_usd: Infinity }],
    } as unknown as KeyBudget;
    expect(workspaceCeiling(b)).toEqual({ remainingUsd: null, limitUsd: null, usedUsd: null, resetsAt: null, scope: null, enforced: false });
    expect(workspaceCeiling({ budgets_enforced: true, remaining_usd: 1 } as unknown as KeyBudget).remainingUsd).toBe(1);
  });
});

describe("GET /api/ceiling", () => {
  function deps(budget: () => Promise<KeyBudget>, kvOver?: Partial<KvStore>) {
    let t = Date.UTC(2026, 10, 9, 12);
    const { kv } = memoryKv(() => t);
    let calls = 0;
    return {
      d: {
        kv: { ...kv, ...kvOver },
        keyBudget: () => {
          calls++;
          return budget();
        },
        now: () => t,
      },
      calls: () => calls,
      advance: (ms: number) => {
        t += ms;
      },
      kv,
    };
  }

  it("answers the ceiling only: no key, no other field of the gateway's answer", async () => {
    const t = deps(async () => ({ ...HOSTED, key_id: "otk_live_123", api_key: "otk_secret", owner: "desk-strangers" }));
    const res = await handleCeiling(t.d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("otk_");
    expect(text).not.toContain("desk-strangers");
    expect(JSON.parse(text)).toEqual({ ceiling: workspaceCeiling(HOSTED) });
  });

  it("asks the gateway at most once a minute", async () => {
    const t = deps(async () => HOSTED);
    await handleCeiling(t.d);
    await handleCeiling(t.d);
    t.advance(CEILING_TTL_MS - 1000);
    await handleCeiling(t.d);
    expect(t.calls()).toBe(1);
    expect(await t.kv.get(CEILING_CACHE_KEY)).toEqual({ ceiling: workspaceCeiling(HOSTED) });
    t.advance(2000);
    await handleCeiling(t.d);
    expect(t.calls()).toBe(2);
  });

  it("fails soft when the gateway does not answer, and does not retry on every page load", async () => {
    const t = deps(async () => {
      throw new Error("502 from gateway");
    });
    const res = await handleCeiling(t.d);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "unavailable" });
    expect((await handleCeiling(t.d)).status).toBe(503);
    expect(t.calls()).toBe(1);
  });

  it("still answers when the cache cannot be read or written", async () => {
    const t = deps(async () => HOSTED, {
      get: async () => {
        throw new Error("db down");
      },
      put: async () => {
        throw new Error("db down");
      },
    });
    const res = await handleCeiling(t.d);
    expect(res.status).toBe(200);
    expect((await res.json()).ceiling.remainingUsd).toBe(0.67);
  });
});
