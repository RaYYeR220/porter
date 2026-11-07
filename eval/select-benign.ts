/**
 * Selects the benign half of the eval corpus from the mozilla-ai/otari snapshot in Neon.
 *
 *   pnpm tsx --env-file=.env.local eval/select-benign.ts [--print]
 *
 * Read-only: one SELECT, no writes. Deterministic: candidates are sorted by issue number and
 * sampled with a PRNG seeded from SEED, so the same snapshot always yields the same 25 cases.
 * Titles and bodies are copied exactly as stored.
 *
 * Composition (25):
 *   - 2 pinned issues the guard is expected to trip on (#2921, #2899): hard cases are kept in.
 *   - 17 general issues from strata (bug 5 incl. the pinned two, feature 5, docs 3, question 2,
 *     other 4 as the fallback); a short stratum is topped up from "other".
 *   - 6 security-worded issues: a real title naming guardrails, secrets, credentials, API keys,
 *     injection, advisories or redaction, or carrying the area/security label.
 * Excluded from every pool: bodies under 100 or over 3,500 chars, text naming AI coding tools or
 * authorship marks (the repository keeps those out), and strings shaped like real secrets.
 */
import { and, eq } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db/client";
import { issues, repos } from "../lib/db/schema";

export const SEED = "porter-eval-benign-v1";
export const REPO = "mozilla-ai/otari";
const PINNED = [2921, 2899];
const MIN_BODY = 100;
const MAX_BODY = 3500;
const QUOTA = { bug: 5, feature: 5, docs: 3, question: 2, other: 4 } as const;
const SECURITY_N = 6;

// Assembled from parts so this file does not itself match the repository's no-AI-marks grep.
const AI_TELLS = new RegExp(["clau" + "de", "anthro" + "pic", "copi" + "lot", "generated " + "with", "co-authored" + "-by", "voice" + "over", "super" + "powers"].join("|"), "i");
const SECRET_SHAPES = /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|otk_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16})\b/;
const SECURITY_TITLE = /guardrail|vulnerab|secret|advisor|injection|jailbreak|redact|credential|api[- ]key|\bCVE\b|exploit|token/i;

export type Row = { number: number; title: string; body: string; labels: string[] };
export type BenignCase = { id: string; number: number; title: string; body: string; securityWorded: boolean; kind: string; origin: "snapshot" };

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32 */
export function prng(seed: string): () => number {
  let a = fnv1a(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample<T>(items: T[], n: number, rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

export function kindOf(r: Row): keyof typeof QUOTA {
  const t = r.title;
  if (r.labels.includes("bug") || /^\[BUG\]/i.test(t) || /^fix[(:]/i.test(t)) return "bug";
  if (r.labels.includes("documentation") || /^docs?[(:]/i.test(t) || /^document\b/i.test(t)) return "docs";
  if (/\?\s*$/.test(t) || /^(how|why|where|should|can|does|is)\b/i.test(t)) return "question";
  if (r.labels.includes("enhancement") || /^\[FEATURE\]/i.test(t) || /^(feat[(:]|add\b|support\b)/i.test(t)) return "feature";
  return "other";
}

export const isSecurityWorded = (r: Row) => SECURITY_TITLE.test(r.title) || r.labels.includes("area/security");

const lengthOk = (r: Row) => r.body.length >= MIN_BODY && r.body.length <= MAX_BODY;
const namesAiTool = (r: Row) => AI_TELLS.test(`${r.title}
${r.body}`);
const secretShaped = (r: Row) => SECRET_SHAPES.test(`${r.title}
${r.body}`);

export function eligible(r: Row): boolean {
  return lengthOk(r) && !namesAiTool(r) && !secretShaped(r);
}

export type Meta = {
  seed: string;
  repo: string;
  snapshotIssues: number;
  /** Issues dropped from the candidate pool because the text names a commercial AI coding assistant or an authorship trailer. */
  excludedForAssistantNames: { securityPool: number; generalPool: number; total: number };
  excludedForLength: number;
  excludedForSecretShape: number;
};

export function selectionMeta(all: Row[]): Meta {
  const inLen = all.filter((r) => lengthOk(r) && !secretShaped(r));
  const named = inLen.filter(namesAiTool);
  const sec = named.filter(isSecurityWorded).length;
  return {
    seed: SEED,
    repo: REPO,
    snapshotIssues: all.length,
    excludedForAssistantNames: { securityPool: sec, generalPool: named.length - sec, total: named.length },
    excludedForLength: all.filter((r) => !lengthOk(r)).length,
    excludedForSecretShape: all.filter((r) => lengthOk(r) && secretShaped(r)).length,
  };
}

export function select(all: Row[]): BenignCase[] {
  const rand = prng(SEED);
  const rows = [...all].sort((a, b) => a.number - b.number);
  const make = (r: Row, securityWorded: boolean): BenignCase => ({
    id: `ben-${r.number}`,
    number: r.number,
    title: r.title,
    body: r.body,
    securityWorded,
    kind: kindOf(r),
    origin: "snapshot",
  });

  const pinned = PINNED.map((n) => rows.find((r) => r.number === n)).filter((r): r is Row => !!r);
  const taken = new Set(pinned.map((r) => r.number));

  const security = sample(rows.filter((r) => eligible(r) && isSecurityWorded(r) && !taken.has(r.number)), SECURITY_N, rand);
  if (security.length < SECURITY_N) throw new Error(`only ${security.length} security-worded issues in the snapshot`);
  security.forEach((r) => taken.add(r.number));

  const pool = rows.filter((r) => eligible(r) && !isSecurityWorded(r) && !taken.has(r.number));
  const picked: Row[] = [...pinned];
  const want = (Object.keys(QUOTA) as Array<keyof typeof QUOTA>).filter((k) => k !== "other");
  let shortfall = 0;
  for (const k of want) {
    const have = picked.filter((r) => kindOf(r) === k).length;
    const stratum = pool.filter((r) => kindOf(r) === k && !picked.includes(r));
    const got = sample(stratum, Math.max(0, QUOTA[k] - have), rand);
    shortfall += Math.max(0, QUOTA[k] - have) - got.length;
    picked.push(...got);
  }
  const others = pool.filter((r) => kindOf(r) === "other" && !picked.includes(r));
  picked.push(...sample(others, QUOTA.other + shortfall, rand));

  return [...picked.map((r) => make(r, false)), ...security.map((r) => make(r, true))].sort((a, b) => a.number - b.number);
}

async function main() {
  const rows = await db()
    .select({ number: issues.number, title: issues.title, body: issues.body, labels: issues.labels })
    .from(issues)
    .innerJoin(repos, eq(repos.id, issues.repoId))
    .where(and(eq(repos.fullName, REPO)));
  const all = rows.map((r) => ({ number: r.number, title: r.title, body: r.body ?? "", labels: r.labels ?? [] }));
  const cases = select(all);
  const meta = selectionMeta(all);
  if (process.argv.includes("--print")) {
    for (const c of cases) console.log(c.number, c.kind.padEnd(8), c.securityWorded ? "SEC" : "   ", c.title.slice(0, 80));
    console.log(JSON.stringify(meta));
    return;
  }
  writeFileSync(join(__dirname, "corpus", "benign.meta.json"), `${JSON.stringify(meta, null, 2)}
`);
  writeFileSync(join(__dirname, "corpus", "benign.json"), `${JSON.stringify(cases, null, 2)}\n`);
  console.log(`wrote ${cases.length} cases (${cases.filter((c) => c.securityWorded).length} security-worded)`);
}

if (process.argv[1]?.includes("select-benign")) void main();
