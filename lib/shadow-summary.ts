/**
 * The shadow results file's shape and the summary the report page reads. Pure: no file system, no network,
 * so the page can import it without pulling in the run's file and lock helpers (lib/shadow.ts re-exports all of it).
 */

export const SHADOW_REPO = "mozilla-ai/otari";

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
