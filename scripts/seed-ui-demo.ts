/**
 * Seeds a handful of runs, steps, proposals and authors for screenshots of /try and /console, all
 * under the fake repository demo/porter-ui-seed. Never run it against a database a judge is reading
 * for long: take the shots, then run `pnpm seed:ui:clean`.
 *
 * Both refuse to run unless the target database host is named on the command line:
 *
 *   pnpm seed:ui --yes-write-to <db-host>        # cleans any earlier seed, inserts a fresh one, prints the ids to open
 *   pnpm seed:ui:clean --yes-write-to <db-host>  # deletes everything the seed inserted (scripts/clean-ui-demo.ts)
 */
import { randomUUID } from "node:crypto";
import { fixedReply } from "../lib/agent/replies";
import { db } from "../lib/db/client";
import { authors, kv, proposals, runs, steps } from "../lib/db/schema";
import { armClient } from "../lib/agent/pipeline";
import { presetIssues } from "../lib/try/presets";
import { cleanUiDemo, countUiDemo, requireWriteConsent, SEED_AUTHORS, SEED_REPO } from "./ui-demo-core";

type StepRow = typeof steps.$inferInsert;
type RunRow = typeof runs.$inferInsert;
type ProposalRow = typeof proposals.$inferInsert;

const now = Date.now();
const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
const midnight = () => {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d;
};
const reqId = () => randomUUID();

const GUARDS_PASS = (scores: [number, number, number]) => [
  { profile: "prompt-injection", mode: "block", valid: true, score: scores[0], status: "evaluated", reason: null },
  { profile: "secrets", mode: "block", valid: true, score: scores[1], status: "evaluated", reason: null },
  { profile: "harm", mode: "block", valid: true, score: scores[2], status: "evaluated", reason: null },
];
const OUTPUT_PASS = [{ profile: "output_check", mode: "block", valid: true, score: null, status: "evaluated", reason: null }];

type Built = { run: RunRow; steps: StepRow[]; proposals: ProposalRow[]; review?: boolean };

function build(r: Omit<RunRow, "id" | "repo" | "arm"> & { id?: string }, list: Array<Omit<StepRow, "runId">>, extra: Partial<Built> = {}): Built {
  const id = r.id ?? randomUUID();
  const created = r.createdAt as Date;
  return {
    run: { arm: "porter", repo: SEED_REPO, ...r, id, totalCostUsd: list.reduce((n, s) => n + (s.costUsd ?? 0), 0) },
    steps: list.map((s, i) => ({ ...s, runId: id, createdAt: new Date(created.getTime() + (i + 1) * 1500) })),
    proposals: (extra.proposals ?? []).map((p) => ({ ...p, runId: id })),
    review: extra.review,
  };
}

const ANSWER =
  "Thanks for checking in. There is no update to share yet: nothing about this has changed since the last release.\n\n" +
  "Subscribe to the issue to be told when a maintainer posts progress.";

/** One author's twelve issues. Costs are fractions of the newcomer cap so the meter tells the story it would. */
function wave(limit: number): Built[] {
  const issues = presetIssues("spam");
  const full = limit * 0.118;
  const small = limit * 0.06;
  return issues.map((issue, i) => {
    const created = at(420 - i * 24);
    const base = { source: "web" as const, issueNumber: null, authorExternalId: SEED_AUTHORS.wave, title: issue.title, body: issue.body, createdAt: created };
    if (i >= 10) {
      return build(
        {
          ...base,
          status: "refused_budget",
          reply: fixedReply("refused_budget", { retryAfterSec: Math.round((midnight().getTime() - created.getTime()) / 1000), scope: "user", step: "triage" }),
          finishedAt: new Date(created.getTime() + 900),
        },
        [{ role: "triage", requestedModel: "porter-triage", durationMs: 140 + i * 3, errorKind: "budget_exceeded", errorStatus: 403 }],
      );
    }
    const tier = i >= 7;
    const cost = tier ? small : full;
    return build({ ...base, status: "answered", reply: ANSWER, finishedAt: new Date(created.getTime() + 9000) }, [
      {
        role: "triage",
        requestedModel: "porter-triage",
        servedModel: tier ? "deepseek/deepseek-v4-flash-0731" : "deepseek/deepseek-v4.1-flash-1017",
        provider: tier ? "deepinfra" : "nebius",
        attemptCount: 1,
        requestId: reqId(),
        costUsd: cost * 0.42,
        durationMs: tier ? 1880 + i * 40 : 3120 + i * 55,
        guardrails: GUARDS_PASS([0.02, 0, 0.01]),
        toolCalls: [{ type: "mcp", server: "porter-repo", name: "search_issues", status: "ok", output: '{"items":[]}' }],
      },
      { role: "review", requestedModel: "porter-review", servedModel: "zai/glm-5.3-flash", provider: "together", attemptCount: 1, requestId: reqId(), costUsd: cost * 0.58, durationMs: 1650 + i * 30, toolCalls: [{ type: "struck_claims", claims: [] }] },
      { role: "output_check", guardrails: OUTPUT_PASS },
    ]);
  });
}

function injection(): Built {
  const issue = presetIssues("injection")[0];
  const created = at(1500);
  return build(
    {
      source: "web",
      issueNumber: null,
      authorExternalId: SEED_AUTHORS.visitor,
      title: issue.title,
      body: issue.body,
      status: "held_guardrail",
      reply: fixedReply("held_guardrail", { profile: "prompt-injection" }),
      createdAt: created,
      finishedAt: new Date(created.getTime() + 2400),
    },
    [
      {
        role: "triage",
        requestedModel: "porter-triage",
        durationMs: 1910,
        errorKind: "guardrail_violation",
        errorStatus: 400,
        guardrails: [{ profile: "prompt-injection", explanation: "hidden_html_comment", score: 0.98 }],
      },
    ],
    { review: true },
  );
}

const REPRO_STDOUT = [
  "2026-10-24T22:30:00+00:00 -> 2026-10-25 00:30 CEST",
  "2026-10-24T23:30:00+00:00 -> 2026-10-25 01:30 CEST",
  "2026-10-25T00:30:00+00:00 -> 2026-10-25 02:30 CEST",
  "2026-10-25T01:30:00+00:00 -> 2026-10-25 02:30 CET",
  "2026-10-25T02:30:00+00:00 -> 2026-10-25 03:30 CET",
  "2026-10-25T03:30:00+00:00 -> 2026-10-25 04:30 CET",
  "2026-10-25T04:30:00+00:00 -> 2026-10-25 05:30 CET",
  "2026-10-25T05:30:00+00:00 -> 2026-10-25 06:30 CET",
  "",
].join("\n");

function repro(): Built {
  const issue = presetIssues("repro")[0];
  const code = issue.body.split("```python\n")[1]?.split("\n```")[0] ?? "";
  const created = at(3300);
  const reply = [
    "Thanks for the snippet. Porter ran it in a sandbox and the output matches what you describe: the local times 02:30 CEST and 02:30 CET",
    "are different instants an hour apart, but both fall on 2026-10-25, so `local.date()` alone puts 25 hours of events on the 25th.",
    "",
    "```text",
    "2026-10-25T00:30:00+00:00 -> 2026-10-25 02:30 CEST",
    "2026-10-25T01:30:00+00:00 -> 2026-10-25 02:30 CET",
    "```",
    "",
    "Grouping by `local.date()` is correct for a calendar day; the 25 hours are real on that date. If the totals should be per 24 hours,",
    "bucket on UTC instead. A maintainer will confirm which the usage page intends.",
  ].join("\n");
  return build(
    {
      source: "web",
      issueNumber: null,
      authorExternalId: SEED_AUTHORS.visitor,
      title: issue.title,
      body: issue.body,
      status: "answered",
      reply,
      createdAt: created,
      finishedAt: new Date(created.getTime() + 21_400),
    },
    [
      {
        role: "triage",
        requestedModel: "porter-triage",
        servedModel: "deepseek/deepseek-v4.1-flash-1017",
        provider: "nebius",
        attemptCount: 1,
        requestId: reqId(),
        costUsd: 0.00061,
        durationMs: 4380,
        guardrails: GUARDS_PASS([0.04, 0, 0.01]),
        toolCalls: [
          { type: "mcp", server: "porter-repo", name: "search_issues", status: "ok", output: '{"items":[{"number":6,"title":"Usage page shows yesterday after midnight","state":"closed"}]}' },
          { type: "mcp", server: "porter-repo", name: "read_file", status: "ok", output: "def bucket(events, tz):\n    return groupby(events, key=lambda e: e.at.astimezone(tz).date())\n" },
        ],
      },
      {
        role: "repro",
        requestedModel: "porter-repro",
        servedModel: "alibaba/qwen3-coder-480b-a35b-instruct-turbo",
        provider: "together",
        fallback: true,
        attemptCount: 2,
        requestId: reqId(),
        costUsd: 0.0124,
        durationMs: 8920,
        toolCalls: [{ type: "code_execution", code, stdout: REPRO_STDOUT, stderr: "", exit_code: 0, file_ids: [], truncated: false }],
      },
      {
        role: "review",
        requestedModel: "porter-review",
        servedModel: "zai/glm-5.3-flash",
        provider: "together",
        attemptCount: 1,
        requestId: reqId(),
        costUsd: 0.00083,
        durationMs: 2710,
        toolCalls: [{ type: "struck_claims", claims: ["This was fixed in the latest release."] }],
      },
      { role: "output_check", guardrails: OUTPUT_PASS },
    ],
  );
}

function duplicate(): Built {
  const created = at(5400);
  return build(
    {
      source: "github",
      issueNumber: 14,
      authorExternalId: SEED_AUTHORS.reporter,
      title: "Exported CSV is missing some rows",
      body: presetIssues("duplicate")[0].body,
      status: "answered",
      reply:
        "Thanks for the report. This looks like the same problem as #9, “CSV export drops rows when a field contains a line break”: rows whose notes field has a line break are cut from the file.\n\n" +
        "Follow #9 for the fix. A maintainer can close this one as a duplicate.",
      createdAt: created,
      finishedAt: new Date(created.getTime() + 11_800),
    },
    [
      {
        role: "triage",
        requestedModel: "porter-triage",
        servedModel: "deepseek/deepseek-v4.1-flash-1017",
        provider: "nebius",
        attemptCount: 1,
        requestId: reqId(),
        costUsd: 0.00048,
        durationMs: 3640,
        guardrails: GUARDS_PASS([0.01, 0, 0]),
        toolCalls: [
          {
            type: "mcp",
            server: "porter-repo",
            name: "search_issues",
            status: "ok",
            output: '{"items":[{"number":9,"title":"CSV export drops rows when a field contains a line break","state":"open"}]}',
          },
          { type: "mcp", server: "porter-repo", name: "get_issue", status: "ok", output: '{"number":9,"state":"open","labels":["bug","export"]}' },
        ],
      },
      { role: "review", requestedModel: "porter-review", servedModel: "zai/glm-5.3-flash", provider: "together", attemptCount: 1, requestId: reqId(), costUsd: 0.00071, durationMs: 2210, toolCalls: [{ type: "struck_claims", claims: [] }] },
      { role: "output_check", guardrails: OUTPUT_PASS },
    ],
    {
      proposals: [
        { action: "add_labels", args: { repo: SEED_REPO, issue_number: 14, labels: ["bug", "export"] }, status: "pending", createdAt: new Date(created.getTime() + 11_800) } as ProposalRow,
        { action: "close_as_duplicate", args: { repo: SEED_REPO, issue_number: 14, duplicate_of: 9 }, status: "pending", createdAt: new Date(created.getTime() + 11_800) } as ProposalRow,
      ],
    },
  );
}

function outputHold(): Built {
  const created = at(7300);
  return build(
    {
      source: "github",
      issueNumber: 15,
      authorExternalId: SEED_AUTHORS.reporter,
      title: "Where is the export API documented?",
      body: "I want to export reports from a script. Is there an API for it, and where are the docs?",
      status: "held_guardrail",
      reply: fixedReply("held_guardrail", { profile: "output" }),
      createdAt: created,
      finishedAt: new Date(created.getTime() + 10_100),
    },
    [
      {
        role: "triage",
        requestedModel: "porter-triage",
        servedModel: "deepseek/deepseek-v4.1-flash-1017",
        provider: "nebius",
        attemptCount: 1,
        requestId: reqId(),
        costUsd: 0.00039,
        durationMs: 3010,
        guardrails: GUARDS_PASS([0.02, 0, 0]),
        toolCalls: [{ type: "mcp", server: "porter-repo", name: "read_file", status: "ok", output: "# Export\n\nSee docs/export.md." }],
      },
      { role: "review", requestedModel: "porter-review", servedModel: "zai/glm-5.3-flash", provider: "together", attemptCount: 1, requestId: reqId(), costUsd: 0.00066, durationMs: 2350, toolCalls: [{ type: "struck_claims", claims: [] }] },
      {
        role: "output_check",
        errorKind: "output_blocked",
        guardrails: [{ profile: "output_check", mode: "block", valid: false, score: null, status: "evaluated", reason: "link_not_allowed" }],
      },
    ],
    { review: true },
  );
}

function executed(): Built {
  const created = at(9800);
  return build(
    {
      source: "github",
      issueNumber: 11,
      authorExternalId: SEED_AUTHORS.reporter,
      title: "Typo in the install section of the README",
      body: "The README says `pip install porter-demo` but the package is called `porter_demo`.",
      status: "answered",
      reply: "Thanks for catching this. The package name in the install section should be `porter_demo`; a maintainer will fix the README.",
      createdAt: created,
      finishedAt: new Date(created.getTime() + 8400),
    },
    [
      {
        role: "triage",
        requestedModel: "porter-triage",
        servedModel: "deepseek/deepseek-v4.1-flash-1017",
        provider: "nebius",
        attemptCount: 1,
        requestId: reqId(),
        costUsd: 0.00031,
        durationMs: 2480,
        guardrails: GUARDS_PASS([0.01, 0, 0]),
        toolCalls: [{ type: "mcp", server: "porter-repo", name: "read_file", status: "ok", output: "## Install\n\npip install porter-demo\n" }],
      },
      { role: "review", requestedModel: "porter-review", servedModel: "zai/glm-5.3-flash", provider: "together", attemptCount: 1, requestId: reqId(), costUsd: 0.00052, durationMs: 1980, toolCalls: [{ type: "struck_claims", claims: [] }] },
      { role: "output_check", guardrails: OUTPUT_PASS },
    ],
    {
      proposals: [
        {
          action: "add_labels",
          args: { repo: SEED_REPO, issue_number: 11, labels: ["docs"] },
          status: "executed",
          decidedBy: "console:5eed0001",
          execution: { content: [{ type: "text", text: "Labels on #11: docs" }], isError: false },
          createdAt: new Date(created.getTime() + 8400),
          decidedAt: new Date(created.getTime() + 600_000),
        } as ProposalRow,
      ],
    },
  );
}

function failed(): Built {
  const created = at(8600);
  return build(
    {
      source: "web",
      issueNumber: null,
      authorExternalId: SEED_AUTHORS.visitor,
      title: "Dark mode toggle resets after reload",
      body: "Every reload switches the app back to light mode.",
      status: "failed",
      reply: null,
      createdAt: created,
      finishedAt: new Date(created.getTime() + 31_000),
    },
    [
      { role: "triage", requestedModel: "porter-triage", durationMs: 14_200, errorKind: "upstream", errorStatus: 503 },
      { role: "triage", requestedModel: "porter-triage", durationMs: 15_100, errorKind: "upstream", errorStatus: 502 },
    ],
  );
}

function blocked(): Built {
  const created = at(6200);
  return build(
    {
      source: "github",
      issueNumber: 16,
      authorExternalId: SEED_AUTHORS.blocked,
      title: "URGENT fix now",
      body: "fix it",
      status: "blocked_author",
      reply: null,
      createdAt: created,
      finishedAt: new Date(created.getTime() + 700),
    },
    [{ role: "triage", requestedModel: "porter-triage", durationMs: 120, errorKind: "end_user_blocked", errorStatus: 403 }],
  );
}

async function budgetLimits(): Promise<{ newcomer: string | null; regular: string | null; newcomerLimit: number | null; regularLimit: number | null }> {
  const newcomer = process.env.OTARI_BUDGET_NEWCOMER_ID?.trim() || null;
  const regular = process.env.OTARI_BUDGET_REGULAR_ID?.trim() || null;
  try {
    const list = await armClient("porter").otari.endUserBudgets();
    const limit = (id: string | null) => {
      const v = list.find((b) => b.budget_id === id)?.max_budget;
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    };
    return { newcomer, regular, newcomerLimit: limit(newcomer), regularLimit: limit(regular) };
  } catch (e) {
    console.warn(`could not read end-user budgets (${e instanceof Error ? e.name : "error"}); the meters will show no cap`);
    return { newcomer, regular, newcomerLimit: null, regularLimit: null };
  }
}

async function main() {
  requireWriteConsent("seed-ui-demo");
  const earlier = await cleanUiDemo(db());
  if (earlier.runs || earlier.authors) console.log(`removed an earlier seed: ${earlier.runs} runs, ${earlier.authors} authors`);

  const b = await budgetLimits();
  const L = b.newcomerLimit ?? 0.02;

  const waveRuns = wave(L);
  const all: Built[] = [...waveRuns, injection(), repro(), duplicate(), outputHold(), executed(), failed(), blocked()];
  const d = db();
  await d.insert(runs).values(all.map((x) => x.run));
  await d.insert(steps).values(all.flatMap((x) => x.steps));
  const props = all.flatMap((x) => x.proposals);
  if (props.length) await d.insert(proposals).values(props);
  const reviews = all.filter((x) => x.review);
  if (reviews.length) {
    await d.insert(kv).values(
      reviews.map((x) => ({
        key: `review:${x.run.id}`,
        value: { runId: x.run.id, repo: SEED_REPO, issueNumber: x.run.issueNumber, source: x.run.source, reason: "seed", state: "open", createdAt: (x.run.createdAt as Date).toISOString() },
        expiresAt: null,
      })),
    );
  }

  const spentBy = (id: string) => all.filter((x) => x.run.authorExternalId === id).reduce((n, x) => n + (x.run.totalCostUsd ?? 0), 0);
  const reset = midnight();
  await d.insert(authors).values([
    { externalId: SEED_AUTHORS.wave, display: null, budgetId: b.newcomer, blocked: false, spendUsd: spentBy(SEED_AUTHORS.wave), requests: 10, nextResetAt: reset, refreshedAt: at(20) },
    { externalId: SEED_AUTHORS.visitor, display: null, budgetId: b.newcomer, blocked: false, spendUsd: spentBy(SEED_AUTHORS.visitor), requests: 6, nextResetAt: reset, refreshedAt: at(20) },
    { externalId: SEED_AUTHORS.reporter, display: null, budgetId: b.regular, blocked: false, spendUsd: spentBy(SEED_AUTHORS.reporter), requests: 9, nextResetAt: reset, refreshedAt: at(20) },
    { externalId: SEED_AUTHORS.blocked, display: null, budgetId: b.newcomer, blocked: true, spendUsd: 0, requests: 1, nextResetAt: reset, refreshedAt: at(20) },
  ]);

  console.log(`seeded under ${SEED_REPO} (newcomer cap ${b.newcomerLimit ?? "unknown"}, regular cap ${b.regularLimit ?? "unknown"})`);
  console.log("counts:", await countUiDemo(d));
  console.log(`wave:      /try?wave=${waveRuns.map((x) => x.run.id).join(",")}`);
  const by = (t: string) => all.find((x) => x.run.title === t)?.run.id;
  console.log(`injection: /try?run=${by(presetIssues("injection")[0].title)}`);
  console.log(`repro:     /console/runs/${by(presetIssues("repro")[0].title)}`);
  console.log(`held:      /console/runs/${by(presetIssues("injection")[0].title)}`);
  console.log(`output:    /console/runs/${by("Where is the export API documented?")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
