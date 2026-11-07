import { describe, expect, it } from "vitest";
import { collectSnapshot } from "../../lib/snapshot/github-source";

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const node = (n: number, state: string, upd: number, closed: number | null) => ({
  number: n,
  title: `t${n}`,
  body: "b",
  state,
  createdAt: iso(300),
  updatedAt: iso(upd),
  closedAt: closed === null ? null : iso(closed),
  author: { login: "u" },
  labels: { nodes: [{ name: "bug" }] },
});

describe("collectSnapshot", () => {
  it("fetches open, closed and releases in one call and drops closed issues older than 180 days", async () => {
    let calls = 0;
    const graphql = async () => {
      calls++;
      return {
        repository: {
          open: { nodes: [node(1, "OPEN", 1, null)], pageInfo: { hasNextPage: false, endCursor: null } },
          closed: { nodes: [node(2, "CLOSED", 10, 10), node(3, "CLOSED", 400, 400)], pageInfo: { hasNextPage: true, endCursor: "x" } },
          releases: { nodes: [{ tagName: "v1", name: "One", description: "d", publishedAt: iso(5) }] },
        },
      };
    };
    const out = await collectSnapshot(graphql, "a", "b");
    expect(calls).toBe(1);
    expect(out.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(out.issues[0]).toMatchObject({ state: "open", author: "u", labels: ["bug"] });
    expect(out.releases[0].tag).toBe("v1");
  });

  it("never exceeds the call cap while paginating", async () => {
    let calls = 0;
    const graphql = async () => {
      calls++;
      return {
        repository: {
          open: { nodes: [node(calls, "OPEN", 1, null)], pageInfo: { hasNextPage: true, endCursor: "c" } },
          closed: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          releases: { nodes: [] },
        },
      };
    };
    await collectSnapshot(graphql, "a", "b", { maxCalls: 3 });
    expect(calls).toBe(3);
  });
});
