import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEvalFile } from "../../eval/harness";
import type { EvalFile, EvalRow } from "../../eval/harness";
import {
  caseTone,
  claimState,
  headlineSentence,
  layerCounts,
  layerOf,
  precisionLine,
  runHref,
  sampleText,
  safeHttpUrl,
} from "../../lib/site/evidence";
import type { Loaded, PerArm } from "../../lib/site/evidence";
import { corpusSummary, loadEvalFile, loadEvalResults, loadShadowReport, loadSpamFile, resultsDir } from "../../lib/site/results";

const FIXTURES = join(__dirname, "..", "fixtures", "results");

const row = (id: string, over: Partial<EvalRow> = {}): EvalRow => ({
  id, set: "attacks", arm: "porter", status: "answered", hijacked: false, falseBlock: false, blocked_at: "model_refused",
  inconclusive: false, reason: "", cost_usd: 0.01, latency_ms: 10, run_id: "r", ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "porter-evidence-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resultsDir", () => {
  it("is results/ under the working directory by default", () => {
    expect(resultsDir({ NODE_ENV: "test" })).toBe(join(process.cwd(), "results"));
  });
  it("follows PORTER_RESULTS_DIR outside production only", () => {
    expect(resultsDir({ NODE_ENV: "development", PORTER_RESULTS_DIR: "/fx" })).toBe("/fx");
    expect(resultsDir({ NODE_ENV: "production", PORTER_RESULTS_DIR: "/fx" })).toBe(join(process.cwd(), "results"));
    expect(resultsDir({ NODE_ENV: "development", PORTER_RESULTS_DIR: "  " })).toBe(join(process.cwd(), "results"));
  });
});

describe("eval loaders", () => {
  it("reports every file as not run when the folder is empty", () => {
    const r = loadEvalResults(dir);
    for (const set of [r.attacks, r.benign, r.spam]) {
      expect(set.porter.state).toBe("missing");
      expect(set.baseline.state).toBe("missing");
    }
  });

  it("reads all six committed-shape fixtures", () => {
    const r = loadEvalResults(FIXTURES);
    for (const set of [r.attacks, r.benign, r.spam]) {
      expect(set.porter.state).toBe("ok");
      expect(set.baseline.state).toBe("ok");
    }
  });

  it("turns a file that is not JSON into an error state, not a crash", () => {
    writeFileSync(join(dir, "eval-porter-attacks.json"), "{ not json");
    const l = loadEvalFile("porter", "attacks", dir);
    expect(l).toEqual({ state: "error", file: "eval-porter-attacks.json", message: "not valid JSON" });
  });

  it("turns a file of the wrong shape into an error state naming the field", () => {
    writeFileSync(join(dir, "eval-porter-attacks.json"), JSON.stringify({ arm: "porter", set: "attacks", cases: "lots" }));
    const l = loadEvalFile("porter", "attacks", dir);
    expect(l.state).toBe("error");
    expect(l.state === "error" && l.message).toMatch(/repo|totals|cases/);
  });

  it("refuses totals that do not match the cases, and a file for another arm", () => {
    const f = buildEvalFile("porter", "attacks", [row("a", { hijacked: true, blocked_at: null }), row("b")], null);
    writeFileSync(join(dir, "eval-porter-attacks.json"), JSON.stringify({ ...f, totals: { ...f.totals, hijacked: 0 } }));
    expect(loadEvalFile("porter", "attacks", dir)).toMatchObject({ state: "error", message: "totals do not match the cases" });
    writeFileSync(join(dir, "eval-baseline-attacks.json"), JSON.stringify(f));
    expect(loadEvalFile("baseline", "attacks", dir)).toMatchObject({ state: "error", message: 'holds arm "porter", set "attacks"' });
  });

  it("reads a spam file and rejects one with more issues than were filed", () => {
    copyFileSync(join(FIXTURES, "spam-porter.json"), join(dir, "spam-porter.json"));
    expect(loadSpamFile("porter", dir).state).toBe("ok");
    const s = JSON.parse(readFileSync(join(FIXTURES, "spam-porter.json"), "utf8"));
    writeFileSync(join(dir, "spam-porter.json"), JSON.stringify({ ...s, n: 3 }));
    expect(loadSpamFile("porter", dir)).toMatchObject({ state: "error" });
  });
});

describe("shadow loader", () => {
  it("is not run without the file, an error with a broken one", () => {
    expect(loadShadowReport(dir).state).toBe("missing");
    writeFileSync(join(dir, "shadow-otari.json"), "[]");
    expect(loadShadowReport(dir).state).toBe("error");
  });

  it("summarises the file with lib/shadow, counting only hand-checked claims", () => {
    const l = loadShadowReport(FIXTURES);
    expect(l.state).toBe("ok");
    if (l.state !== "ok") return;
    expect(l.data.summary).toMatchObject({ claims: 5, checked: 3, correct: 2, dangling: 1 });
    expect(precisionLine(l.data.summary)).toBe("3 of 5 claims checked by hand: 67% correct");
    expect(sampleText(l.data.file)).toBe("8 issues (seeded sample)");
  });
});

describe("headline sentence", () => {
  const ok = (f: EvalFile): Loaded<EvalFile> => ({ state: "ok", file: "x", data: f });
  const missing: Loaded<EvalFile> = { state: "missing", file: "x" };
  const porter = buildEvalFile("porter", "attacks", [row("a"), row("b", { status: "failed", inconclusive: true, blocked_at: null })], null);
  const baseline = buildEvalFile("baseline", "attacks", [row("a", { arm: "baseline", hijacked: true, blocked_at: null }), row("b", { arm: "baseline" })], null);

  it("is computed only when both attack files were read", () => {
    expect(headlineSentence({ porter: ok(porter), baseline: missing })).toBeNull();
    expect(headlineSentence({ porter: missing, baseline: ok(baseline) })).toBeNull();
    expect(headlineSentence({ porter: { state: "error", file: "x", message: "m" }, baseline: ok(baseline) })).toBeNull();
    const both: PerArm<EvalFile> = { porter: ok(porter), baseline: ok(baseline) };
    expect(headlineSentence(both)).toBe("Porter: 0 of 2 attacks got the bot to act (1 inconclusive); the same bot with prompt-only defences: 1 of 2.");
  });
});

describe("layers and marks", () => {
  it("keeps a refused write at its layer and counts it as hijacked", () => {
    const rows = [
      row("a", { hijacked: true, blocked_at: "acl" }),
      row("b", { hijacked: true, blocked_at: null }),
      row("c", { blocked_at: "gateway_guardrail" }),
      row("d", { blocked_at: null, inconclusive: true }),
    ];
    expect(rows.map(layerOf)).toEqual(["acl", "not_stopped", "gateway_guardrail", "no_verdict"]);
    const c = layerCounts(rows);
    expect(c.acl).toEqual({ count: 1, hijacked: 1 });
    expect(c.not_stopped.count).toBe(1);
    expect(c.model_refused.count).toBe(0);
    expect(rows.map(caseTone)).toEqual(["steered", "through", "stopped", "open"]);
    expect(caseTone(undefined)).toBe("not_run");
  });

  it("links only real run ids to the trace page", () => {
    expect(runHref("0B6A3C8E-5D1F-4C2A-9E7B-2F4D6A8C0E11")).toBe("/console/runs/0b6a3c8e-5d1f-4c2a-9e7b-2f4d6a8c0e11");
    expect(runHref("r")).toBeNull();
    expect(runHref("../../api/admin")).toBeNull();
  });
});

describe("claims", () => {
  it("has four states, and anything unverified is unchecked", () => {
    expect(claimState({ verified: true, inSnapshot: true })).toBe("correct");
    expect(claimState({ verified: false, inSnapshot: true })).toBe("wrong");
    expect(claimState({ verified: null, inSnapshot: true })).toBe("unchecked");
    expect(claimState({ verified: null, inSnapshot: false })).toBe("outside");
    expect(claimState({ verified: null })).toBe("unchecked");
  });
  it("gives no precision until a person has checked something", () => {
    expect(precisionLine({ checked: 0, claims: 4, correct: 0, precision: null, checkedLabel: "0 of 4 claims checked by hand" })).toBe(
      "Claims not yet checked by hand",
    );
  });
  it("only turns http(s) evidence into links", () => {
    expect(safeHttpUrl("https://github.com/x")).toBe("https://github.com/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });
});

describe("corpusSummary", () => {
  it("counts the committed corpus the way the pre-registration states it", () => {
    const c = corpusSummary();
    expect(c.attacks).toBe(25);
    expect(c.techniques).toHaveLength(9);
    expect(c.techniques.reduce((s, t) => s + t.ids.length, 0)).toBe(25);
    expect(c.goals).toEqual({ write_tool: { add_labels: 6, close_as_duplicate: 3, post_comment: 1 }, reply_link: 8, reply_canary: 5, leak_prompt: 2 });
    expect(c.benign).toEqual({ total: 25, general: { bug: 5, feature: 5, docs: 3, other: 6 }, generalTotal: 19, security: 6 });
    expect(c.meta.excludedForAssistantNames.total).toBe(119);
  });
});
