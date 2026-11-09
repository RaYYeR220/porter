import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AttackGoal, TECHNIQUES, loadAttacks, loadBenign } from "../../eval/corpus";
import benignMeta from "../../eval/corpus/benign.meta.json";
import type { Arm, EvalFile, EvalSet } from "../../eval/harness";
import type { SpamResult } from "../../eval/spam-core";
import { summarizeShadow } from "../shadow-summary";
import type { ShadowFile, ShadowSummary } from "../shadow-summary";
import { ARMS, countRows } from "./evidence";
import type { EvalResults, Loaded, PerArm } from "./evidence";
import { evalFileName, POST_HOC, spamFileName } from "./post-hoc";
import type { PostHocData } from "./post-hoc";

/**
 * Server-only loaders for the evidence pages. They read the committed files in results/ when the page is
 * rendered, check them against the shapes the eval and shadow scripts write, and never throw: a missing file
 * is "not run", a file that does not parse or does not add up is an error the page shows as such.
 */

/**
 * results/ under the working directory. PORTER_RESULTS_DIR points the pages at another folder (the test
 * fixtures) and is honoured only outside production builds, so a deployed page can only show committed results.
 */
export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PORTER_RESULTS_DIR?.trim();
  if (override && env.NODE_ENV !== "production") return override;
  return join(process.cwd(), "results");
}

const BlockedAt = z.enum(["gateway_guardrail", "output_check", "acl", "server_refused", "model_refused"]).nullable();

const EvalRowSchema = z.object({
  id: z.string().min(1),
  set: z.enum(["attacks", "benign"]),
  arm: z.enum(["porter", "baseline"]),
  technique: z.string().optional(),
  goal: AttackGoal.optional(),
  securityWorded: z.boolean().optional(),
  status: z.string(),
  hijacked: z.boolean(),
  falseBlock: z.boolean(),
  blocked_at: BlockedAt,
  inconclusive: z.boolean(),
  reason: z.string(),
  cost_usd: z.number().min(0),
  latency_ms: z.number().min(0),
  run_id: z.string(),
});

const EvalFileSchema = z.object({
  arm: z.enum(["porter", "baseline"]),
  set: z.enum(["attacks", "benign"]),
  repo: z.string(),
  updated_at: z.string(),
  preregistration: z.string(),
  totals: z.object({
    cases: z.number().int().min(0),
    conclusive: z.number().int().min(0),
    hijacked: z.number().int().min(0),
    falseBlocks: z.number().int().min(0),
    inconclusive: z.number().int().min(0),
    blocked_at: z.record(z.string(), z.number()),
    cost_usd: z.number().min(0),
  }),
  stopped: z.object({ reason: z.string(), remaining: z.array(z.string()) }).nullable(),
  cases: z.array(EvalRowSchema),
});

const SpamSchema = z.object({
  arm: z.enum(["porter", "baseline"]),
  n: z.number().int().min(0),
  repo: z.string().optional(),
  updated_at: z.string().optional(),
  spammer: z.string().optional(),
  legit_author: z.string().optional(),
  issues: z.array(
    z.object({
      index: z.number().int().min(1),
      status: z.string(),
      cost_usd: z.number().min(0),
      cumulative_usd: z.number().min(0),
      run_id: z.string(),
    }),
  ),
  total_cost_usd: z.number().min(0),
  first_refusal_index: z.number().int().min(1).nullable(),
  legit: z.object({ status: z.string(), served: z.boolean(), cost_usd: z.number().min(0), run_id: z.string() }).nullable(),
  stopped: z.string().nullable(),
  modeled: z.object({ modeled: z.literal(true), n: z.number().int().min(1), cost_usd: z.number().min(0), formula: z.string() }).nullable(),
});

const ShadowSchema = z.object({
  sampledAt: z.string(),
  seed: z.string(),
  sample: z.number().int().min(0),
  addedIds: z.array(z.number().int()),
  snapshotAt: z.string().nullable(),
  issues: z.array(
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      runId: z.string(),
      sampledBy: z.object({ seed: z.string(), mode: z.enum(["sample", "ids"]), at: z.string() }),
      status: z.string(),
      kind: z.string().nullable(),
      summary: z.string().nullable(),
      duplicates: z.array(
        z.object({ number: z.number().int(), title: z.string(), why: z.string(), inSnapshot: z.boolean(), verified: z.boolean().nullable() }),
      ),
      fixed_in: z.object({ version: z.string(), evidence_url: z.string(), verified: z.boolean().nullable() }).nullable(),
      missing_info: z.array(z.string()),
      labels: z.array(z.string()),
      costUsd: z.number().min(0),
      latencyMs: z.number().min(0),
    }),
  ),
  totals: z.object({
    answered: z.number().int().min(0),
    held: z.number().int().min(0),
    refused: z.number().int().min(0),
    failed: z.number().int().min(0),
    costUsd: z.number().min(0),
    duplicatesClaimed: z.number().int().min(0),
    fixedInClaimed: z.number().int().min(0),
  }),
});

const firstIssue = (e: z.ZodError) => {
  const i = e.issues[0];
  return i ? `${i.path.length > 0 ? i.path.join(".") : "file"}: ${i.message}` : "does not match the expected shape";
};

/** Reads and checks one JSON file. `check` returns a reason when the parsed file does not add up. */
function load<T>(path: string, name: string, schema: z.ZodType<T>, check: (v: T) => string | null = () => null): Loaded<T> {
  if (!existsSync(path)) return { state: "missing", file: name };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { state: "error", file: name, message: e instanceof SyntaxError ? "not valid JSON" : "could not be read" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { state: "error", file: name, message: firstIssue(parsed.error) };
  const bad = check(parsed.data);
  return bad ? { state: "error", file: name, message: bad } : { state: "ok", file: name, data: parsed.data };
}

export function loadEvalFile(arm: Arm, set: EvalSet, dir = resultsDir()): Loaded<EvalFile> {
  return loadTaggedEvalFile(arm, set, null, dir);
}

/** A post-hoc run's file, eval-<arm>-<set>-<tag>.json: the same shape and the same checks as the pre-registered one. */
export function loadTaggedEvalFile(arm: Arm, set: EvalSet, tag: string | null, dir = resultsDir()): Loaded<EvalFile> {
  const name = evalFileName(arm, set, tag);
  return load<EvalFile>(join(dir, name), name, EvalFileSchema, (f) => {
    if (f.arm !== arm || f.set !== set) return `holds arm "${f.arm}", set "${f.set}"`;
    if (f.cases.some((c) => c.arm !== arm || c.set !== set)) return "a case belongs to another arm or set";
    const c = countRows(f.cases);
    const t = f.totals;
    if (t.cases !== c.cases || t.hijacked !== c.hijacked || t.falseBlocks !== c.falseBlocks || t.inconclusive !== c.inconclusive) {
      return "totals do not match the cases";
    }
    return null;
  });
}

export function loadSpamFile(arm: Arm, dir = resultsDir()): Loaded<SpamResult> {
  return loadTaggedSpamFile(arm, null, dir);
}

/** A post-hoc spam wave, spam-<arm>-<tag>.json, checked like the pre-registered one. */
export function loadTaggedSpamFile(arm: Arm, tag: string | null, dir = resultsDir()): Loaded<SpamResult> {
  const name = spamFileName(arm, tag);
  return load<SpamResult>(join(dir, name), name, SpamSchema as z.ZodType<SpamResult>, (s) => {
    if (s.arm !== arm) return `holds arm "${s.arm}"`;
    if (s.issues.length > s.n) return "more issues than the wave filed";
    return null;
  });
}

export function loadEvalResults(dir = resultsDir()): EvalResults {
  const per = <T>(f: (arm: Arm) => Loaded<T>): PerArm<T> => Object.fromEntries(ARMS.map((a) => [a, f(a)])) as PerArm<T>;
  return {
    attacks: per((a) => loadEvalFile(a, "attacks", dir)),
    benign: per((a) => loadEvalFile(a, "benign", dir)),
    spam: per((a) => loadSpamFile(a, dir)),
  };
}

/** Every post-hoc experiment with its runs' files; a file with fewer cases than the corpus counts as still running. */
export function loadPostHoc(dir = resultsDir()): PostHocData[] {
  const expected = { attacks: loadAttacks().length, benign: loadBenign().length };
  return POST_HOC.map(
    (def): PostHocData =>
      def.kind === "eval"
        ? { def, expected: expected[def.set], runs: def.runs.map((r) => ({ ...r, loaded: loadTaggedEvalFile(r.arm, def.set, r.tag, dir) })) }
        : { def, runs: def.runs.map((r) => ({ ...r, loaded: loadTaggedSpamFile(r.arm, r.tag, dir) })) },
  );
}

export type ShadowReport = { file: ShadowFile; summary: ShadowSummary };

export function loadShadowReport(dir = resultsDir()): Loaded<ShadowReport> {
  const name = "shadow-otari.json";
  const f = load<ShadowFile>(join(dir, name), name, ShadowSchema as z.ZodType<ShadowFile>, (s) => {
    const numbers = new Set(s.issues.map((i) => i.number));
    return numbers.size !== s.issues.length ? "an issue is listed twice" : null;
  });
  if (f.state !== "ok") return f;
  return { state: "ok", file: name, data: { file: f.data, summary: summarizeShadow(f.data) } };
}

/* ---------- the corpus, as committed: what the method section counts ---------- */

export type CorpusSummary = {
  attacks: number;
  techniques: Array<{ technique: (typeof TECHNIQUES)[number]; ids: string[] }>;
  goals: { write_tool: Record<string, number>; reply_link: number; reply_canary: number; leak_prompt: number };
  benign: { total: number; general: Record<string, number>; generalTotal: number; security: number };
  meta: typeof benignMeta;
};

export function corpusSummary(): CorpusSummary {
  const attacks = loadAttacks();
  const benign = loadBenign();
  const goals: CorpusSummary["goals"] = { write_tool: {}, reply_link: 0, reply_canary: 0, leak_prompt: 0 };
  for (const a of attacks) {
    if (a.goal.kind === "write_tool") goals.write_tool[a.goal.tool] = (goals.write_tool[a.goal.tool] ?? 0) + 1;
    else goals[a.goal.kind]++;
  }
  const general: Record<string, number> = {};
  for (const b of benign.filter((x) => !x.securityWorded)) {
    const k = b.kind ?? "other";
    general[k] = (general[k] ?? 0) + 1;
  }
  return {
    attacks: attacks.length,
    techniques: TECHNIQUES.map((t) => ({ technique: t, ids: attacks.filter((a) => a.technique === t).map((a) => a.id) })),
    goals,
    benign: {
      total: benign.length,
      general,
      generalTotal: benign.filter((x) => !x.securityWorded).length,
      security: benign.filter((x) => x.securityWorded).length,
    },
    meta: benignMeta,
  };
}
