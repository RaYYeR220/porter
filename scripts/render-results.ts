/**
 * Renders the eval results into README.md, between <!-- results:start --> and <!-- results:end -->.
 *   pnpm eval:render
 *
 * Reads results/eval-<arm>-<set>.json and results/spam-<arm>.json for the pre-registered tables, then the
 * post-hoc runs' tagged files (lib/site/post-hoc.ts) for a separate block below them. Only the text between the
 * markers changes; a missing results file renders "Not run yet." and no number is ever filled in by hand.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalFile } from "../eval/harness";
import type { SpamResult } from "../eval/spam-core";
import { attackCells, benignCells, POST_HOC_NOTE, POST_HOC_TITLE, postHocTable, sentence, usd } from "../lib/site/post-hoc";
import type { PostHocData } from "../lib/site/post-hoc";
import { loadPostHoc } from "../lib/site/results";

export const START = "<!-- results:start -->";
export const END = "<!-- results:end -->";
const NOT_RUN = "Not run yet.";
const ARMS = ["porter", "baseline"] as const;
const label = (arm: string) => (arm === "porter" ? "Porter" : "Baseline");

export type Results = {
  attacks: Partial<Record<(typeof ARMS)[number], EvalFile>>;
  benign: Partial<Record<(typeof ARMS)[number], EvalFile>>;
  spam: Partial<Record<(typeof ARMS)[number], SpamResult>>;
  /** The post-hoc experiments, read and checked by the page loaders. */
  postHoc?: PostHocData[];
};

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

export function loadResults(dir: string): Results {
  const r: Results = { attacks: {}, benign: {}, spam: {}, postHoc: loadPostHoc(dir) };
  for (const arm of ARMS) {
    r.attacks[arm] = readJson<EvalFile>(join(dir, `eval-${arm}-attacks.json`));
    r.benign[arm] = readJson<EvalFile>(join(dir, `eval-${arm}-benign.json`));
    r.spam[arm] = readJson<SpamResult>(join(dir, `spam-${arm}.json`));
  }
  return r;
}

const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const table = (head: string[], rows: string[][]) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");
const code = (s: string) => "`" + s + "`";

function attackSection(files: Results["attacks"]): string {
  const head = ["Arm", "Hijacked", "Gateway guardrail", "Output check", "ACL", "Server refused", "Model refused", "Not blocked", "Inconclusive", "Cost"];
  const rows = ARMS.map((arm) => {
    const f = files[arm];
    if (!f) return [label(arm), NOT_RUN, ...Array(8).fill("-")];
    return [label(arm), ...attackCells(f)];
  });
  const src = ARMS.map((a) => code(`results/eval-${a}-attacks.json`)).join(", ");
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
    return [label(arm), ...benignCells(f)];
  });
  const src = ARMS.map((a) => code(`results/eval-${a}-benign.json`)).join(", ");
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
  const src = ARMS.map((a) => code(`results/spam-${a}.json`)).join(", ");
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

/** The post-hoc block: one small table per experiment, then what changed and the commit. */
function postHocSection(all: PostHocData[]): string {
  const parts = [`### ${POST_HOC_TITLE}`, "", POST_HOC_NOTE];
  for (const d of all) {
    const t = postHocTable(d);
    parts.push("", `#### ${t.title}`, "", table(t.head, t.rows));
    if (t.notes.length > 0) parts.push("", ...t.notes.map((n) => `- ${n}`));
    const src = t.sources.map(code).join(", ");
    parts.push("", `What changed: ${sentence(t.changed)} (commit ${t.commit}). Source: ${src}.`);
  }
  return parts.join("\n");
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
    ...(r.postHoc ? ["", postHocSection(r.postHoc)] : []),
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
