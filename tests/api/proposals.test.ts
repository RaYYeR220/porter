import { describe, expect, it } from "vitest";
import { handleProposalDecision, type ProposalDecisionDeps } from "../../lib/api/proposal-decision";
import { executionIdFor, type StoredProposal } from "../../lib/github/commands";
import { memoryLimiter, memoryProposalStore, req } from "./fakes";

const DEMO = "acme/widgets";
const mk = (id: number, repo: string, status = "pending"): StoredProposal => ({ id, runId: `run-${id}`, repo, action: "add_labels", args: { labels: ["bug"] }, status });

function setup(list: StoredProposal[], over: Partial<ProposalDecisionDeps> = {}, executeFails = false) {
  const { store, byId } = memoryProposalStore(list);
  const lim = memoryLimiter();
  const executed: Array<{ toolName: string; clientExecutionId: string }> = [];
  const deps: ProposalDecisionDeps = {
    store,
    otari: {
      mcp: {
        tools: async () => ({ tools: [], server_revision: "r1" }),
        execute: async (p: { toolName: string; clientExecutionId: string }) => {
          executed.push(p);
          if (executeFails) throw new Error("tool down");
          return { content: [] };
        },
      },
    } as unknown as ProposalDecisionDeps["otari"],
    mcpServerId: "srv",
    limit: lim.limit,
    salt: () => "salt",
    demoRepo: DEMO,
    ...over,
  };
  const post = (id: number | string, body: unknown, ip = "203.0.113.9") =>
    handleProposalDecision(req(`http://x/api/proposals/${id}`, { body, ip }), String(id), deps);
  return { post, executed, byId, lim };
}

describe("POST /api/proposals/:id", () => {
  it("approves a pending demo-repo proposal through the maintainer client", async () => {
    const t = setup([mk(1, DEMO)]);
    const res = await t.post(1, { decision: "approve" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "executed" });
    expect(t.executed).toEqual([expect.objectContaining({ toolName: "add_labels", clientExecutionId: executionIdFor(1) })]);
    expect(t.byId.get(1)?.decidedBy).toMatch(/^console:[0-9a-f]{8}$/);
    expect(t.byId.get(1)?.decidedBy).not.toContain("203.0.113.9");
  });

  it("rejects without executing anything", async () => {
    const t = setup([mk(1, DEMO)]);
    const res = await t.post(1, { decision: "reject" });
    expect((await res.json()).status).toBe("rejected");
    expect(t.executed).toHaveLength(0);
    expect(t.byId.get(1)?.status).toBe("rejected");
  });

  it("403 for a proposal on a shadow repo, and nothing runs", async () => {
    const t = setup([mk(2, "someone/else")]);
    const res = await t.post(2, { decision: "approve" });
    expect(res.status).toBe(403);
    expect(t.executed).toHaveLength(0);
    expect(t.byId.get(2)?.status).toBe("pending");
  });

  it("repo match is case-insensitive", async () => {
    const t = setup([mk(1, "ACME/Widgets")]);
    expect((await t.post(1, { decision: "approve" })).status).toBe(200);
  });

  it("409 when not pending, 404 when missing, 400 on junk", async () => {
    const t = setup([mk(1, DEMO, "executed")]);
    expect((await t.post(1, { decision: "approve" })).status).toBe(409);
    expect((await t.post(99, { decision: "approve" })).status).toBe(404);
    expect((await t.post(1, { decision: "maybe" })).status).toBe(400);
    expect((await t.post("abc", { decision: "approve" })).status).toBe(400);
  });

  it("502 with a plain error when the tool call fails", async () => {
    const t = setup([mk(1, DEMO)], {}, true);
    const res = await t.post(1, { decision: "approve" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("tool down");
    expect(t.byId.get(1)?.status).toBe("failed");
  });

  it("503 when the demo repo is not configured", async () => {
    const t = setup([mk(1, DEMO)], { demoRepo: null });
    expect((await t.post(1, { decision: "approve" })).status).toBe(503);
  });

  it("the 6th decision in an hour from one IP gets 429", async () => {
    const t = setup(Array.from({ length: 8 }, (_, i) => mk(i + 1, DEMO)));
    for (let i = 1; i <= 5; i++) expect((await t.post(i, { decision: "approve" })).status).toBe(200);
    const res = await t.post(6, { decision: "approve" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(t.byId.get(6)?.status).toBe("pending");
    expect((await t.post(7, { decision: "approve" }, "198.51.100.1")).status).toBe(200);
  });
});
