/**
 * Shadow run over the real open issues of mozilla-ai/otari.
 *   pnpm shadow [--dry-run] [--max-usd N] [--sample 40] [--seed porter-shadow-v1] [--ids 1,2] [--resume] [--fresh]
 *
 * Sample: the newest half of the open issues plus a seeded-random half of the rest, never an issue the
 * eval corpus uses (eval/corpus/benign.json). Every issue runs through the production pipeline as source
 * "shadow", arm porter, end user shadow:<login>, sequentially. Read-only: the repo is a shadow repo, so the
 * write tools refuse, and nothing is posted to GitHub. Writes results/shadow-otari.json (verified: null on every
 * claim until scripts/shadow-verify.ts records a human verdict).
 *
 * The file is written atomically after every issue, re-reading it first so verdicts recorded meanwhile survive;
 * results/.shadow.lock keeps shadow:verify from writing during a run. A file sampled with another seed is never
 * mixed with a new run: pass --fresh to archive it to results/shadow-otari.<timestamp>.json and start over.
 * --resume skips issues that already have a row under this seed unless that row is failed or was refused
 * funds/budget (nothing was served), so a restart never bills an issue twice. --ids adds listed open issues to the
 * file (reported as addedIds; the sample size is not changed).
 *
 * --max-usd caps generation spend (desk workspace); guard-model calls bill to the guard workspace and are not counted.
 * --dry-run prints the sample and a cost estimate, makes no Otari call, writes nothing.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { dryRun, formatDryRun } from "../eval/harness";
import type { Planned } from "../eval/harness";
import { loadBenign } from "../eval/corpus";
import { armClient, runIssue } from "../lib/agent/pipeline";
import { db } from "../lib/db/client";
import { runs } from "../lib/db/schema";
import { getRegularBudgetId } from "../lib/env";
import {
  acquireLock,
  assertNoVerdictLoss,
  assertSameSeed,
  mergePending,
  refreshLock,
  DEFAULT_SAMPLE,
  DEFAULT_SEED,
  readShadowFile,
  releaseLock,
  RESULTS_DIR,
  RESULTS_FILE,
  RETRYABLE,
  sampleIssues,
  writeMerged,
} from "../lib/shadow";
import type { ShadowFile, SnapshotIssue } from "../lib/shadow";
import { isOpen, loadSnapshot } from "./shadow-db";
import { planShadow, runShadow } from "./shadow-core";
import type { ShadowPorts } from "./shadow-core";

export function parseCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      "max-usd": { type: "string" },
      sample: { type: "string", default: String(DEFAULT_SAMPLE) },
      seed: { type: "string", default: DEFAULT_SEED },
      ids: { type: "string" },
      resume: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
    },
  });
  const maxUsd = values["max-usd"] === undefined ? undefined : Number(values["max-usd"]);
  if (maxUsd !== undefined && !(maxUsd > 0)) throw new Error("--max-usd must be a positive number");
  const sample = Number(values.sample);
  if (!Number.isInteger(sample) || sample < 1) throw new Error("--sample must be a positive integer");
  const ids = values.ids ? values.ids.split(",").map((s) => Number(s.trim())) : undefined;
  if (ids && (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n < 1))) throw new Error("--ids must be a comma-separated list of issue numbers");
  if (values.resume && values.fresh) throw new Error("--resume and --fresh contradict each other");
  return {
    dryRun: values["dry-run"] === true,
    maxUsd,
    sample,
    seed: values.seed as string,
    ids,
    resume: values.resume === true,
    fresh: values.fresh === true,
  };
}

/** The ordered sample: --ids picks exactly those open issues, otherwise newest half + seeded random half. */
export function chooseSample(open: SnapshotIssue[], cli: { sample: number; seed: string; ids?: number[] }, exclude: number[]) {
  if (cli.ids) {
    const byNumber = new Map(open.map((i) => [i.number, i]));
    const missing = cli.ids.filter((n) => !byNumber.has(n));
    if (missing.length > 0) throw new Error(`not open issues in the snapshot: ${missing.join(", ")}`);
    return { newest: cli.ids.map((n) => byNumber.get(n)!), random: [] as SnapshotIssue[] };
  }
  return sampleIssues(open, { size: cli.sample, seed: cli.seed, exclude });
}

/**
 * Every pre-spend check, and the plan left to run. Throws on a seed mismatch (unless --fresh) and on a rerun that
 * would replace hand-checked claims. With --resume, drops issues that already have a non-retryable row.
 */
export function selectPlan(disk: ShadowFile | undefined, cli: { seed: string; resume: boolean; fresh: boolean; /** size of the seeded sample; omitted for --ids runs */ sample?: number }, plan: Planned[]): { plan: Planned[]; skipped: number[] } {
  if (cli.fresh) return { plan, skipped: [] };
  assertSameSeed(disk, cli.seed, cli.sample);
  const done = new Set((disk?.issues ?? []).filter((i) => cli.resume && !RETRYABLE.has(i.status)).map((i) => i.number));
  const todo = plan.filter((p) => !done.has(p.input.number as number));
  assertNoVerdictLoss(disk, todo.map((p) => p.input.number as number));
  return { plan: todo, skipped: plan.filter((p) => done.has(p.input.number as number)).map((p) => p.input.number as number) };
}

/** Moves the existing results file aside; returns the archive path. */
export function archiveResults(file: string = RESULTS_FILE, now: Date = new Date()): string | null {
  if (!existsSync(file)) return null;
  const to = join(dirname(file), `shadow-otari.${now.toISOString().replace(/[:.]/g, "-")}.json`);
  renameSync(file, to);
  return to;
}

function realPorts(): ShadowPorts {
  const { otari, mcpServerId } = armClient("porter");
  const endUserBudget = getRegularBudgetId();
  return {
    runIssue: (input) => runIssue(input, { otari, mcpServerId, endUserBudget }),
    async load(runId) {
      const [run] = await db().select().from(runs).where(eq(runs.id, runId)).limit(1);
      if (!run) throw new Error(`run ${runId} not found`);
      return { status: run.status, triage: run.triage, costUsd: run.totalCostUsd };
    },
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const snap = await loadSnapshot();
  const open = snap.issues.filter((i) => isOpen(i.state));
  const known = new Set(snap.issues.map((i) => i.number));
  const exclude = loadBenign().flatMap((c) => (c.number ? [c.number] : []));
  const picked = chooseSample(open, cli, exclude);
  const sample = [...picked.newest, ...picked.random];
  const fullPlan = planShadow(sample);

  if (cli.dryRun) {
    console.log(`[dry-run] ${open.length} open issues in the snapshot${snap.snapshotAt ? ` (taken ${snap.snapshotAt.toISOString()})` : ""}; ${exclude.length} eval issues excluded; seed ${cli.seed}`);
    const show = (label: string, list: SnapshotIssue[]) => {
      console.log(`${label} (${list.length})`);
      for (const i of list) console.log(`  #${String(i.number).padEnd(5)} ${i.title.slice(0, 90)}  [${i.author ?? "?"}]`);
    };
    if (cli.ids) show("chosen by --ids", picked.newest);
    else {
      show("newest open", picked.newest);
      show("random open", picked.random);
    }
    const sel = selectPlan(cli.fresh ? undefined : readShadowFile(), { ...cli, sample: cli.ids ? undefined : sample.length }, fullPlan);
    if (cli.resume) console.log(`--resume would skip ${sel.skipped.length} issue(s) already done: ${sel.skipped.join(", ") || "-"}`);
    console.log(formatDryRun("porter", "shadow", dryRun("porter", sel.plan)));
    return;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  // The lock comes first: sidecars from a failed write are merged before the checks, so --resume sees them.
  acquireLock();
  const uninstall = installSignalHandlers(process, releaseLock);
  try {
    const sampledBy = { seed: cli.seed, mode: cli.ids ? ("ids" as const) : ("sample" as const), at: new Date().toISOString() };
    const run = { sampledAt: new Date(), seed: cli.seed, sample: cli.ids ? 0 : sample.length, snapshotAt: snap.snapshotAt, order: sample.map((i) => i.number) };
    if (!cli.fresh) {
      const recovered = mergePending(RESULTS_FILE, run);
      if (recovered > 0) console.log(`recovered ${recovered} row(s) from pending sidecars`);
    }
    // Every check happens before the archive and any spend.
    const { plan, skipped } = selectPlan(readShadowFile(), { ...cli, sample: cli.ids ? undefined : sample.length }, fullPlan);
    if (cli.fresh) {
      const archived = archiveResults();
      if (archived) console.log(`archived the previous results to ${archived}`);
    }
    if (skipped.length > 0) console.log(`resume: skipping ${skipped.length} finished issue(s)`);
    const out = await runShadow(plan, { maxUsd: cli.maxUsd, known, sampledBy }, realPorts(), (l) => console.log(l), (fresh) => {
      writeMerged(RESULTS_FILE, fresh, run);
      refreshLock();
    });
    writeMerged(RESULTS_FILE, out.issues, run);
    console.log(`wrote ${RESULTS_FILE} (spent $${out.spentUsd.toFixed(4)}${out.stopped ? `; stopped: ${out.stopped.reason}, ${out.stopped.remaining.length} issues not run` : ""})`);
  } finally {
    uninstall();
    releaseLock();
  }
}

/** Ctrl-C and SIGTERM release the lock before exiting (130 / 143), so shadow:verify is not blocked afterwards. */
export function installSignalHandlers(
  proc: { on(sig: string, h: () => void): unknown; off(sig: string, h: () => void): unknown; exit(code: number): unknown },
  release: () => void,
): () => void {
  const handlers = ([["SIGINT", 130], ["SIGTERM", 143]] as const).map(([sig, code]) => {
    const h = () => {
      release();
      proc.exit(code);
    };
    proc.on(sig, h);
    return [sig, h] as const;
  });
  return () => handlers.forEach(([sig, h]) => proc.off(sig, h));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/shadow.ts")) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "shadow run failed");
    process.exit(1);
  });
}
