/**
 * Spam wave.
 *   pnpm eval:spam --arm porter|baseline [--n 20] [--dry-run] [--max-usd N]
 *
 * One author per arm (eval:<arm>:spammer) on the default newcomer budget files N short "+1" issues in a
 * row (--max-usd caps generation spend only; guard-model calls bill to the separate guard workspace), then a second author (eval:<arm>:legit) files one real question. Writes results/spam-<arm>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fmtUsd } from "./estimate";
import type { Arm } from "./harness";
import { dryRunSpam, runSpam } from "./spam-core";
import { realPorts } from "./wiring";

const RESULTS_DIR = join(__dirname, "..", "results");
/** Newcomer budget per author per day (USD): the cap Porter's arm is expected to hit. */
const NEWCOMER_CAP_USD = 0.05;

export function parseSpamCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      arm: { type: "string" },
      n: { type: "string", default: "20" },
      "dry-run": { type: "boolean", default: false },
      "max-usd": { type: "string" },
      tag: { type: "string" },
    },
  });
  if (values.arm !== "porter" && values.arm !== "baseline") throw new Error("--arm must be porter or baseline");
  const n = Number(values.n);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("--n must be an integer from 1 to 50");
  const maxUsd = values["max-usd"] === undefined ? undefined : Number(values["max-usd"]);
  if (maxUsd !== undefined && !(maxUsd > 0)) throw new Error("--max-usd must be a positive number");
  const tag = values.tag?.trim() || undefined;
  if (tag && !/^[a-z0-9-]{1,32}$/.test(tag)) throw new Error("--tag must be lowercase letters, digits or dashes");
  return { arm: values.arm as Arm, n, dryRun: values["dry-run"] === true, maxUsd, tag };
}

async function main() {
  const cli = parseSpamCli(process.argv.slice(2));
  if (cli.dryRun) {
    const d = dryRunSpam(cli.arm, cli.n);
    console.log(`[dry-run] spam arm=${cli.arm} n=${cli.n} + 1 legit issue (no Otari calls)`);
    console.log(`  expected ${fmtUsd(d.total.expectedUsd)}   ceiling ${fmtUsd(d.total.ceilingUsd)}   guard workspace ${fmtUsd(d.total.guardUsd)} (billed apart)`);
    if (cli.arm === "porter") {
      const capped = NEWCOMER_CAP_USD + d.perIssue.ceilingUsd + d.perIssue.ceilingUsd;
      console.log(
        `  porter spammer is capped by the newcomer budget ($${NEWCOMER_CAP_USD}/day): spam spend about ${fmtUsd(Math.min(d.total.ceilingUsd, capped))} at most, plus the legit issue`,
      );
    }
    return;
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  // Newcomer budget on purpose: no endUserBudget, so the gateway applies the default tier.
  // A tagged run uses fresh authors (end users keep their counters for the day) and its own file.
  const authorSuffix = cli.tag ? `:${cli.tag}` : "";
  const result = await runSpam(cli.arm, cli.n, realPorts(cli.arm, { endUserBudget: "default" }), { maxUsd: cli.maxUsd, authorSuffix }, (l) => console.log(l));
  const file = join(RESULTS_DIR, `spam-${cli.arm}${cli.tag ? `-${cli.tag}` : ""}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${file}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("eval/spam.ts")) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "spam failed");
    process.exit(1);
  });
}
