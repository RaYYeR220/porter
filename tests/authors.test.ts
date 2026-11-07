import { describe, expect, it } from "vitest";
import { handleAuthorAction, type AuthorActionDeps } from "../lib/api/author-actions";
import { applyAuthorAction, displayName, getAuthors, isActionableId, type AuthorsDeps } from "../lib/authors";
import type { EndUser } from "../lib/otari/types";
import { memoryAuthorsStore, memoryKv, memoryLimiter, req } from "./api/fakes";

const users: EndUser[] = [
  { external_id: "gh:octocat", budget_id: "bud-new", blocked: false, spend: 0.2, current_requests: 4, next_budget_reset_at: "2026-11-07T15:00:00Z" },
  { external_id: "web:ab12cd34ef567890", budget_id: "bud-reg", blocked: true, spend: 1.5 },
  { external_id: "eval:case1", budget_id: "bud-new", blocked: false, spend: 9 },
];

function setup() {
  let now = Date.parse("2026-11-07T12:00:00Z");
  const clock = () => now;
  const { kv, m } = memoryKv(clock);
  const a = memoryAuthorsStore();
  const calls = { list: 0, budgets: 0, put: [] as unknown[][], patch: [] as unknown[][] };
  const deps: AuthorsDeps = {
    kv,
    store: a.store,
    regularBudgetId: "bud-reg",
    newcomerBudgetId: "bud-new",
    now: () => new Date(now),
    otari: {
      endUsers: {
        get: async (id: string) => users.find((u) => u.external_id === id) ?? null,
        list: async () => {
          calls.list++;
          return users;
        },
        put: async (...args: unknown[]) => {
          calls.put.push(args);
          return users[0];
        },
        patch: async (...args: unknown[]) => {
          calls.patch.push(args);
          return users[0];
        },
      },
      endUserBudgets: async () => {
        calls.budgets++;
        return [
          { budget_id: "bud-new", name: "Newcomer", max_budget: 0.5 },
          { budget_id: "bud-reg", name: "Regular", max_budget: 3 },
        ];
      },
    } as unknown as AuthorsDeps["otari"],
  };
  return { deps, calls, kv, m, a, advance: (ms: number) => (now += ms) };
}

describe("authors", () => {
  it("builds live meters with tier, limit, remaining and display names", async () => {
    const t = setup();
    const list = await getAuthors(t.deps);
    expect(list.map((x) => x.id).sort()).toEqual(["gh:octocat", "web:ab12cd34ef567890"]);
    const gh = list.find((x) => x.id === "gh:octocat")!;
    expect(gh).toMatchObject({ display: "octocat", tier: "newcomer", budgetName: "Newcomer", budgetLimitUsd: 0.5, spendUsd: 0.2, remainingUsd: 0.3, requests: 4, blocked: false });
    expect(gh.nextResetAt).toBe("2026-11-07T15:00:00.000Z");
    const web = list.find((x) => x.id.startsWith("web:"))!;
    expect(web).toMatchObject({ display: "visitor ab12…", tier: "regular", blocked: true });
  });

  it("two GETs within 30 s make one Otari list call; a later one refreshes", async () => {
    const t = setup();
    await getAuthors(t.deps);
    await getAuthors(t.deps);
    expect(t.calls.list).toBe(1);
    expect(t.calls.budgets).toBe(1);
    t.advance(31_000);
    await getAuthors(t.deps);
    expect(t.calls.list).toBe(2);
    expect(t.calls.budgets).toBe(1);
    t.advance(5 * 60_000);
    await getAuthors(t.deps);
    expect(t.calls.budgets).toBe(2);
  });

  it("serves cached rows when Otari fails, and does not retry within the window", async () => {
    const t = setup();
    await getAuthors(t.deps);
    t.advance(31_000);
    let n = 0;
    (t.deps.otari.endUsers as { list: () => Promise<EndUser[]> }).list = async () => {
      n++;
      throw new Error("down");
    };
    expect(await getAuthors(t.deps)).toHaveLength(2);
    await getAuthors(t.deps);
    expect(n).toBe(1);
  });

  it("display names and actionable ids", () => {
    expect(displayName("gh:octocat")).toBe("octocat");
    expect(displayName("web:ab12cd34ef567890")).toBe("visitor ab12…");
    expect(isActionableId("gh:octocat")).toBe(true);
    expect(isActionableId("web:ab12cd34ef567890")).toBe(true);
    expect(isActionableId("eval:case1")).toBe(false);
    expect(isActionableId("shadow:x")).toBe(false);
    expect(isActionableId("web:short")).toBe(false);
    expect(isActionableId("gh:a/b")).toBe(false);
  });

  it("refuses unknown authors without calling PUT or PATCH", async () => {
    const t = setup();
    expect(await applyAuthorAction("gh:nobody", "upgrade", t.deps)).toBe("unknown_author");
    expect(await applyAuthorAction("eval:case1", "block", t.deps)).toBe("unknown_author");
    expect(t.calls.put).toHaveLength(0);
    expect(t.calls.patch).toHaveLength(0);
    expect(t.a.rows.size).toBe(0);
  });

  it("accepts an author known only to Otari and upserts the mirror row", async () => {
    const t = setup();
    expect(await applyAuthorAction("gh:octocat", "upgrade", t.deps)).toBe("ok");
    expect(t.a.rows.get("gh:octocat")).toMatchObject({ budgetId: "bud-reg", spendUsd: 0.2 });
    await applyAuthorAction("gh:octocat", "block", t.deps);
    expect(t.a.rows.get("gh:octocat")).toMatchObject({ blocked: true, budgetId: "bud-reg" });
  });

  it("upgrade/downgrade PUT budgets; block/unblock PATCH", async () => {
    const t = setup();
    await getAuthors(t.deps);
    await applyAuthorAction("gh:octocat", "upgrade", t.deps);
    await applyAuthorAction("gh:octocat", "downgrade", t.deps);
    await applyAuthorAction("gh:octocat", "block", t.deps);
    await applyAuthorAction("gh:octocat", "unblock", t.deps);
    expect(t.calls.put).toEqual([["gh:octocat", "bud-reg"], ["gh:octocat", "bud-new"]]);
    expect(t.calls.patch).toEqual([["gh:octocat", { blocked: true }], ["gh:octocat", { blocked: false }]]);
  });
});

describe("POST /api/authors/:id", () => {
  function act() {
    const t = setup();
    const lim = memoryLimiter();
    const deps: AuthorActionDeps = { limit: lim.limit, salt: () => "salt", authors: t.deps, kv: t.kv, now: () => 1_700_000_000_000 };
    const post = (id: string, body: unknown, ip = "203.0.113.5") => handleAuthorAction(req(`http://x/api/authors/${id}`, { body, ip }), id, deps);
    return { t, post };
  }

  it("applies an action, accepts an encoded id, and writes an audit record without the IP", async () => {
    const { t, post } = act();
    const res = await post("gh%3AOctoCat", { action: "block" });
    expect(res.status).toBe(200);
    expect(t.calls.patch).toEqual([["gh:octocat", { blocked: true }]]);
    const audit = [...t.m.entries()].filter(([k]) => k.startsWith("author_action:1700000000000"));
    expect(audit).toHaveLength(1);
    expect(audit[0][1].value).toMatchObject({ action: "block", target: "gh:octocat" });
    expect(JSON.stringify(audit)).not.toContain("203.0.113.5");
  });

  it("404 unknown_author for a well-formed id that does not exist", async () => {
    const { t, post } = act();
    const res = await post("gh%3Anobody", { action: "upgrade" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_author");
    expect(t.calls.put).toHaveLength(0);
    expect([...t.m.keys()].some((k) => k.startsWith("author_action:"))).toBe(false);
  });

  it("400 for ids outside gh:/web: and for bad actions", async () => {
    const { post } = act();
    expect((await post("eval%3Acase1", { action: "block" })).status).toBe(400);
    expect((await post("gh%3Aoctocat", { action: "delete" })).status).toBe(400);
  });

  it("429 on the 6th action in an hour from one IP", async () => {
    const { post } = act();
    for (let i = 0; i < 5; i++) expect((await post("gh%3Aoctocat", { action: "block" })).status).toBe(200);
    expect((await post("gh%3Aoctocat", { action: "block" })).status).toBe(429);
  });
});
