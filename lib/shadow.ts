import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Run from the repo root (pnpm scripts do). */
export const RESULTS_DIR = join(process.cwd(), "results");
export const RESULTS_FILE = join(RESULTS_DIR, "shadow-otari.json");
export const LOCK_FILE = join(RESULTS_DIR, ".shadow.lock");
export const LOCK_STALE_MS = 2 * 60 * 60_000;

/**
 * Pure helpers for the shadow run over a real tracker: sampling, the results file, human verdicts,
 * and the summary the report page reads. Nothing here touches the network or the database.
 */

export const SHADOW_REPO = "mozilla-ai/otari";
export const DEFAULT_SEED = "porter-shadow-v1";
export const DEFAULT_SAMPLE = 40;

/** `shadow:<lowercased login>`, the same lowercasing as the gh: ids (logins are case-insensitive). */
export const shadowEndUserId = (login: string | null | undefined): string =>
  `shadow:${(login ?? "").trim().toLowerCase() || "unknown"}`;

export type SnapshotIssue = {
  number: number;
  title: string;
  body: string | null;
  author: string | null;
  labels: string[];
  createdAt: Date | string | null;
};

const time = (i: SnapshotIssue) => (i.createdAt ? new Date(i.createdAt).getTime() : 0);

/** mulberry32 over a 32-bit seed taken from sha256(seed). */
function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SampleOptions = { size: number; seed: string; exclude: Iterable<number> };

/**
 * Half the sample is the newest open issues, the rest is seeded-random from the other open issues.
 * `exclude` (issues the eval already used) is removed from both halves first. Deterministic for a given
 * snapshot, seed and size; the random part is ordered by issue number.
 */
export function sampleIssues(open: SnapshotIssue[], o: SampleOptions): { newest: SnapshotIssue[]; random: SnapshotIssue[] } {
  const skip = new Set(o.exclude);
  const pool = open.filter((i) => !skip.has(i.number)).sort((a, b) => time(b) - time(a) || b.number - a.number);
  const nNewest = Math.min(Math.ceil(o.size / 2), pool.length);
  const newest = pool.slice(0, nNewest);
  const rest = pool.slice(nNewest).sort((a, b) => a.number - b.number);
  const next = rng(o.seed);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const random = rest.slice(0, Math.max(0, Math.min(o.size - nNewest, rest.length))).sort((a, b) => a.number - b.number);
  return { newest, random };
}

export type DuplicateClaim = {
  number: number;
  title: string;
  why: string;
  /** False when the claimed duplicate is not an issue in the snapshot: it cannot be checked and never counts toward precision. */
  inSnapshot: boolean;
  verified: boolean | null;
};
export type FixedClaim = { version: string; evidence_url: string; verified: boolean | null };

export type SampledBy = { seed: string; mode: "sample" | "ids"; at: string };

export type ShadowIssue = {
  number: number;
  title: string;
  url: string;
  runId: string;
  sampledBy: SampledBy;
  status: string;
  kind: string | null;
  summary: string | null;
  duplicates: DuplicateClaim[];
  fixed_in: FixedClaim | null;
  missing_info: string[];
  labels: string[];
  costUsd: number;
  latencyMs: number;
};

export type ShadowTotals = {
  answered: number;
  held: number;
  refused: number;
  failed: number;
  costUsd: number;
  duplicatesClaimed: number;
  fixedInClaimed: number;
};

export type ShadowFile = {
  sampledAt: string;
  seed: string;
  /** Size of the seeded sample; 0 for a file started by --ids. Issues added with --ids are listed in addedIds, not counted here. */
  sample: number;
  addedIds: number[];
  snapshotAt: string | null;
  issues: ShadowIssue[];
  totals: ShadowTotals;
};

export const issueUrl = (n: number) => `https://github.com/${SHADOW_REPO}/issues/${n}`;

/** The triage JSON stored on a run, read defensively (held and failed runs have none). */
export function shadowIssueFrom(
  base: { number: number; title: string; runId: string; sampledBy: SampledBy; status: string; costUsd: number; latencyMs: number },
  triage: unknown,
  known: (n: number) => boolean = () => true,
): ShadowIssue {
  const t = (triage && typeof triage === "object" ? triage : {}) as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const dups = Array.isArray(t.duplicates) ? (t.duplicates as Array<Record<string, unknown>>) : [];
  const fx = t.fixed_in && typeof t.fixed_in === "object" ? (t.fixed_in as Record<string, unknown>) : null;
  return {
    ...base,
    url: issueUrl(base.number),
    kind: typeof t.kind === "string" ? t.kind : null,
    summary: typeof t.summary === "string" ? t.summary : null,
    duplicates: dups
      .filter((d) => typeof d.number === "number" && d.number !== base.number)
      .map((d) => ({
        number: d.number as number,
        title: String(d.title ?? ""),
        why: String(d.why ?? ""),
        inSnapshot: known(d.number as number),
        verified: null,
      })),
    fixed_in: fx && typeof fx.version === "string" ? { version: fx.version, evidence_url: String(fx.evidence_url ?? ""), verified: null } : null,
    missing_info: strs(t.missing_info),
    labels: strs(t.labels),
  };
}

export function totalsOf(issues: ShadowIssue[]): ShadowTotals {
  const count = (...s: string[]) => issues.filter((i) => s.includes(i.status)).length;
  return {
    answered: count("answered"),
    held: count("held_guardrail"),
    refused: count("refused_budget", "refused_funds", "blocked_author"),
    failed: count("failed"),
    costUsd: issues.reduce((s, i) => s + i.costUsd, 0),
    duplicatesClaimed: issues.reduce((s, i) => s + i.duplicates.length, 0),
    fixedInClaimed: issues.filter((i) => i.fixed_in).length,
  };
}

export function buildShadowFile(o: {
  sampledAt: Date;
  seed: string;
  sample: number;
  snapshotAt: Date | string | null;
  issues: ShadowIssue[];
}): ShadowFile {
  return {
    sampledAt: o.sampledAt.toISOString(),
    seed: o.seed,
    sample: o.sample,
    addedIds: o.issues.filter((i) => i.sampledBy.mode === "ids").map((i) => i.number).sort((a, b) => a - b),
    snapshotAt: o.snapshotAt ? new Date(o.snapshotAt).toISOString() : null,
    issues: o.issues,
    totals: totalsOf(o.issues),
  };
}

const hasVerdict = (i: ShadowIssue) => i.duplicates.some((d) => d.verified !== null) || (i.fixed_in?.verified ?? null) !== null;

/** Same-seed check, before any spend. A different seed means a different sample: the caller must pass --fresh. */
export function assertSameSeed(disk: ShadowFile | undefined, seed: string): void {
  if (disk && disk.seed !== seed) {
    throw new Error(`results/shadow-otari.json was sampled with seed "${disk.seed}", not "${seed}"; rerun with the same seed or pass --fresh (archives the old file)`);
  }
}

/** Rows of `fresh` replace rows with the same number; verdicts already on disk for claims that still exist are kept. */
function carryVerdicts(old: ShadowIssue | undefined, row: ShadowIssue): ShadowIssue {
  if (!old) return row;
  return {
    ...row,
    duplicates: row.duplicates.map((d) => {
      const o = old.duplicates.find((x) => x.number === d.number);
      return o && o.verified !== null ? { ...d, verified: o.verified } : d;
    }),
    fixed_in:
      row.fixed_in && old.fixed_in && old.fixed_in.verified !== null && old.fixed_in.version === row.fixed_in.version
        ? { ...row.fixed_in, verified: old.fixed_in.verified }
        : row.fixed_in,
  };
}

/**
 * The file as it should be after a write: the on-disk file (re-read by the caller each time) plus `fresh` rows.
 * Never discards a verdict on disk. Throws on a seed mismatch. Header fields of an existing file are kept
 * (sampledAt, sample, snapshotAt); the first writer sets them.
 */
export function mergeShadowFile(
  disk: ShadowFile | undefined,
  fresh: ShadowIssue[],
  run: { sampledAt: Date; seed: string; sample: number; snapshotAt: Date | string | null; order: number[] },
): ShadowFile {
  assertSameSeed(disk, run.seed);
  const byNumber = new Map((disk?.issues ?? []).map((i) => [i.number, i]));
  for (const f of fresh) byNumber.set(f.number, carryVerdicts(byNumber.get(f.number), f));
  const rank = new Map(run.order.map((n, i) => [n, i]));
  const issues = [...byNumber.values()].sort((a, b) => (rank.get(a.number) ?? 1e9) - (rank.get(b.number) ?? 1e9) || a.number - b.number);
  const base = buildShadowFile({
    sampledAt: disk ? new Date(disk.sampledAt) : run.sampledAt,
    seed: run.seed,
    sample: disk ? disk.sample : run.sample,
    snapshotAt: disk ? disk.snapshotAt : run.snapshotAt,
    issues,
  });
  return base;
}

/** Refuses (before any spend) to rerun an issue whose claims a human has already judged. */
export function assertNoVerdictLoss(disk: ShadowFile | undefined, numbers: number[]): void {
  const hit = (disk?.issues ?? []).find((i) => numbers.includes(i.number) && hasVerdict(i));
  if (hit) throw new Error(`#${hit.number} already has a hand-checked verdict; rerunning would replace its claims (use --resume, or move results/shadow-otari.json aside)`);
}

/** Retryable statuses: nothing was served for them. Everything else is terminal and is not re-billed by --resume. */
export const RETRYABLE = new Set(["failed", "refused_funds", "refused_budget"]);

export function readShadowFile(path = RESULTS_FILE): ShadowFile | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ShadowFile) : undefined;
}

/** Temp file in the same directory, then rename: a reader or a crash never sees half a file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Re-reads the file, merges, writes atomically. Verdicts recorded by shadow:verify in between survive. */
export function writeMerged(
  path: string,
  fresh: ShadowIssue[],
  run: { sampledAt: Date; seed: string; sample: number; snapshotAt: Date | string | null; order: number[] },
): ShadowFile {
  const merged = mergeShadowFile(readShadowFile(path), fresh, run);
  writeJsonAtomic(path, merged);
  return merged;
}

type Lock = { pid: number; at: string };

/** Lock held by a live-looking run: present and younger than LOCK_STALE_MS. */
export function lockHeld(path = LOCK_FILE, now = Date.now()): Lock | null {
  if (!existsSync(path)) return null;
  try {
    const l = JSON.parse(readFileSync(path, "utf8")) as Lock;
    return now - new Date(l.at).getTime() < LOCK_STALE_MS ? l : null;
  } catch {
    return null;
  }
}

export function acquireLock(path = LOCK_FILE, now = Date.now()): void {
  const held = lockHeld(path, now);
  if (held) throw new Error(`another shadow run holds ${path} (pid ${held.pid}, since ${held.at}); stale after 2 h`);
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() } satisfies Lock), { flag: "wx" });
}

export function releaseLock(path = LOCK_FILE): void {
  rmSync(path, { force: true });
}

export type Verdict = {
  issue: number;
  claim: "dup" | "fixed";
  /** dup only: one duplicate; omitted means all of the issue's duplicates */
  target?: number;
  value: boolean;
};

/** `<issue>:<dup|fixed>:<true|false>`, or `<issue>:dup=<n>:<true|false>` for one duplicate of the issue. */
export function parseVerdict(arg: string): Verdict {
  const m = /^(\d+):(dup|fixed)(?:=(\d+))?:(true|false)$/.exec(arg.trim());
  if (!m || (m[2] === "fixed" && m[3])) {
    throw new Error(`bad verdict "${arg}": use <issue>:<dup|fixed>:<true|false> or <issue>:dup=<n>:<true|false>`);
  }
  return { issue: Number(m[1]), claim: m[2] as Verdict["claim"], ...(m[3] ? { target: Number(m[3]) } : {}), value: m[4] === "true" };
}

/** Returns a copy with the verdict recorded. Throws when the issue or the claim is not in the file. */
export function applyVerdict(file: ShadowFile, v: Verdict): ShadowFile {
  const idx = file.issues.findIndex((i) => i.number === v.issue);
  if (idx === -1) throw new Error(`issue #${v.issue} is not in the shadow file`);
  const issue = file.issues[idx];
  let next: ShadowIssue;
  if (v.claim === "fixed") {
    if (!issue.fixed_in) throw new Error(`issue #${v.issue} has no fixed_in claim`);
    next = { ...issue, fixed_in: { ...issue.fixed_in, verified: v.value } };
  } else {
    const named = issue.duplicates.filter((d) => v.target === undefined || d.number === v.target);
    if (named.length === 0) throw new Error(`issue #${v.issue} has no duplicate claim${v.target ? ` for #${v.target}` : ""}`);
    // A claim pointing outside the snapshot cannot be confirmed: "true" is refused, "false" is allowed.
    const hits = v.value ? named.filter((d) => d.inSnapshot) : named;
    if (v.value && v.target !== undefined && hits.length === 0) {
      throw new Error(`#${v.target} is not in the snapshot: the claim on #${v.issue} cannot be marked true (mark it false)`);
    }
    if (hits.length === 0) throw new Error(`every duplicate claim on #${v.issue} points outside the snapshot: cannot be marked true`);
    next = { ...issue, duplicates: issue.duplicates.map((d) => (hits.includes(d) ? { ...d, verified: v.value } : d)) };
  }
  return { ...file, issues: file.issues.map((x, i) => (i === idx ? next : x)) };
}

export type ShadowSummary = ShadowTotals & {
  issues: number;
  /** Claims that can be checked (duplicates inside the snapshot, plus fixed_in). */
  claims: number;
  /** Duplicate claims pointing at a number not in the snapshot; reported apart, never in precision. */
  dangling: number;
  checked: number;
  correct: number;
  /** correct / checked over claims a human checked; null until one is checked. Unverified claims never count. */
  precision: number | null;
  /** "k of n claims checked by hand" */
  checkedLabel: string;
};

export function summarizeShadow(file: ShadowFile): ShadowSummary {
  const t = totalsOf(file.issues);
  const verdicts: Array<boolean | null> = file.issues.flatMap((i) => [
    ...i.duplicates.filter((d) => d.inSnapshot !== false).map((d) => d.verified),
    ...(i.fixed_in ? [i.fixed_in.verified] : []),
  ]);
  const dangling = file.issues.reduce((s, i) => s + i.duplicates.filter((d) => d.inSnapshot === false).length, 0);
  const checkedList = verdicts.filter((v): v is boolean => v === true || v === false);
  const correct = checkedList.filter(Boolean).length;
  return {
    ...t,
    issues: file.issues.length,
    claims: verdicts.length,
    dangling,
    checked: checkedList.length,
    correct,
    precision: checkedList.length > 0 ? correct / checkedList.length : null,
    checkedLabel: `${checkedList.length} of ${verdicts.length} claims checked by hand`,
  };
}

const STOP = new Set(
  "about after again also because before being could does doing from have into just like more only other should some than that their them then there these they this those through when where which while with without would your error issue support using used not cannot".split(
    " ",
  ),
);

export type ReleaseRow = { tag: string; name: string | null; body: string | null };
export type ReleaseEvidence = {
  /** Lines (with their release tag) that cite the issue number. */
  mentions: Array<{ tag: string; line: string }>;
  /** The claimed release's lines that share a keyword with the issue title. */
  keywordHits: Array<{ tag: string; line: string; words: string[] }>;
  claimedReleaseFound: boolean;
};

const normTag = (t: string) => t.trim().replace(/^v/i, "").toLowerCase();

export function titleKeywords(title: string): string[] {
  const words = title.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

/** Release-note text that supports (or fails to support) a "fixed in vX" claim. Offline: reads the releases table only. */
export function releaseEvidence(releases: ReleaseRow[], issueNumber: number, title: string, version: string): ReleaseEvidence {
  const ref = new RegExp(`(^|[^\\d])#${issueNumber}(?!\\d)|/(issues|pull)/${issueNumber}(?!\\d)`);
  const lines = (r: ReleaseRow) => (r.body ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const mentions = releases.flatMap((r) => lines(r).filter((l) => ref.test(l)).map((line) => ({ tag: r.tag, line })));
  const claimed = releases.find((r) => normTag(r.tag) === normTag(version) || normTag(r.name ?? "") === normTag(version));
  const words = titleKeywords(title);
  const keywordHits = claimed
    ? lines(claimed).flatMap((line) => {
        const hit = words.filter((w) => line.toLowerCase().includes(w));
        return hit.length > 0 ? [{ tag: claimed.tag, line, words: hit }] : [];
      })
    : [];
  return { mentions, keywordHits, claimedReleaseFound: Boolean(claimed) };
}

export const firstLine = (body: string | null, max = 160): string => {
  const l = (body ?? "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "(empty)";
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};
