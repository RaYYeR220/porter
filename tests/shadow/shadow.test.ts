import { describe, expect, it } from "vitest";
import { planShadow, runShadow } from "../../scripts/shadow-core";
import type { ShadowPorts } from "../../scripts/shadow-core";
import {
  applyVerdict,
  buildShadowFile,
  parseVerdict,
  releaseEvidence,
  sampleIssues,
  shadowEndUserId,
  summarizeShadow,
} from "../../lib/shadow";
import type { ShadowFile, SnapshotIssue } from "../../lib/shadow";
import type { IssueInput } from "../../lib/agent/pipeline";

const mk = (n: number, over: Partial<SnapshotIssue> = {}): SnapshotIssue => ({
  number: n,
  title: `Issue ${n}`,
  body: `body ${n}`,
  author: "Alice",
  labels: [],
  createdAt: new Date(2026, 0, 1 + n),
  ...over,
});
const open = Array.from({ length: 100 }, (_, i) => mk(i + 1));

describe("sampleIssues", () => {
  it("takes the newest 20 and 20 random from the rest, deterministically", () => {
    const a = sampleIssues(open, { size: 40, seed: "s", exclude: [] });
    const b = sampleIssues([...open].reverse(), { size: 40, seed: "s", exclude: [] });
    expect(a.newest.map((i) => i.number)).toEqual(Array.from({ length: 20 }, (_, i) => 100 - i));
    expect(a.random).toHaveLength(20);
    expect(b.random.map((i) => i.number)).toEqual(a.random.map((i) => i.number));
    expect(a.random.every((i) => i.number <= 80)).toBe(true);
    expect(new Set([...a.newest, ...a.random].map((i) => i.number)).size).toBe(40);
  });
  it("a different seed gives a different random half", () => {
    const a = sampleIssues(open, { size: 40, seed: "s", exclude: [] });
    const b = sampleIssues(open, { size: 40, seed: "t", exclude: [] });
    expect(b.random.map((i) => i.number)).not.toEqual(a.random.map((i) => i.number));
  });
  it("never samples excluded (eval) issues, in either half", () => {
    const exclude = [100, 99, 5, 6, 7];
    const s = sampleIssues(open, { size: 40, seed: "s", exclude });
    const all = [...s.newest, ...s.random].map((i) => i.number);
    for (const n of exclude) expect(all).not.toContain(n);
    expect(all).toHaveLength(40);
    expect(s.newest[0].number).toBe(98);
  });
  it("returns what exists when the tracker is small", () => {
    const s = sampleIssues(open.slice(0, 7), { size: 40, seed: "s", exclude: [] });
    expect(s.newest.length + s.random.length).toBe(7);
  });
});

describe("planShadow", () => {
  it("builds shadow-source inputs with lowercased shadow: authors", () => {
    const [p] = planShadow([mk(3, { author: "MixedCase" })]);
    expect(p.input).toMatchObject({ source: "shadow", arm: "porter", repo: "mozilla-ai/otari", number: 3, authorExternalId: "shadow:mixedcase" });
    expect(shadowEndUserId(null)).toBe("shadow:unknown");
  });
});

function ports(triageFor: (n: number) => unknown, status: (n: number) => string = () => "answered", cost = 0.01): ShadowPorts & { inputs: IssueInput[] } {
  const inputs: IssueInput[] = [];
  let t = 0;
  return {
    inputs,
    clock: () => (t += 25),
    async runIssue(input) {
      inputs.push(input);
      return { runId: `r${input.number}`, status: status(input.number as number) as never, reply: null, proposals: [] };
    },
    async load(runId) {
      const n = Number(runId.slice(1));
      return { status: status(n), triage: triageFor(n), costUsd: cost };
    },
  };
}

describe("runShadow", () => {
  const triage = (n: number) => ({
    summary: `s${n}`,
    kind: "bug",
    duplicates: n === 2 ? [{ number: 1, title: "Issue 1", why: "same" }, { number: 2, title: "self", why: "x" }] : [],
    fixed_in: n === 3 ? { version: "v1.2", evidence_url: "https://x/y" } : null,
    missing_info: ["logs"],
    labels: ["bug"],
  });

  it("writes the documented shape with verified: null and totals", async () => {
    const plan = planShadow([mk(1), mk(2), mk(3)]);
    const p = ports(triage, (n) => (n === 1 ? "held_guardrail" : "answered"));
    const r = await runShadow(plan, {}, p);
    const file = buildShadowFile({ sampledAt: new Date("2026-11-08T00:00:00Z"), seed: "s", sample: 3, snapshotAt: "2026-11-07T10:00:00Z", issues: r.issues });
    expect(Object.keys(file)).toEqual(["sampledAt", "seed", "sample", "snapshotAt", "issues", "totals"]);
    expect(Object.keys(file.issues[0]).sort()).toEqual(
      ["costUsd", "duplicates", "fixed_in", "kind", "labels", "latencyMs", "missing_info", "number", "runId", "status", "summary", "title", "url"],
    );
    expect(file.issues[1].duplicates).toEqual([{ number: 1, title: "Issue 1", why: "same", verified: null }]);
    expect(file.issues[2].fixed_in).toEqual({ version: "v1.2", evidence_url: "https://x/y", verified: null });
    expect(file.issues[1].url).toBe("https://github.com/mozilla-ai/otari/issues/2");
    expect(file.issues[0].latencyMs).toBe(25);
    expect(file.totals).toMatchObject({ answered: 2, held: 1, refused: 0, failed: 0, duplicatesClaimed: 1, fixedInClaimed: 1 });
    expect(file.totals.costUsd).toBeCloseTo(0.03);
    expect(p.inputs.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it("stops before the issue whose ceiling would pass --max-usd", async () => {
    const plan = planShadow([mk(1), mk(2), mk(3)]);
    const r = await runShadow(plan, { maxUsd: 0.0001 }, ports(triage));
    expect(r.issues).toHaveLength(0);
    expect(r.stopped?.remaining).toEqual([1, 2, 3]);
  });

  it("stops on 402 and lists the rest", async () => {
    const plan = planShadow([mk(1), mk(2), mk(3)]);
    const r = await runShadow(plan, {}, ports(triage, (n) => (n === 2 ? "refused_funds" : "answered")));
    expect(r.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(r.stopped).toEqual({ reason: "insufficient funds (402)", remaining: [3] });
  });

  it("failed runs with no triage still produce a row", async () => {
    const r = await runShadow(planShadow([mk(9)]), {}, ports(() => null, () => "failed"));
    expect(r.issues[0]).toMatchObject({ kind: null, summary: null, duplicates: [], fixed_in: null, status: "failed" });
  });
});

describe("verdicts and summary", () => {
  const base = async (): Promise<ShadowFile> => {
    const r = await runShadow(
      planShadow([mk(2), mk(3), mk(4)]),
      {},
      ports((n) => ({
        summary: "s",
        kind: "bug",
        duplicates: n === 2 ? [{ number: 1, title: "a", why: "w" }, { number: 7, title: "b", why: "w" }] : [],
        fixed_in: n === 3 ? { version: "1.2", evidence_url: "u" } : null,
        missing_info: [],
        labels: [],
      })),
    );
    return buildShadowFile({ sampledAt: new Date(), seed: "s", sample: 3, snapshotAt: null, issues: r.issues });
  };

  it("parses verdict arguments", () => {
    expect(parseVerdict("12:dup:true")).toEqual({ issue: 12, claim: "dup", value: true });
    expect(parseVerdict("12:dup=7:false")).toEqual({ issue: 12, claim: "dup", target: 7, value: false });
    expect(parseVerdict("3:fixed:true")).toEqual({ issue: 3, claim: "fixed", value: true });
    for (const bad of ["x", "1:dup", "1:fixed=2:true", "1:dup:maybe", "1:other:true"]) expect(() => parseVerdict(bad)).toThrow();
  });

  it("records verdicts without mutating the input", async () => {
    const f = await base();
    const g = applyVerdict(applyVerdict(f, parseVerdict("2:dup=1:true")), parseVerdict("2:dup=7:false"));
    expect(g.issues[0].duplicates.map((d) => d.verified)).toEqual([true, false]);
    expect(f.issues[0].duplicates.map((d) => d.verified)).toEqual([null, null]);
    expect(applyVerdict(f, parseVerdict("2:dup:true")).issues[0].duplicates.map((d) => d.verified)).toEqual([true, true]);
    expect(applyVerdict(f, parseVerdict("3:fixed:false")).issues[1].fixed_in?.verified).toBe(false);
  });

  it("rejects verdicts for claims that do not exist", async () => {
    const f = await base();
    expect(() => applyVerdict(f, parseVerdict("99:dup:true"))).toThrow(/not in the shadow file/);
    expect(() => applyVerdict(f, parseVerdict("4:fixed:true"))).toThrow(/no fixed_in/);
    expect(() => applyVerdict(f, parseVerdict("2:dup=55:true"))).toThrow(/no duplicate claim/);
  });

  it("summarizes counts and precision from verified flags only", async () => {
    const f = await base();
    const none = summarizeShadow(f);
    expect(none).toMatchObject({ issues: 3, answered: 3, duplicatesClaimed: 2, fixedInClaimed: 1, claims: 3, checked: 0, precision: null });
    expect(none.checkedLabel).toBe("0 of 3 claims checked by hand");
    const g = applyVerdict(applyVerdict(applyVerdict(f, parseVerdict("2:dup=1:true")), parseVerdict("2:dup=7:false")), parseVerdict("3:fixed:true"));
    const s = summarizeShadow(g);
    expect(s).toMatchObject({ checked: 3, correct: 2 });
    expect(s.precision).toBeCloseTo(2 / 3);
    const part = summarizeShadow(applyVerdict(f, parseVerdict("3:fixed:true")));
    expect(part).toMatchObject({ checked: 1, correct: 1, precision: 1 });
    expect(part.checkedLabel).toBe("1 of 3 claims checked by hand");
  });
});

describe("releaseEvidence", () => {
  const rel = [
    { tag: "v1.1.0", name: null, body: "- Fix crash in streaming budget check (#41)\n- Docs" },
    { tag: "v1.2.0", name: "1.2.0", body: "- Budget caps now apply to streaming\n- Unrelated thing\nCloses #410" },
  ];
  it("finds lines citing the exact issue number only", () => {
    const e = releaseEvidence(rel, 41, "Streaming budget crash", "v1.1.0");
    expect(e.mentions).toEqual([{ tag: "v1.1.0", line: "- Fix crash in streaming budget check (#41)" }]);
    expect(e.claimedReleaseFound).toBe(true);
  });
  it("matches the claimed release with or without v and reports keyword lines", () => {
    const e = releaseEvidence(rel, 99, "Budget caps ignored while streaming", "1.2.0");
    expect(e.claimedReleaseFound).toBe(true);
    expect(e.mentions).toEqual([]);
    expect(e.keywordHits.map((h) => h.line)).toEqual(["- Budget caps now apply to streaming"]);
  });
  it("says so when the claimed release is not in the table", () => {
    expect(releaseEvidence(rel, 99, "x", "v9.9.9")).toMatchObject({ claimedReleaseFound: false, keywordHits: [] });
  });
});

describe("shadow CLI helpers", () => {
  it("parses flags and rejects bad ones", async () => {
    const { parseCli } = await import("../../scripts/shadow");
    expect(parseCli([])).toEqual({ dryRun: false, maxUsd: undefined, sample: 40, seed: "porter-shadow-v1", ids: undefined });
    expect(parseCli(["--dry-run", "--max-usd", "1.5", "--sample", "10", "--ids", "3,4"])).toMatchObject({ dryRun: true, maxUsd: 1.5, sample: 10, ids: [3, 4] });
    expect(() => parseCli(["--max-usd", "0"])).toThrow();
    expect(() => parseCli(["--ids", "a"])).toThrow();
  });
  it("--ids must name open issues", async () => {
    const { chooseSample } = await import("../../scripts/shadow");
    expect(chooseSample(open, { sample: 40, seed: "s", ids: [5, 2] }, []).newest.map((i) => i.number)).toEqual([5, 2]);
    expect(() => chooseSample(open, { sample: 40, seed: "s", ids: [999] }, [])).toThrow(/not open/);
  });
  it("a rerun keeps other rows and refuses to discard a verdict", async () => {
    const { mergeShadow } = await import("../../scripts/shadow");
    const r = await runShadow(planShadow([mk(1), mk(2)]), {}, ports(() => ({ summary: "s", kind: "bug", fixed_in: { version: "1", evidence_url: "u" } })));
    const merged = mergeShadow(r.issues, [{ ...r.issues[0], summary: "new" }], [1, 2]);
    expect(merged.map((i) => i.number)).toEqual([1, 2]);
    expect(merged[0].summary).toBe("new");
    const checked = applyVerdict(buildShadowFile({ sampledAt: new Date(), seed: "s", sample: 2, snapshotAt: null, issues: r.issues }), parseVerdict("1:fixed:true"));
    expect(() => mergeShadow(checked.issues, [r.issues[0]], [1, 2])).toThrow(/hand-checked/);
  });
  it("verify output shows both issues and release text, and the checked count", async () => {
    const { renderClaims } = await import("../../scripts/shadow-verify");
    const r = await runShadow(
      planShadow([mk(2, { title: "Streaming budget crash" })]),
      {},
      ports(() => ({ summary: "s", kind: "bug", duplicates: [{ number: 1, title: "Issue 1", why: "same" }], fixed_in: { version: "v1.1.0", evidence_url: "u" } })),
    );
    const file = buildShadowFile({ sampledAt: new Date(), seed: "s", sample: 1, snapshotAt: null, issues: r.issues });
    const text = renderClaims(file, new Map(open.map((i) => [i.number, i])), [{ tag: "v1.1.0", name: null, body: "- Fix streaming budget crash (#2)" }]);
    expect(text).toContain("#2 Issue 2");
    expect(text).toContain("#1 Issue 1");
    expect(text).toContain("cites #2 [v1.1.0]: - Fix streaming budget crash (#2)");
    expect(text).toContain("--set 2:dup=1:true|false");
    expect(text).toContain("0 of 2 claims checked by hand");
  });
});
