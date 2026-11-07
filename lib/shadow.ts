import { createHash } from "node:crypto";

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

export type DuplicateClaim = { number: number; title: string; why: string; verified: boolean | null };
export type FixedClaim = { version: string; evidence_url: string; verified: boolean | null };

export type ShadowIssue = {
  number: number;
  title: string;
  url: string;
  runId: string;
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
  sample: number;
  snapshotAt: string | null;
  issues: ShadowIssue[];
  totals: ShadowTotals;
};

export const issueUrl = (n: number) => `https://github.com/${SHADOW_REPO}/issues/${n}`;

/** The triage JSON stored on a run, read defensively (held and failed runs have none). */
export function shadowIssueFrom(
  base: { number: number; title: string; runId: string; status: string; costUsd: number; latencyMs: number },
  triage: unknown,
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
      .map((d) => ({ number: d.number as number, title: String(d.title ?? ""), why: String(d.why ?? ""), verified: null })),
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
    snapshotAt: o.snapshotAt ? new Date(o.snapshotAt).toISOString() : null,
    issues: o.issues,
    totals: totalsOf(o.issues),
  };
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
    const hits = issue.duplicates.filter((d) => v.target === undefined || d.number === v.target);
    if (hits.length === 0) throw new Error(`issue #${v.issue} has no duplicate claim${v.target ? ` for #${v.target}` : ""}`);
    next = { ...issue, duplicates: issue.duplicates.map((d) => (hits.includes(d) ? { ...d, verified: v.value } : d)) };
  }
  return { ...file, issues: file.issues.map((x, i) => (i === idx ? next : x)) };
}

export type ShadowSummary = ShadowTotals & {
  issues: number;
  claims: number;
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
    ...i.duplicates.map((d) => d.verified),
    ...(i.fixed_in ? [i.fixed_in.verified] : []),
  ]);
  const checkedList = verdicts.filter((v): v is boolean => v === true || v === false);
  const correct = checkedList.filter(Boolean).length;
  return {
    ...t,
    issues: file.issues.length,
    claims: verdicts.length,
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
