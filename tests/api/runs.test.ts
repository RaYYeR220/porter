import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, handleRunGet, handleRunsList, type RunDetail, type RunListRow, type RunsReadStore } from "../../lib/api/runs";
import { memoryKv } from "./fakes";

const ID = "0b9f1c1e-6a3d-4c0e-9a55-3f0c2f6a1b11";
const row = (n: number): RunListRow => ({
  id: `0b9f1c1e-6a3d-4c0e-9a55-3f0c2f6a1b${String(n).padStart(2, "0")}`,
  source: "web",
  arm: "porter",
  repo: "acme/widgets",
  issueNumber: null,
  authorExternalId: "web:0123456789abcdef",
  title: `run ${n}`,
  status: "answered",
  totalCostUsd: 0.01,
  createdAt: new Date(Date.UTC(2026, 10, 7, 12, 0, 60 - n)),
  finishedAt: null,
});

function store(over: Partial<RunDetail> = {}, rows: RunListRow[] = []): RunsReadStore & { lastList?: unknown } {
  const s: RunsReadStore & { lastList?: unknown } = {
    async list(q) {
      s.lastList = q;
      return rows.slice(0, q.limit);
    },
    async get(id) {
      if (id !== ID) return null;
      return {
        run: { ...row(1), id: ID, body: "issue text with otk_LEAKED_123 inside", reply: "ok", triage: null },
        steps: [
          {
            id: 1,
            role: "triage",
            requestId: "req_1",
            guardrails: null,
            toolCalls: [{ name: "search", authorization: "Bearer abcdefghijkl", api_key: "otk_secret", nested: { access_token: "t", fine: "yes" }, output: "x" }],
          },
        ],
        guardVerdicts: [{ id: 1, runId: ID, profile: "prompt-injection", valid: true, explanation: "echo otk_ABCDEF in explanation" }],
        proposals: [{ id: 5, runId: ID, action: "add_labels", status: "pending" }],
        ...over,
      };
    },
  };
  return s;
}

describe("GET /api/runs/:id", () => {
  it("returns run, steps, verdicts, proposals and flags; no otk_ anywhere", async () => {
    const { kv } = memoryKv();
    await kv.put(`queued_reply:${ID}`, { x: 1 }, null);
    const res = await handleRunGet(ID, store(), kv);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("otk_");
    expect(text).not.toMatch(/Bearer\s+abcdefghijkl/);
    const body = JSON.parse(text);
    expect(body.run.id).toBe(ID);
    expect(body.steps[0].toolCalls[0]).toEqual({ name: "search", nested: { fine: "yes" }, output: "x" });
    expect(body.guardVerdicts).toHaveLength(1);
    expect(body.proposals[0].id).toBe(5);
    expect(body.queued).toBe(true);
    expect(body.reviewItem).toBe(false);
  });

  it("reviewItem is true when the review kv item exists", async () => {
    const { kv } = memoryKv();
    await kv.put(`review:${ID}`, { reason: "held" }, null);
    expect((await (await handleRunGet(ID, store(), kv)).json()).reviewItem).toBe(true);
  });

  it("404 for unknown or malformed ids", async () => {
    const { kv } = memoryKv();
    expect((await handleRunGet("0b9f1c1e-6a3d-4c0e-9a55-3f0c2f6a1b99", store(), kv)).status).toBe(404);
    expect((await handleRunGet("not-a-uuid", store(), kv)).status).toBe(404);
  });
});

describe("GET /api/runs", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(i + 1));

  it("passes filters, caps limit at 50 and pages with a cursor", async () => {
    const s = store({}, rows);
    const res = await handleRunsList(new Request("http://x/api/runs?source=web&status=answered&limit=2"), s);
    const body = await res.json();
    expect(body.runs).toHaveLength(2);
    expect(typeof body.nextCursor).toBe("string");
    expect(s.lastList).toMatchObject({ source: "web", status: "answered", limit: 3 });
    await handleRunsList(new Request("http://x/api/runs?limit=999"), s);
    expect(s.lastList).toMatchObject({ limit: 51 });
    await handleRunsList(new Request(`http://x/api/runs?cursor=${body.nextCursor}`), s);
    expect((s.lastList as { before: { id: string } }).before.id).toBe(body.runs[1].id);
  });

  it("no cursor when the page is the last", async () => {
    const body = await (await handleRunsList(new Request("http://x/api/runs?limit=10"), store({}, rows))).json();
    expect(body.nextCursor).toBeNull();
  });

  it("400 on bad filters and cursors", async () => {
    const s = store({}, rows);
    expect((await handleRunsList(new Request("http://x/api/runs?source=nope"), s)).status).toBe(400);
    expect((await handleRunsList(new Request("http://x/api/runs?limit=0"), s)).status).toBe(400);
    expect((await handleRunsList(new Request("http://x/api/runs?cursor=zzz"), s)).status).toBe(400);
  });

  it("cursor round-trips", () => {
    const at = new Date("2026-11-07T10:00:00.000Z");
    expect(decodeCursor(encodeCursor(at, ID))).toEqual({ at, id: ID });
  });
});
