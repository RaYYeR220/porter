/**
 * Eval runner.
 *   pnpm eval --arm porter|baseline --set attacks|benign [--ids a,b] [--dry-run] [--max-usd N] [--concurrency 1]
 *
 * Runs the pre-registered corpus (eval/PREREGISTRATION.md) through the production pipeline, scores each
 * run from its stored rows, writes results/eval-<arm>-<set>.json and eval_results rows. Nothing is posted
 * to GitHub. --max-usd caps generation spend on the desk and baseline workspaces; guard-model calls bill to
 * the separate guard workspace and are not counted (about $0.15 for the full eval, estimated). --dry-run prints the plan and a cost estimate and makes no Otari call.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadAttacks, loadBenign } from "./corpus";
import { buildEvalFile, dryRun, filterIds, formatDryRun, mergeRows, planAttacks, planBenign, runCases } from "./harness";
import type { Arm, EvalFile, EvalRow, EvalSet } from "./harness";
import { realPorts } from "./wiring";

const RESULTS_DIR = join(__dirname, "..", "results");

export function parseCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      arm: { type: "string" },
      set: { type: "string" },
      ids: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "max-usd": { type: "string" },
      concurrency: { type: "string", default: "1" },
    },
  });
  if (values.arm !== "porter" && values.arm !== "baseline") throw new Error("--arm must be porter or baseline");
  if (values.set !== "attacks" && values.set !== "benign") throw new Error("--set must be attacks or benign");
  if (values.concurrency !== "1") throw new Error("only --concurrency 1 is supported: cases run one after another");
  const maxUsd = values["max-usd"] === undefined ? undefined : Number(values["max-usd"]);
  if (maxUsd !== undefined && !(maxUsd > 0)) throw new Error("--max-usd must be a positive number");
  return {
    arm: values.arm as Arm,
    set: values.set as EvalSet,
    ids: values.ids ? values.ids.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    dryRun: values["dry-run"] === true,
    maxUsd,
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const all = cli.set === "attacks" ? planAttacks(cli.arm, loadAttacks()) : planBenign(cli.arm, loadBenign());
  const plan = filterIds(all, cli.ids);

  if (cli.dryRun) {
    const d = dryRun(cli.arm, plan);
    console.log(formatDryRun(cli.arm, cli.set, d));
    for (const c of d.cases) console.log(`  ${c.id.padEnd(12)} expected $${c.estimate.expectedUsd.toFixed(4)}  ceiling $${c.estimate.ceilingUsd.toFixed(4)}`);
    return;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `eval-${cli.arm}-${cli.set}.json`);
  const previous: EvalRow[] = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as EvalFile).cases : [];
  const order = all.map((p) => p.id);
  const real = realPorts(cli.arm, { endUserBudget: "regular" });
  const fresh: EvalRow[] = [];
  const write = (stopped: EvalFile["stopped"]) =>
    writeFileSync(file, `${JSON.stringify(buildEvalFile(cli.arm, cli.set, mergeRows(previous, fresh, order), stopped), null, 2)}\n`);

  const ports = {
    ...real,
    async save(row: EvalRow) {
      await real.save(row);
      fresh.push(row);
      write(null);
    },
  };
  const out = await runCases(plan, { arm: cli.arm, set: cli.set, maxUsd: cli.maxUsd }, ports, (l) => console.log(l));
  write(out.stopped);
  console.log(`wrote ${file} (spent $${out.spentUsd.toFixed(4)}${out.stopped ? `; stopped: ${out.stopped.reason}` : ""})`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("eval/run.ts")) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "eval failed");
    process.exit(1);
  });
}
