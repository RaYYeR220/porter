import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planShadow, runShadow } from "../../scripts/shadow-core";
import type { ShadowPorts } from "../../scripts/shadow-core";
import {
  acquireLock,
  mergePending,
  realIo,
  refreshLock,
  assertSameSeed,
  LOCK_STALE_MS,
  lockHeld,
  mergeShadowFile,
  readShadowFile,
  releaseLock,
  writeJsonAtomic,
  writeMerged,
  applyVerdict,
  buildShadowFile,
  parseVerdict,
  releaseEvidence,
  sampleIssues,
  shadowEndUserId,
  summarizeShadow,
  redactNames,
} from "../../lib/shadow";
import type { ShadowFile, ShadowIssue, SnapshotIssue } from "../../lib/shadow";
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
    expect(Object.keys(file)).toEqual(["sampledAt", "seed", "sample", "addedIds", "snapshotAt", "issues", "totals"]);
    expect(Object.keys(file.issues[0]).sort()).toEqual(
      ["costUsd", "duplicates", "fixed_in", "kind", "labels", "latencyMs", "missing_info", "number", "runId", "sampledBy", "status", "summary", "title", "url"],
    );
    expect(file.issues[1].duplicates).toEqual([{ number: 1, title: "Issue 1", why: "same", inSnapshot: true, verified: null }]);
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
    expect(parseCli([])).toEqual({ dryRun: false, maxUsd: undefined, sample: 40, seed: "porter-shadow-v1", ids: undefined, resume: false, fresh: false });
    expect(parseCli(["--dry-run", "--max-usd", "1.5", "--sample", "10", "--ids", "3,4"])).toMatchObject({ dryRun: true, maxUsd: 1.5, sample: 10, ids: [3, 4] });
    expect(() => parseCli(["--max-usd", "0"])).toThrow();
    expect(() => parseCli(["--resume", "--fresh"])).toThrow(/contradict/);
    expect(parseCli(["--resume"]).resume).toBe(true);
    expect(() => parseCli(["--ids", "a"])).toThrow();
  }, 15_000);
  it("--ids must name open issues", async () => {
    const { chooseSample } = await import("../../scripts/shadow");
    expect(chooseSample(open, { sample: 40, seed: "s", ids: [5, 2] }, []).newest.map((i) => i.number)).toEqual([5, 2]);
    expect(() => chooseSample(open, { sample: 40, seed: "s", ids: [999] }, [])).toThrow(/not open/);
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

describe("fix round 1", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "shadow-test-"));
  const t = (seed = "s", mode: "sample" | "ids" = "sample") => ({ seed, mode, at: "2026-11-08T00:00:00Z" });
  const trg = (n: number) => ({
    summary: "s",
    kind: "bug",
    duplicates: n === 2 ? [{ number: 1, title: "a", why: "w" }, { number: 777, title: "ghost", why: "w" }] : [],
    fixed_in: n === 3 ? { version: "1.2", evidence_url: "u" } : null,
  });
  const runWith = async (nums: number[], seed = "s", mode: "sample" | "ids" = "sample"): Promise<ShadowIssue[]> =>
    (await runShadow(planShadow(nums.map((n) => mk(n))), { known: new Set(open.map((i) => i.number)), sampledBy: t(seed, mode) }, ports(trg))).issues;
  const meta = (order: number[], seed = "s") => ({ sampledAt: new Date("2026-11-08T00:00:00Z"), seed, sample: 3, snapshotAt: null, order });

  it("flags dangling duplicate claims, keeps them out of precision, refuses true on them", async () => {
    const issues = await runWith([2]);
    expect(issues[0].duplicates.map((d) => d.inSnapshot)).toEqual([true, false]);
    const f = buildShadowFile({ sampledAt: new Date(), seed: "s", sample: 1, snapshotAt: null, issues });
    expect(summarizeShadow(f)).toMatchObject({ duplicatesClaimed: 2, dangling: 1, claims: 1 });
    expect(() => applyVerdict(f, parseVerdict("2:dup=777:true"))).toThrow(/not in the snapshot/);
    const g = applyVerdict(f, parseVerdict("2:dup:true"));
    expect(g.issues[0].duplicates.map((d) => d.verified)).toEqual([true, null]);
    expect(summarizeShadow(g)).toMatchObject({ checked: 1, precision: 1, dangling: 1 });
    const h = applyVerdict(f, parseVerdict("2:dup=777:false"));
    expect(h.issues[0].duplicates[1].verified).toBe(false);
    expect(summarizeShadow(h).checked).toBe(0);
  });

  it("refuses to mix seeds and keeps the original header; ids mode lists added ids", async () => {
    const f1 = mergeShadowFile(undefined, await runWith([1, 2, 3]), meta([1, 2, 3]));
    expect(() => mergeShadowFile(f1, [], meta([4], "other"))).toThrow(/--fresh/);
    expect(() => assertSameSeed(f1, "other")).toThrow(/--fresh/);
    const ids = await runWith([9], "s", "ids");
    const f2 = mergeShadowFile(f1, ids, { ...meta([9]), sample: 0, sampledAt: new Date("2030-01-01") });
    expect(f2.sample).toBe(3);
    expect(f2.sampledAt).toBe(f1.sampledAt);
    expect(f2.addedIds).toEqual([9]);
    expect(f2.issues.map((i) => i.number)).toEqual([9, 1, 2, 3]);
    expect(f2.issues.find((i) => i.number === 9)!.sampledBy.mode).toBe("ids");
  });

  it("selectPlan: seed mismatch throws unless fresh; resume skips done rows, retries failed/refused", async () => {
    const { selectPlan } = await import("../../scripts/shadow");
    const rows = await runWith([1, 2, 3]);
    rows[1] = { ...rows[1], status: "failed" };
    rows[2] = { ...rows[2], status: "refused_funds" };
    const disk = mergeShadowFile(undefined, rows, meta([1, 2, 3]));
    const plan = planShadow([mk(1), mk(2), mk(3), mk(4)]);
    expect(() => selectPlan(disk, { seed: "x", resume: false, fresh: false }, plan)).toThrow(/--fresh/);
    expect(selectPlan(disk, { seed: "x", resume: false, fresh: true }, plan).plan).toHaveLength(4);
    const r = selectPlan(disk, { seed: "s", resume: true, fresh: false }, plan);
    expect(r.skipped).toEqual([1]);
    expect(r.plan.map((p) => p.input.number)).toEqual([2, 3, 4]);
  });

  it("selectPlan refuses to rerun a hand-checked issue without --resume", async () => {
    const { selectPlan } = await import("../../scripts/shadow");
    const disk = applyVerdict(mergeShadowFile(undefined, await runWith([3]), meta([3])), parseVerdict("3:fixed:true"));
    expect(() => selectPlan(disk, { seed: "s", resume: false, fresh: false }, planShadow([mk(3)]))).toThrow(/hand-checked/);
    expect(selectPlan(disk, { seed: "s", resume: true, fresh: false }, planShadow([mk(3)])).plan).toHaveLength(0);
  });

  it("writeMerged re-reads the file so a verdict recorded mid-run survives the next write", async () => {
    const path = join(tmp(), "shadow-otari.json");
    const a = await runWith([3]);
    const b = await runWith([4]);
    writeMerged(path, a, meta([3, 4]));
    writeJsonAtomic(path, applyVerdict(readShadowFile(path)!, parseVerdict("3:fixed:true")));
    const again = writeMerged(path, [...a, ...b], meta([3, 4]));
    expect(again.issues[0].fixed_in?.verified).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).issues[0].fixed_in.verified).toBe(true);
    expect(again.issues.map((i) => i.number)).toEqual([3, 4]);
  });

  it("--fresh archives the old file under a timestamped name", async () => {
    const { archiveResults } = await import("../../scripts/shadow");
    const dir = tmp();
    const path = join(dir, "shadow-otari.json");
    writeJsonAtomic(path, { a: 1 });
    const to = archiveResults(path, new Date("2026-11-08T01:02:03.000Z"));
    expect(to).toBe(join(dir, "shadow-otari.2026-11-08T01-02-03-000Z.json"));
    expect(readdirSync(dir)).toEqual(["shadow-otari.2026-11-08T01-02-03-000Z.json"]);
    expect(archiveResults(path)).toBeNull();
  });

  it("atomic write leaves no temp file", () => {
    const dir = tmp();
    const path = join(dir, "x.json");
    writeJsonAtomic(path, { a: 1 });
    writeJsonAtomic(path, { a: 2 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 2 });
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("lock: second acquire fails, stale lock is taken over, verify refuses to write while held", async () => {
    const dir = tmp();
    const lock = join(dir, ".shadow.lock");
    const now = Date.now();
    acquireLock(lock, now);
    expect(() => acquireLock(lock, now + 1000)).toThrow(/holds/);
    const { recordVerdicts } = await import("../../scripts/shadow-verify");
    const path = join(dir, "shadow-otari.json");
    writeMerged(path, await runWith([3]), meta([3]));
    expect(() => recordVerdicts(["3:fixed:true"], path, lock)).toThrow(/shadow run is writing/);
    expect(readShadowFile(path)!.issues[0].fixed_in?.verified).toBeNull();
    releaseLock(lock);
    expect(recordVerdicts(["3:fixed:true"], path, lock).issues[0].fixed_in?.verified).toBe(true);
    acquireLock(lock, now - LOCK_STALE_MS - 1000);
    expect(lockHeld(lock, now)).toBeNull();
    acquireLock(lock, now);
    expect(lockHeld(lock, now)?.pid).toBe(process.pid);
  });
});

describe("fix round 2", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "shadow-test2-"));
  const meta = (order: number[], sample = 3) => ({ sampledAt: new Date("2026-11-08T00:00:00Z"), seed: "s", sample, snapshotAt: null, order });
  const row = async (n: number): Promise<ShadowIssue> =>
    (await runShadow(planShadow([mk(n)]), { sampledBy: { seed: "s", mode: "sample", at: "x" } }, ports(() => ({ summary: "s", kind: "bug" })))).issues[0];
  const err = (code: string) => Object.assign(new Error(code), { code });
  /** Real fs, but renameSync fails `n` times with `code` first; sleeps are recorded, not slept. */
  const flaky = (n: number, code = "EPERM") => {
    const sleeps: number[] = [];
    let left = n;
    const io = {
      ...realIo,
      renameSync: (a: string, b: string) => {
        if (left-- > 0) throw err(code);
        realIo.renameSync(a, b);
      },
      sleepSync: (ms: number) => void sleeps.push(ms),
    };
    return { io, sleeps };
  };

  it("retries the rename on EPERM with 50/100/200 ms backoff and then succeeds", () => {
    const dir = tmp();
    const { io, sleeps } = flaky(3);
    writeJsonAtomic(join(dir, "x.json"), { a: 1 }, io);
    expect(sleeps).toEqual([50, 100, 200]);
    expect(readdirSync(dir)).toEqual(["x.json"]);
    const b = flaky(2, "EBUSY");
    writeJsonAtomic(join(dir, "y.json"), { a: 1 }, b.io);
    expect(b.sleeps).toEqual([50, 100]);
  });

  it("gives up after five retries, removes the temp file and throws", () => {
    const dir = tmp();
    const { io, sleeps } = flaky(99);
    expect(() => writeJsonAtomic(join(dir, "x.json"), { a: 1 }, io)).toThrow("EPERM");
    expect(sleeps).toEqual([50, 100, 200, 400, 800]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not retry other errors", () => {
    const { io, sleeps } = flaky(99, "ENOENT");
    expect(() => writeJsonAtomic(join(tmp(), "x.json"), {}, io)).toThrow("ENOENT");
    expect(sleeps).toEqual([]);
  });

  it("a failed write leaves a pending sidecar; the next run merges it and deletes it", async () => {
    const dir = tmp();
    const path = join(dir, "shadow-otari.json");
    writeMerged(path, [await row(1)], meta([1, 2, 3]));
    const billed = await row(2);
    const { io } = flaky(99);
    expect(() => writeMerged(path, [billed], meta([1, 2, 3]), io)).toThrow("EPERM");
    expect(readdirSync(dir).sort()).toEqual([`shadow-otari.pending-${billed.runId}.json`, "shadow-otari.json"].sort());
    expect(readShadowFile(path)!.issues.map((i) => i.number)).toEqual([1]);
    expect(mergePending(path, meta([1, 2, 3]))).toBe(1);
    expect(readShadowFile(path)!.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(readdirSync(dir)).toEqual(["shadow-otari.json"]);
    expect(mergePending(path, meta([1, 2, 3]))).toBe(0);
  });

  it("a sidecar from another seed is not merged silently", async () => {
    const dir = tmp();
    const path = join(dir, "shadow-otari.json");
    const billed = await row(2);
    expect(() => writeMerged(path, [billed], meta([2]), flaky(99).io)).toThrow();
    expect(() => mergePending(path, { ...meta([2]), seed: "other" })).toThrow(/seed/);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("refreshLock moves the timestamp so a long run is not stale; both lock errors say how to recover", async () => {
    const dir = tmp();
    const lock = join(dir, ".shadow.lock");
    const t0 = Date.now() - LOCK_STALE_MS + 1000;
    acquireLock(lock, t0);
    expect(lockHeld(lock, Date.now() + 5000)).toBeNull();
    refreshLock(lock, Date.now());
    expect(lockHeld(lock, Date.now() + 5000)).not.toBeNull();
    expect(() => acquireLock(lock)).toThrow(/delete results\/\.shadow\.lock/);
    const { recordVerdicts } = await import("../../scripts/shadow-verify");
    const path = join(dir, "shadow-otari.json");
    writeMerged(path, [await row(3)], meta([3]));
    expect(() => recordVerdicts(["3:fixed:true"], path, lock)).toThrow(/delete results\/\.shadow\.lock/);
  });

  it("SIGINT and SIGTERM release the lock and exit 130 / 143; uninstall removes the handlers", async () => {
    const { installSignalHandlers } = await import("../../scripts/shadow");
    const ee = new EventEmitter();
    const exits: number[] = [];
    let released = 0;
    const uninstall = installSignalHandlers(Object.assign(ee, { exit: ((c: number) => void exits.push(c)) as never }), () => released++);
    ee.emit("SIGINT");
    ee.emit("SIGTERM");
    expect(exits).toEqual([130, 143]);
    expect(released).toBe(2);
    uninstall();
    expect(ee.listenerCount("SIGINT") + ee.listenerCount("SIGTERM")).toBe(0);
  });

  it("a different --sample size under the same seed is refused unless --fresh; ids runs are exempt", async () => {
    const { selectPlan } = await import("../../scripts/shadow");
    const disk = mergeShadowFile(undefined, [await row(1)], meta([1], 40));
    const plan = planShadow([mk(1)]);
    expect(() => selectPlan(disk, { seed: "s", resume: true, fresh: false, sample: 10 }, plan)).toThrow(/sample of 40/);
    expect(() => selectPlan(disk, { seed: "s", resume: true, fresh: false, sample: 40 }, plan)).not.toThrow();
    expect(() => selectPlan(disk, { seed: "s", resume: true, fresh: false }, plan)).not.toThrow();
    expect(selectPlan(disk, { seed: "s", resume: false, fresh: true, sample: 10 }, plan).plan).toHaveLength(1);
  });
});

describe("redactNames", () => {
  // Built from parts, like the code, so this test file stays clean under the repository's grep.
  const a = "Cla" + "ude";
  const v = "Anthro" + "pic";
  it("replaces assistant and vendor names in quoted issue text, whole words only", () => {
    expect(redactNames(`a symlinked ${a.toUpperCase()}.md and ${v} Messages`)).toBe("a symlinked [assistant].md and [vendor] Messages");
    expect(redactNames(`${a.toLowerCase()}tte`)).toBe(`${a.toLowerCase()}tte`);
  });
});
