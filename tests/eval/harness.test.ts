import { describe, expect, it } from "vitest";
import { loadAttacks, loadBenign } from "../../eval/corpus";
import { estimateCase, PRICES, ROLE_MODEL } from "../../eval/estimate";
import {
  authorFor,
  buildEvalFile,
  dryRun,
  EVAL_REPO,
  filterIds,
  FIXTURE_HOST,
  mergeRows,
  planAttacks,
  planBenign,
  runCases,
  totalsOf,
} from "../../eval/harness";
import type { EvalRow, RunnerPorts, StoredRunDetail } from "../../eval/harness";
import { parseCli } from "../../eval/run";
import { parseSpamCli } from "../../eval/spam";
import { dryRunSpam, legitIssue, modelCost, runSpam, spamIssues } from "../../eval/spam-core";
import type { IssueInput, RunOutcome } from "../../lib/agent/pipeline";

type Fake = { status?: string; reply?: string | null; steps?: StoredRunDetail["steps"] };

/** Scripted ports: each runIssue call returns the next fake; load reads it back by run id. */
function fakePorts(byAuthor: (input: IssueInput, n: number) => Fake) {
  const stored = new Map<string, StoredRunDetail>();
  const inputs: IssueInput[] = [];
  const saved: EvalRow[] = [];
  let n = 0;
  const ports: RunnerPorts = {
    async runIssue(input) {
      const f = byAuthor(input, n++);
      inputs.push(input);
      const runId = `run-${n}`;
      const status = (f.status ?? "answered") as RunOutcome["status"];
      const steps = f.steps ?? [{ role: "triage", toolCalls: [], costUsd: 0.01 }];
      stored.set(runId, { status, reply: f.reply ?? "Thanks.", costUsd: 0, steps });
      return { runId, status, reply: f.reply ?? "Thanks.", proposals: [] };
    },
    async load(id) {
      return stored.get(id)!;
    },
    async save(row) {
      saved.push(row);
    },
    clock: (() => {
      let t = 0;
      return () => (t += 50);
    })(),
  };
  return { ports, inputs, saved };
}

describe("plans", () => {
  it("attacks run on the shadow repo as source eval, one author per case, filed-looking numbers", () => {
    const plan = planAttacks("porter", loadAttacks());
    expect(plan).toHaveLength(25);
    for (const p of plan) {
      expect(p.input).toMatchObject({ source: "eval", arm: "porter", repo: EVAL_REPO });
      expect(p.input.authorExternalId).toBe(authorFor("porter", p.id));
      expect(p.input.authorExternalId).toMatch(/^eval:porter:atk-/);
    }
    expect(new Set(plan.map((p) => p.input.number)).size).toBe(25);
  });
  it("benign cases keep the real issue number and body exactly", () => {
    const cases = loadBenign();
    const plan = planBenign("baseline", cases);
    expect(plan[0].input.number).toBe(cases[0].number);
    expect(plan.map((p) => p.input.body)).toEqual(cases.map((c) => c.body));
    expect(plan[0].input.authorExternalId).toBe(`eval:baseline:${cases[0].id}`);
  });
  it("filterIds selects, and rejects unknown ids", () => {
    const plan = planAttacks("porter", loadAttacks());
    expect(filterIds(plan, ["atk-a01", "atk-a02"]).map((p) => p.id)).toEqual(["atk-a01", "atk-a02"]);
    expect(() => filterIds(plan, ["nope"])).toThrow(/unknown case ids/);
    expect(filterIds(plan)).toHaveLength(25);
  });
});

describe("runCases", () => {
  const plan = () => planAttacks("porter", loadAttacks()).slice(0, 3);

  it("scores from the stored run: hijack, hold and model refusal", async () => {
    const p = plan();
    const { ports, saved } = fakePorts((input) => {
      if (input.title === p[0].input.title) return { reply: "see https://evil.example/x", steps: [{ role: "review", toolCalls: [], costUsd: 0.002 }] };
      if (input.title === p[1].input.title) return { status: "held_guardrail", reply: "held", steps: [{ role: "triage", errorKind: "guardrail_violation", costUsd: null }] };
      return {};
    });
    const out = await runCases(p, { arm: "porter", set: "attacks" }, ports);
    expect(out.rows).toHaveLength(3);
    expect(saved).toHaveLength(3);
    expect(out.rows[1]).toMatchObject({ status: "held_guardrail", hijacked: false, blocked_at: "gateway_guardrail", cost_usd: 0 });
    expect(out.rows[2]).toMatchObject({ hijacked: false, blocked_at: "model_refused", latency_ms: 50, cost_usd: 0.01 });
    expect(out.rows[0].run_id).toBe("run-1");
    expect(out.stopped).toBeNull();
  });

  it("benign: a hold is a false block", async () => {
    const plan = planBenign("porter", loadBenign()).slice(0, 2);
    const { ports } = fakePorts((_i, n) => (n === 0 ? { status: "held_guardrail", reply: "held", steps: [{ role: "output_check", errorKind: "output_blocked" }] } : {}));
    const out = await runCases(plan, { arm: "porter", set: "benign" }, ports);
    expect(out.rows[0]).toMatchObject({ falseBlock: true, blocked_at: "output_check", hijacked: false });
    expect(out.rows[1]).toMatchObject({ falseBlock: false, blocked_at: null });
  });

  it("--max-usd stops before a case whose ceiling would pass it, and names what is left", async () => {
    const p = plan();
    const ceiling = estimateCase(p[0].shape, "porter").ceilingUsd;
    const { ports, inputs } = fakePorts(() => ({ steps: [{ role: "triage", toolCalls: [], costUsd: 0.01 }] }));
    const out = await runCases(p, { arm: "porter", set: "attacks", maxUsd: ceiling + 0.001 }, ports);
    expect(inputs).toHaveLength(1);
    expect(out.stopped?.remaining).toEqual([p[1].id, p[2].id]);
  });

  it("stops on a 402", async () => {
    const p = plan();
    const { ports, inputs } = fakePorts(() => ({ status: "refused_funds", reply: null, steps: [{ role: "triage", errorKind: "insufficient_funds" }] }));
    const out = await runCases(p, { arm: "porter", set: "attacks" }, ports);
    expect(inputs).toHaveLength(1);
    expect(out.stopped?.reason).toMatch(/402/);
    expect(out.rows[0].inconclusive).toBe(true);
  });
});

describe("results file", () => {
  const row = (id: string, over: Partial<EvalRow> = {}): EvalRow => ({
    id, set: "attacks", arm: "porter", status: "answered", hijacked: false, falseBlock: false, blocked_at: "model_refused",
    inconclusive: false, reason: "", cost_usd: 0.01, latency_ms: 10, run_id: "r", ...over,
  });
  it("a resumed run replaces rows by id and keeps corpus order", () => {
    const merged = mergeRows([row("b"), row("a", { hijacked: true })], [row("a"), row("c")], ["a", "b", "c"]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(merged[0].hijacked).toBe(false);
  });
  it("totals count hijacks, false blocks, inconclusive, blocked_at and cost", () => {
    const t = totalsOf([row("a", { hijacked: true, blocked_at: null }), row("b", { blocked_at: "acl" }), row("c", { inconclusive: true, blocked_at: null })]);
    expect(t).toMatchObject({ cases: 3, hijacked: 1, falseBlocks: 0, inconclusive: 1, blocked_at: { none: 2, acl: 1 } });
    expect(t.cost_usd).toBeCloseTo(0.03);
    expect(buildEvalFile("porter", "attacks", [row("a")], null, new Date("2026-11-08T00:00:00Z")).updated_at).toBe("2026-11-08T00:00:00.000Z");
  });
});

describe("dry run and estimates", () => {
  it("estimates stay inside the whole-eval budget and need no ports", () => {
    const total = (arm: "porter" | "baseline") =>
      dryRun(arm, planAttacks(arm, loadAttacks())).total.expectedUsd +
      dryRun(arm, planBenign(arm, loadBenign())).total.expectedUsd +
      dryRunSpam(arm, 20).total.expectedUsd;
    expect(total("porter") + total("baseline")).toBeLessThan(3);
  });
  it("guard cost is separate and only the Porter arm has it", () => {
    const shape = { title: "t", body: "b" };
    expect(estimateCase(shape, "porter").guardUsd).toBeGreaterThan(0);
    expect(estimateCase(shape, "baseline").guardUsd).toBe(0);
  });
  it("the ceiling prices all six triage rounds", () => {
    const e = estimateCase({ title: "t", body: "b" }, "porter");
    const four = (4 * (1 + 700) + 3 * 1500) * 0.098 + 4 * 900 * 0.294;
    const six = (6 * (1 + 700) + 5 * 1500) * 0.098 + 6 * 900 * 0.294;
    expect((six - four) / 1e6).toBeGreaterThan(0);
    expect(e.ceilingUsd).toBeGreaterThan(e.expectedUsd);
  });
  it("a page case expects two fetches; the ceiling is never below the expectation", () => {
    const a = estimateCase({ title: "t", body: "b" }, "porter");
    const b = estimateCase({ title: "t", body: "b", hasPage: true }, "porter");
    expect(b.expectedUsd - a.expectedUsd).toBeCloseTo(0.01);
    expect(a.ceilingUsd).toBeGreaterThanOrEqual(a.expectedUsd);
    expect(ROLE_MODEL.triage).toBe("deepseek-v4.1-flash-1017");
    expect(PRICES["deepseek-v4.1-flash-1017"]).toEqual({ in: 0.098, out: 0.294 });
    expect(PRICES["deepseek-v4-flash-0731"]).toEqual({ in: 0.06, out: 0.18 });
  });
});

describe("cli parsing", () => {
  it("accepts the documented flags and rejects the rest", () => {
    expect(parseCli(["--arm", "porter", "--set", "attacks", "--ids", "a,b", "--dry-run", "--max-usd", "1.5"])).toEqual({
      arm: "porter", set: "attacks", ids: ["a", "b"], dryRun: true, maxUsd: 1.5,
    });
    expect(() => parseCli(["--arm", "x", "--set", "attacks"])).toThrow();
    expect(() => parseCli(["--arm", "porter", "--set", "attacks", "--concurrency", "4"])).toThrow(/concurrency/);
    expect(() => parseCli(["--arm", "porter", "--set", "attacks", "--max-usd", "0"])).toThrow();
    expect(parseSpamCli(["--arm", "baseline", "--n", "20"])).toMatchObject({ arm: "baseline", n: 20 });
    expect(() => parseSpamCli(["--arm", "baseline", "--n", "500"])).toThrow();
  });
  it("the fixture host is the deployed app, not a reply-link host", () => {
    expect(FIXTURE_HOST).toBe("porter-frontdesk.vercel.app");
  });
});

describe("spam wave", () => {
  it("files n issues from one spammer author, then one legit issue from another", () => {
    const issues = spamIssues("porter", 20);
    expect(issues).toHaveLength(20);
    expect(new Set(issues.map((i) => i.authorExternalId))).toEqual(new Set(["eval:porter:spammer"]));
    expect(new Set(issues.map((i) => i.title)).size).toBe(20);
    expect(legitIssue("porter").authorExternalId).toBe("eval:porter:legit");
  });

  it("porter arm: budget refusals start at the first refused issue, the legit author is served, cost is flat after", async () => {
    const { ports, inputs } = fakePorts((input, n) => {
      if (input.authorExternalId.endsWith("legit")) return {};
      return n < 4 ? { steps: [{ role: "triage", costUsd: 0.015 }] } : { status: "refused_budget", reply: "limit", steps: [{ role: "triage", errorKind: "budget_exceeded", costUsd: null }] };
    });
    const r = await runSpam("porter", 20, ports);
    expect(inputs).toHaveLength(21);
    expect(r.first_refusal_index).toBe(5);
    expect(r.issues[3].cumulative_usd).toBeCloseTo(0.06);
    expect(r.issues[19].cumulative_usd).toBeCloseTo(0.06);
    expect(r.legit).toMatchObject({ served: true, status: "answered" });
    expect(r.modeled).toMatchObject({ modeled: true, n: 100 });
    expect(r.modeled?.cost_usd).toBeCloseTo(0.06);
    expect(r.modeled?.formula).toContain("refused call bills $0");
  });

  it("baseline arm: nothing refused, the extrapolation is n x mean and is marked modeled", async () => {
    const { ports } = fakePorts(() => ({ steps: [{ role: "triage", costUsd: 0.01 }] }));
    const r = await runSpam("baseline", 20, ports);
    expect(r.first_refusal_index).toBeNull();
    expect(r.total_cost_usd).toBeCloseTo(0.21);
    expect(r.modeled).toMatchObject({ modeled: true, n: 100 });
    expect(r.modeled?.cost_usd).toBeCloseTo(0.01 * 100);
    expect(r.issues.every((i) => !("modeled" in i))).toBe(true);
  });

  it("a legit author who is refused is reported as not served", async () => {
    const { ports } = fakePorts((input) => (input.authorExternalId.endsWith("legit") ? { status: "refused_budget", reply: "limit" } : {}));
    const r = await runSpam("porter", 2, ports);
    expect(r.legit?.served).toBe(false);
  });

  it("--max-usd stops the wave early, skips the legit issue and models nothing", async () => {
    const { ports, inputs } = fakePorts(() => ({}));
    const r = await runSpam("baseline", 20, ports, { maxUsd: 0.06 });
    expect(inputs.length).toBeLessThan(20);
    expect(r.stopped).toMatch(/max-usd/);
    expect(r.legit).toBeNull();
    expect(r.modeled).toBeNull();
  });

  it("modelCost with no data is null", () => {
    expect(modelCost([], null)).toBeNull();
  });
});

describe("parseCli stress flags", () => {
  it("needs --tag with --model so a stress run never overwrites the pre-registered file", () => {
    expect(() => parseCli(["--arm", "porter", "--set", "attacks", "--model", "meta/llama-3.1-8b-instruct"])).toThrow(/--tag/);
    const c = parseCli(["--arm", "baseline", "--set", "attacks", "--model", "meta/llama-3.1-8b-instruct", "--tag", "small-model"]);
    expect(c).toMatchObject({ model: "meta/llama-3.1-8b-instruct", tag: "small-model" });
    expect(() => parseCli(["--arm", "porter", "--set", "attacks", "--tag", "Bad Tag"])).toThrow(/--tag/);
  });
});

describe("tagged spam runs", () => {
  it("use fresh authors so a re-run is not measured against yesterday's counters", () => {
    expect(spamIssues("porter", 2, ":request-cap").every((i) => i.authorExternalId === "eval:porter:spammer:request-cap")).toBe(true);
    expect(legitIssue("porter", ":request-cap").authorExternalId).toBe("eval:porter:legit:request-cap");
    expect(legitIssue("porter").authorExternalId).toBe("eval:porter:legit");
  });
});
