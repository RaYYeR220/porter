import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it } from "vitest";
import { handleProposalsList, proposalsListQuery, type ProposalListRow, type ProposalsReadStore } from "../../lib/api/proposals-list";
import { runsListQuery } from "../../lib/api/runs";
import * as schema from "../../lib/db/schema";

// Builds SQL only: nothing connects until a query is awaited.
const db = drizzle(neon("postgresql://user:pass@db.invalid/porter"), { schema });
const flat = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

describe("GET /api/runs list query", () => {
  const q = runsListQuery(db, { limit: 51, demoRepo: "Acme/Widgets" }).toSQL();
  const text = flat(q.sql);

  it("is one statement with a lateral aggregate over steps and a grouped pending count", () => {
    expect(text.match(/\bselect\b/g)?.length).toBe(3);
    expect(text).toContain("left join lateral (select");
    expect(text).toContain('from "steps" where "steps"."run_id" = "runs"."id"');
    // inside the lateral subquery bare names resolve to "steps", the only relation in its FROM
    expect(text).toContain(`(array_agg("served_model" order by "id") filter (where "role" = 'triage' and "served_model" is not null))[1]`);
    expect(text).toContain('left join (select "run_id", count(*)::int as "pending_n" from "proposals" where "proposals"."status" = $2 group by "proposals"."run_id")');
    expect(q.params).toContain("pending");
    expect(text).toContain("order by \"runs\".\"created_at\" desc, \"runs\".\"id\" desc limit $3");
  });

  it("counts pending proposals only on runs of the demo repository, compared case-insensitively", () => {
    expect(text).toContain('case when lower("runs"."repo") = lower($1) then coalesce("pending_n", 0) else 0 end');
    expect(q.params[0]).toBe("Acme/Widgets");
  });

  it("without a demo repository nothing can be approved, so no run counts any", () => {
    const none = flat(runsListQuery(db, { limit: 51, demoRepo: null }).toSQL().sql);
    expect(none).not.toContain('"proposals"');
    expect(none).toContain('0 as "pendingProposals"'.toLowerCase());
  });

  it("selects the list facts but never step bodies or issue text", () => {
    for (const col of [
      '"served_model"',
      'coalesce("pending_n", 0)',
      "case when \"runs\".\"status\" = 'held_guardrail' then case when \"gateway_hold\" then 'gateway' when \"output_hold\" then 'output' end end",
      "'guardrail_violation'",
      "'output_blocked'",
    ]) {
      expect(text).toContain(col);
    }
    for (const col of ['"tool_calls"', '"guardrails"', '"body"', '"reply"', '"triage"', '"args"', '"execution"']) {
      expect(text).not.toContain(col);
    }
  });

  it("keeps the filters and the keyset cursor", () => {
    const f = runsListQuery(db, { sources: ["github", "web"], status: "answered", limit: 3, before: { at: "2026-11-07 12:00:00.123456+00", id: "0b9f1c1e-6a3d-4c0e-9a55-3f0c2f6a1b11" } }).toSQL();
    const t = flat(f.sql);
    expect(t).toContain('"runs"."source" in ($');
    expect(t).toContain('"runs"."status" = $');
    expect(t).toContain('("runs"."created_at", "runs"."id") < ($');
    expect(f.params).toEqual(expect.arrayContaining(["github", "web", "answered", "2026-11-07 12:00:00.123456+00", 3]));
  });
});

describe("GET /api/proposals list query", () => {
  it("joins the run, scopes to one repository case-insensitively and leaves out who decided", () => {
    const q = proposalsListQuery(db, { repo: "Acme/Widgets", status: "pending", limit: 50 }).toSQL();
    const t = flat(q.sql);
    expect(t).toContain('inner join "runs" on "runs"."id" = "proposals"."run_id"');
    expect(t).toContain('lower("runs"."repo") = lower($1)');
    expect(t).toContain('"proposals"."status" = $2');
    expect(t).not.toContain('"decided_by"');
    expect(t).not.toContain('"body"');
    expect(q.params).toEqual(["Acme/Widgets", "pending", 50]);
  });
});

const row = (over: Partial<ProposalListRow> = {}): ProposalListRow => ({
  id: 7,
  runId: "0b9f1c1e-6a3d-4c0e-9a55-3f0c2f6a1b11",
  repo: "acme/widgets",
  issueNumber: 14,
  title: "Exported CSV is missing some rows",
  action: "add_labels",
  args: { repo: "acme/widgets", issue_number: 14, labels: ["bug"] },
  status: "pending",
  execution: null,
  createdAt: new Date(Date.UTC(2026, 10, 7, 12)),
  decidedAt: null,
  ...over,
});

function store(rows: ProposalListRow[]) {
  const s: ProposalsReadStore & { last?: unknown } = {
    async list(q) {
      s.last = q;
      return rows.filter((r) => r.repo.toLowerCase() === q.repo.toLowerCase() && r.status === q.status).slice(0, q.limit);
    },
  };
  return s;
}

const get = (url: string, s: ProposalsReadStore, demoRepo: string | null = "acme/widgets") =>
  handleProposalsList(new Request(url), { store: s, demoRepo });

describe("GET /api/proposals", () => {
  it("lists only the demo repository's pending proposals by default, capped at 50", async () => {
    const s = store([row(), row({ id: 8, repo: "mozilla-ai/otari" }), row({ id: 9, status: "executed" })]);
    const res = await get("http://x/api/proposals", s);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposals.map((p: { id: number }) => p.id)).toEqual([7]);
    expect(s.last).toEqual({ repo: "acme/widgets", status: "pending", limit: 20 });
    await get("http://x/api/proposals?status=pending&limit=999", s);
    expect(s.last).toMatchObject({ limit: 50 });
  });

  it("never takes the repository from the request", async () => {
    const s = store([row({ repo: "mozilla-ai/otari" })]);
    const body = await (await get("http://x/api/proposals?repo=mozilla-ai/otari", s)).json();
    expect(body.proposals).toEqual([]);
    expect(s.last).toMatchObject({ repo: "acme/widgets" });
  });

  it("redacts key-shaped values and drops credential-named fields, like the other read APIs", async () => {
    const s = store([
      row({
        args: { labels: ["bug"], note: "uses otk_LEAKED_123", Authorization: "Bearer abcdefghijkl" },
        execution: { content: [{ type: "text", text: "ok otk_SECRET" }], access_token: "t" },
      }),
    ]);
    const res = await get("http://x/api/proposals", s);
    const text = await res.text();
    expect(text).not.toContain("otk_");
    expect(text).not.toContain("abcdefghijkl");
    const p = JSON.parse(text).proposals[0];
    expect(p.args).toEqual({ labels: ["bug"], note: "uses [redacted]" });
    expect(p.execution).toEqual({ content: [{ type: "text", text: "ok [redacted]" }] });
    expect(p).not.toHaveProperty("decidedBy");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("503 while no demo repository is configured; 400 on a bad status or limit", async () => {
    const s = store([row()]);
    expect((await get("http://x/api/proposals", s, null)).status).toBe(503);
    expect((await get("http://x/api/proposals?status=all", s)).status).toBe(400);
    expect((await get("http://x/api/proposals?limit=0", s)).status).toBe(400);
    expect((await get("http://x/api/proposals?limit=abc", s)).status).toBe(400);
  });
});
