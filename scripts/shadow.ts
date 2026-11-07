/**
 * Shadow run over the real open issues of mozilla-ai/otari.
 *   pnpm shadow [--dry-run] [--max-usd N] [--sample 40] [--seed porter-shadow-v1] [--ids 1,2]
 *
 * Sample: the newest half of the open issues plus a seeded-random half of the rest, never an issue the
 * eval corpus uses (eval/corpus/benign.json). Every issue runs through the production pipeline as source
 * "shadow", arm porter, end user shadow:<login>, sequentially. Read-only: the repo is a shadow repo, so the
 * write tools refuse, and nothing is posted to GitHub. Writes results/shadow-otari.json (verified: null on every
 * claim until scripts/shadow-verify.ts records a human verdict).
 *
 * --max-usd caps generation spend (desk workspace); guard-model calls bill to the guard workspace and are not counted.
 * --dry-run prints the sample and a cost estimate, makes no Otari call, writes nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { dryRun, formatDryRun } from "../eval/harness";
import { loadBenign } from "../eval/corpus";
import { armClient, runIssue } from "../lib/agent/pipeline";
import { db } from "../lib/db/client";
import { runs } from "../lib/db/schema";
import { getRegularBudgetId } from "../lib/env";
import { buildShadowFile, DEFAULT_SAMPLE, DEFAULT_SEED, sampleIssues } from "../lib/shadow";
import type { ShadowFile, ShadowIssue, SnapshotIssue } from "../lib/shadow";
import { isOpen, loadSnapshot } from "./shadow-db";
import { planShadow, runShadow } from "./shadow-core";
import type { ShadowPorts } from "./shadow-core";

export const RESULTS_FILE = join(__dirname, "..", "results", "shadow-otari.json");

export function parseCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      "max-usd": { type: "string" },
      sample: { type: "string", default: String(DEFAULT_SAMPLE) },
      seed: { type: "string", default: DEFAULT_SEED },
      ids: { type: "string" },
    },
  });
  const maxUsd = values["max-usd"] === undefined ? undefined : Number(values["max-usd"]);
  if (maxUsd !== undefined && !(maxUsd > 0)) throw new Error("--max-usd must be a positive number");
  const sample = Number(values.sample);
  if (!Number.isInteger(sample) || sample < 1) throw new Error("--sample must be a positive integer");
  const ids = values.ids ? values.ids.split(",").map((s) => Number(s.trim())) : undefined;
  if (ids && (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n < 1))) throw new Error("--ids must be a comma-separated list of issue numbers");
  return { dryRun: values["dry-run"] === true, maxUsd, sample, seed: values.seed as string, ids };
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

/** Rows from a new invocation replace stored rows of the same issue; other stored rows stay. Reruns never drop a human verdict. */
export function mergeShadow(previous: ShadowIssue[], fresh: ShadowIssue[], order: number[]): ShadowIssue[] {
  const byNumber = new Map(previous.map((i) => [i.number, i]));
  for (const f of fresh) {
    const old = byNumber.get(f.number);
    const hadVerdict = old && (old.duplicates.some((d) => d.verified !== null) || (old.fixed_in && old.fixed_in.verified !== null));
    if (hadVerdict) throw new Error(`#${f.number} already has a hand-checked verdict; rerunning would discard it (move results/shadow-otari.json aside to start over)`);
    byNumber.set(f.number, f);
  }
  const rank = new Map(order.map((n, i) => [n, i]));
  return [...byNumber.values()].sort((a, b) => (rank.get(a.number) ?? 1e9) - (rank.get(b.number) ?? 1e9) || a.number - b.number);
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
  const exclude = loadBenign().flatMap((c) => (c.number ? [c.number] : []));
  const picked = chooseSample(open, cli, exclude);
  const sample = [...picked.newest, ...picked.random];
  const plan = planShadow(sample);

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
    const d = dryRun("porter", plan);
    console.log(formatDryRun("porter", "shadow", d));
    return;
  }

  mkdirSync(join(__dirname, "..", "results"), { recursive: true });
  const previous: ShadowFile | undefined = existsSync(RESULTS_FILE) ? (JSON.parse(readFileSync(RESULTS_FILE, "utf8")) as ShadowFile) : undefined;
  const order = sample.map((i) => i.number);
  const sampledAt = new Date();
  const write = (fresh: ShadowIssue[]) => {
    const merged = mergeShadow(previous?.issues ?? [], fresh, order);
    const file = buildShadowFile({ sampledAt, seed: cli.seed, sample: cli.ids ? merged.length : sample.length, snapshotAt: snap.snapshotAt, issues: merged });
    writeFileSync(RESULTS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  };
  // Fail before any spend if a rerun would discard a hand-checked verdict.
  mergeShadow(previous?.issues ?? [], plan.map((p) => ({ number: p.input.number as number }) as ShadowIssue), order);

  const out = await runShadow(plan, { maxUsd: cli.maxUsd }, realPorts(), (l) => console.log(l), write);
  write(out.issues);
  console.log(`wrote ${RESULTS_FILE} (spent $${out.spentUsd.toFixed(4)}${out.stopped ? `; stopped: ${out.stopped.reason}, ${out.stopped.remaining.length} issues not run` : ""})`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/shadow.ts")) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "shadow run failed");
    process.exit(1);
  });
}
