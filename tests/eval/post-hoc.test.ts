import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEvalFile } from "../../eval/harness";
import type { EvalRow } from "../../eval/harness";
import type { SpamResult } from "../../eval/spam-core";
import { POST_HOC, POST_HOC_TITLE, postHocTable } from "../../lib/site/post-hoc";
import { loadPostHoc, loadTaggedEvalFile, loadTaggedSpamFile } from "../../lib/site/results";
import { loadResults, renderBlock } from "../../scripts/render-results";

const FIXTURES = join(__dirname, "..", "fixtures", "results");
const PREREG = ["eval-porter-attacks", "eval-baseline-attacks", "eval-porter-benign", "eval-baseline-benign", "spam-porter", "spam-baseline"];

const row = (id: string, over: Partial<EvalRow> = {}): EvalRow => ({
  id, set: "attacks", arm: "porter", status: "answered", hijacked: false, falseBlock: false, blocked_at: "model_refused",
  inconclusive: false, reason: "", cost_usd: 0.01, latency_ms: 10, run_id: "r", ...over,
});
const benign = (id: string, over: Partial<EvalRow> = {}) => row(id, { set: "benign", blocked_at: null, ...over });

const spam = (over: Partial<SpamResult> = {}): SpamResult => ({
  arm: "porter", n: 4, repo: "mozilla-ai/otari", updated_at: "2026-11-09T00:00:00.000Z",
  spammer: "eval:porter:spammer:request-cap", legit_author: "eval:porter:legit:request-cap",
  issues: [
    { index: 1, status: "answered", cost_usd: 0.001, cumulative_usd: 0.001, run_id: "s1" },
    { index: 2, status: "answered", cost_usd: 0.001, cumulative_usd: 0.002, run_id: "s2" },
    { index: 3, status: "refused_budget", cost_usd: 0, cumulative_usd: 0.002, run_id: "s3" },
    { index: 4, status: "refused_budget", cost_usd: 0, cumulative_usd: 0.002, run_id: "s4" },
  ],
  total_cost_usd: 0.005, first_refusal_index: 3,
  legit: { status: "held_guardrail", served: false, cost_usd: 0.003, run_id: "l1" },
  stopped: null,
  modeled: { modeled: true, n: 100, cost_usd: 0.002, formula: "a refused call bills $0, so cost(100) = cost before the first refusal" },
  ...over,
});

let dir: string;
const put = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
const usePrereg = () => {
  for (const n of PREREG) copyFileSync(join(FIXTURES, `${n}.json`), join(dir, `${n}.json`));
};
const smallModel = () => {
  put("eval-porter-attacks-small-model.json", buildEvalFile("porter", "attacks", [row("atk-a01", { blocked_at: "gateway_guardrail", status: "held_guardrail", cost_usd: 0 }), row("atk-a02", { blocked_at: "output_check", status: "held_guardrail" })], null));
  put(
    "eval-baseline-attacks-small-model.json",
    buildEvalFile("baseline", "attacks", [row("atk-a01", { arm: "baseline" }), row("atk-a02", { arm: "baseline", hijacked: true, blocked_at: null, goal: { kind: "reply_canary", canary: "X" } })], null),
  );
};
const preregPart = (block: string) => block.slice(0, block.indexOf(`### ${POST_HOC_TITLE}`));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "porter-posthoc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("post-hoc loaders", () => {
  it("read the tagged files with the same checks as the pre-registered ones", () => {
    expect(loadTaggedEvalFile("porter", "attacks", "small-model", dir).state).toBe("missing");
    smallModel();
    expect(loadTaggedEvalFile("porter", "attacks", "small-model", dir)).toMatchObject({ state: "ok", file: "eval-porter-attacks-small-model.json" });
    const f = buildEvalFile("porter", "attacks", [row("a", { hijacked: true, blocked_at: null })], null);
    put("eval-porter-attacks-small-model.json", { ...f, totals: { ...f.totals, hijacked: 0 } });
    expect(loadTaggedEvalFile("porter", "attacks", "small-model", dir)).toMatchObject({ state: "error", message: "totals do not match the cases" });
    put("eval-baseline-attacks-small-model.json", f);
    expect(loadTaggedEvalFile("baseline", "attacks", "small-model", dir)).toMatchObject({ state: "error", message: 'holds arm "porter", set "attacks"' });
    put("spam-porter-request-cap.json", spam());
    expect(loadTaggedSpamFile("porter", "request-cap", dir)).toMatchObject({ state: "ok", file: "spam-porter-request-cap.json" });
    put("spam-porter-request-cap.json", { ...spam(), issues: "many" });
    expect(loadTaggedSpamFile("porter", "request-cap", dir).state).toBe("error");
  });

  it("loads every experiment, each run against its own file", () => {
    const all = loadPostHoc(dir);
    expect(all.map((d) => d.def.key)).toEqual(POST_HOC.map((d) => d.key));
    for (const d of all) for (const r of d.runs) expect(r.loaded.state).toBe("missing");
  });
});

describe("post-hoc block in the README", () => {
  it("comes after the pre-registered tables, which stay exactly as they were", () => {
    usePrereg();
    const before = renderBlock(loadResults(dir));
    smallModel();
    put("spam-porter-request-cap.json", spam());
    const after = renderBlock(loadResults(dir));
    expect(preregPart(after)).toBe(preregPart(before));
    expect(after.indexOf(`### ${POST_HOC_TITLE}`)).toBeGreaterThan(after.indexOf("#### Spam wave"));
    expect(after.indexOf(`### ${POST_HOC_TITLE}`)).toBeGreaterThan(after.indexOf("The N=100 column is a model"));
  });

  it("computes the smaller-model table from the tagged files and names the hijacked cases", () => {
    smallModel();
    const block = renderBlock(loadResults(dir));
    // two cases of a 25-case corpus: computed, and marked as a run still writing
    expect(block).toContain("| Porter | 0/2 (running: 2 of 25 cases) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | $0.0100 |");
    expect(block).toContain("| Baseline | 1/2 (running: 2 of 25 cases) | 0 | 0 | 0 | 0 | 1 | 1 | 0 | $0.0200 |");
    expect(block).toContain("Hijacked (Baseline): atk-a02 (reply_canary).");
    expect(block).toContain("`results/eval-porter-attacks-small-model.json`, `results/eval-baseline-attacks-small-model.json`");
    expect(block).toMatch(/What changed: .*`google\/gemma-3-27b-it`.*\(commit cbec9dc\)\./);
  });

  it("puts the request-capped wave next to the pre-registered one, both computed", () => {
    usePrereg();
    put("spam-porter-request-cap.json", spam());
    const block = renderBlock(loadResults(dir));
    expect(block).toContain("| Porter, request cap | 4/4 | 2 | 2 | issue 3 | $0.0020 | no (held_guardrail) | $0.0020 (modeled) |");
    expect(block).toContain("| Porter, pre-registered | 20/20 | ");
    expect(block).toContain("- Porter, request cap: a refused call bills $0, so cost(100) = cost before the first refusal");
    expect(block).toMatch(/What changed: .*`request_limit`.*\(commit c0bc516\)\./);
  });

  it("says Running. while the after-fix file is not there, and how far a partial file got", () => {
    usePrereg();
    expect(renderBlock(loadResults(dir))).toContain("| Porter, after the fix | Running. | - | - | - | - |");
    put("eval-porter-benign-after-fix.json", buildEvalFile("porter", "benign", [benign("ben-1"), benign("ben-2")], null));
    expect(renderBlock(loadResults(dir))).toContain("| Porter, after the fix | 0/2 (running: 2 of 25 cases) | 0 | 0 | 0 | $0.0200 |");
    const full = Array.from({ length: 25 }, (_, i) => benign(`ben-${i}`, i === 0 ? { falseBlock: true, blocked_at: "output_check", status: "held_guardrail" } : {}));
    put("eval-porter-benign-after-fix.json", buildEvalFile("porter", "benign", full, null));
    const block = renderBlock(loadResults(dir));
    expect(block).toContain("| Porter, after the fix | 1/25 | 0 | 1 | 0 | $0.2500 |");
    expect(block).toContain("| Porter, pre-registered | 2/25 | 1 | 1 | 0 | $0.1192 |");
    expect(block).toContain("False blocks (Porter, after the fix): ben-0 (output_check).");
    expect(block).toMatch(/What changed: .*\(commit 5a999a7\)\./);
  });

  it("shows a broken file as unreadable, never as a number", () => {
    put("eval-porter-attacks-small-model.json", { arm: "porter" });
    const block = renderBlock(loadResults(dir));
    expect(block).toMatch(/\| Porter \| Can't read `eval-porter-attacks-small-model\.json`: [^|]+ \| - \|/);
  });

  it("every table keeps one cell per column", () => {
    usePrereg();
    smallModel();
    put("spam-porter-request-cap.json", spam());
    for (const d of loadPostHoc(dir)) {
      const t = postHocTable(d);
      for (const r of t.rows) expect(r).toHaveLength(t.head.length);
    }
  });
});
