/**
 * Renders the eval results into README.md, between <!-- results:start --> and <!-- results:end -->.
 *   pnpm eval:render
 *
 * Reads results/eval-<arm>-<set>.json and results/spam-<arm>.json. Only the text between the markers
 * changes; a missing results file renders "Not run yet." and no number is ever filled in by hand.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalFile } from "../eval/harness";
import type { SpamResult } from "../eval/spam-core";

export const START = "<!-- results:start -->";
export const END = "<!-- results:end -->";
const NOT_RUN = "Not run yet.";
const ARMS = ["porter", "baseline"] as const;
const label = (arm: string) => (arm === "porter" ? "Porter" : "Baseline");

export type Results = {
  attacks: Partial<Record<(typeof ARMS)[number], EvalFile>>;
  benign: Partial<Record<(typeof ARMS)[number], EvalFile>>;
  spam: Partial<Record<(typeof ARMS)[number], SpamResult>>;
};

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

export function loadResults(dir: string): Results {
  const r: Results = { attacks: {}, benign: {}, spam: {} };
  for (const arm of ARMS) {
    r.attacks[arm] = readJson<EvalFile>(join(dir, `eval-${arm}-attacks.json`));
    r.benign[arm] = readJson<EvalFile>(join(dir, `eval-${arm}-benign.json`));
    r.spam[arm] = readJson<SpamResult>(join(dir, `spam-${arm}.json`));
  }
  return r;
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const table = (head: string[], rows: string[][]) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");
const stoppedNote = (f: EvalFile) => (f.stopped ? ` (stopped: ${f.stopped.reason})` : "");

function attackSection(files: Results["attacks"]): string {
  const head = ["Arm", "Hijacked", "Gateway guardrail", "Output check", "ACL", "Server refused", "Model refused", "Not blocked", "Inconclusive", "Cost"];
  const rows = ARMS.map((arm) => {
    const f = files[arm];
    if (!f) return [label(arm), NOT_RUN, ...Array(8).fill("-")];
    const b = f.totals.blocked_at;
    // Hijacked cases that were contained (refused write) count under their block; "Not blocked" is the rest of the hijacks.
    return [
      label(arm),
      `${f.totals.hijacked}/${f.totals.cases}${stoppedNote(f)}`,
      String(b.gateway_guardrail ?? 0),
      String(b.output_check ?? 0),
      String(b.acl ?? 0),
      String(b.server_refused ?? 0),
      String(b.model_refused ?? 0),
      String(f.cases.filter((c) => c.hijacked && c.blocked_at === null).length),
      String(f.totals.inconclusive),
      usd(f.totals.cost_usd),
    ];
  });
  const src = ARMS.map((a) => `\`results/eval-${a}-attacks.json\``).join(", ");
  return [
    "#### Attacks (hijacked = the attacker's goal was met or a write was attempted)",
    "",
    table(head, rows),
    "",
    `Source: ${src}. Cost is generation only; guard-model calls bill to a separate workspace.`,
  ].join("\n");
}

function benignSection(files: Results["benign"]): string {
  const head = ["Arm", "False blocks", "At gateway guardrail", "At output check", "Inconclusive", "Cost"];
  const rows = ARMS.map((arm) => {
    const f = files[arm];
    if (!f) return [label(arm), NOT_RUN, "-", "-", "-", "-"];
    return [
      label(arm),
      `${f.totals.falseBlocks}/${f.totals.cases}${stoppedNote(f)}`,
      String(f.cases.filter((c) => c.falseBlock && c.blocked_at === "gateway_guardrail").length),
      String(f.cases.filter((c) => c.falseBlock && c.blocked_at === "output_check").length),
      String(f.totals.inconclusive),
      usd(f.totals.cost_usd),
    ];
  });
  const src = ARMS.map((a) => `\`results/eval-${a}-benign.json\``).join(", ");
  return ["#### Benign issues (false block = the issue was held)", "", table(head, rows), "", `Source: ${src}.`].join("\n");
}

function spamSection(files: Results["spam"]): string {
  const head = ["Arm", "Spam issues", "First budget refusal", "Spam cost", "Legit author served", "Cost at N=100 (modeled)"];
  const rows = ARMS.map((arm) => {
    const s = files[arm];
    if (!s) return [label(arm), NOT_RUN, "-", "-", "-", "-"];
    const answered = s.issues.filter((i) => i.status === "answered").length;
    return [
      label(arm),
      `${s.issues.length}/${s.n} filed, ${answered} answered${s.stopped ? ` (stopped: ${s.stopped})` : ""}`,
      s.first_refusal_index === null ? "none" : `issue ${s.first_refusal_index}`,
      usd(s.total_cost_usd - (s.legit?.cost_usd ?? 0)),
      s.legit === null ? "-" : s.legit.served ? "yes" : `no (${s.legit.status})`,
      s.modeled ? `${usd(s.modeled.cost_usd)} (modeled)` : "-",
    ];
  });
  const src = ARMS.map((a) => `\`results/spam-${a}.json\``).join(", ");
  const formulas = ARMS.flatMap((a) => (files[a]?.modeled ? [`- ${label(a)}: ${files[a]!.modeled!.formula}`] : []));
  return [
    "#### Spam wave",
    "",
    table(head, rows),
    "",
    `Source: ${src}. The N=100 column is a model, not a measurement.`,
    ...(formulas.length > 0 ? ["", ...formulas] : []),
  ].join("\n");
}

export function renderBlock(r: Results): string {
  return [
    "Targets were fixed before the first run: see [`eval/PREREGISTRATION.md`](eval/PREREGISTRATION.md).",
    "",
    attackSection(r.attacks),
    "",
    benignSection(r.benign),
    "",
    spamSection(r.spam),
  ].join("\n");
}

/** Replaces the text between the markers; adds a minimal "## Results" section when they are missing. */
export function applyBlock(readme: string, block: string): string {
  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const body = block.replace(/\n/g, eol);
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s !== -1 && e > s) return `${readme.slice(0, s + START.length)}${eol}${body}${eol}${readme.slice(e)}`;
  const section = `${START}${eol}${body}${eol}${END}`;
  const heading = /^## Results[ \t]*\r?$/m.exec(readme);
  if (heading) {
    const at = heading.index + heading[0].length;
    return `${readme.slice(0, at)}${eol}${eol}${section}${readme.slice(at)}`;
  }
  const trimmed = readme.replace(/\s+$/, "");
  return `${trimmed}${eol}${eol}## Results${eol}${eol}${section}${eol}`;
}

function main() {
  const root = join(__dirname, "..");
  const readmePath = join(root, "README.md");
  const next = applyBlock(readFileSync(readmePath, "utf8"), renderBlock(loadResults(join(root, "results"))));
  writeFileSync(readmePath, next);
  console.log("README.md results block updated");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("render-results.ts")) main();
