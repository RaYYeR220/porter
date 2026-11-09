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
import type { Loaded } from "../lib/site/evidence";
import {
  attackCells,
  benignCells,
  POST_HOC_NOTE,
  POST_HOC_TITLE,
  postHocTable,
  sentence,
  spamCounts,
  stressFigures,
  stressSentence,
  usd,
} from "../lib/site/post-hoc";
import type { PostHocData } from "../lib/site/post-hoc";
import { loadPostHoc, loadShadowReport } from "../lib/site/results";
import { checkTargets, targetsSentence } from "../lib/site/targets";
import type { ShadowReport } from "../lib/site/results";

export const START = "<!-- results:start -->";
export const END = "<!-- results:end -->";
/** The short "What we measured" list near the top of the README. */
export const MEASURED_START = "<!-- measured:start -->";
export const MEASURED_END = "<!-- measured:end -->";
const NOT_RUN = "Not run yet.";
const ARMS = ["porter", "baseline"] as const;
const label = (arm: string) => (arm === "porter" ? "Porter" : "Baseline");

export type Results = {
  attacks: Partial<Record<(typeof ARMS)[number], EvalFile>>;
  benign: Partial<Record<(typeof ARMS)[number], EvalFile>>;
  spam: Partial<Record<(typeof ARMS)[number], SpamResult>>;
  /** The post-hoc experiments, read and checked by the page loaders. */
  postHoc?: PostHocData[];
  /** The read-only run over Otari's tracker, as /report/otari reads it. */
  shadow?: Loaded<ShadowReport>;
};

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

export function loadResults(dir: string): Results {
  const r: Results = { attacks: {}, benign: {}, spam: {}, postHoc: loadPostHoc(dir), shadow: loadShadowReport(dir) };
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

/** The pre-registered targets against the Porter arm's files; the README says so when one is missed. */
function targetsSection(r: Results): string {
  const checks = checkTargets(r.attacks.porter, r.benign.porter, r.spam.porter);
  const rows = checks.map((c) => [c.label, c.measured ?? "-", c.met === null ? "not run yet" : c.met ? "met" : "**missed**"]);
  return [
    "#### Pre-registered targets",
    "",
    table(["Target", "Measured", "Result"], rows),
    "",
    "The prompt-only bot has no target; it is reported as measured.",
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
    "",
    targetsSection(r),
    ...(r.postHoc ? ["", postHocSection(r.postHoc)] : []),
  ].join("\n");
}

const ofN = (x: number, n: number) => `${x} of ${n}`;
const POST_HOC_LEAD = "- **Post-hoc, not pre-registered:**";

/**
 * The list at the top of the README, the pre-registered result first: its attacks and false blocks, then its
 * targets, met or missed; after them, labelled, the post-hoc smaller-model run and the request-capped spam wave;
 * last, the read-only run over Otari's tracker. Each line appears only when its files are complete; every number
 * comes from them.
 */
export function renderMeasured(r: Results): string {
  const lines: string[] = [];
  const posthoc = (key: string) => r.postHoc?.find((d) => d.def.key === key);

  const { porter: pa, baseline: ba } = r.attacks;
  const { porter: pb, baseline: bb } = r.benign;
  if (pa && ba && pb && bb) {
    const inc = (f: EvalFile) => (f.totals.inconclusive > 0 ? ` (${f.totals.inconclusive} inconclusive)` : "");
    const outcome =
      pa.totals.hijacked === 0 && ba.totals.hijacked === 0 && pa.totals.cases === ba.totals.cases
        ? `none of the ${pa.totals.cases} attacks succeeded in either arm`
        : `${ofN(pa.totals.hijacked, pa.totals.cases)} attacks${inc(pa)} succeeded against Porter and ${ofN(ba.totals.hijacked, ba.totals.cases)}${inc(ba)} against the prompt-only bot`;
    lines.push(
      `- **Pre-registered:** with the production models, ${outcome}. ` +
        `Porter held ${ofN(pa.totals.blocked_at.gateway_guardrail ?? 0, pa.totals.cases)} at the gateway before any model ran and spent ${usd(pa.totals.cost_usd)} on the attacks, against ${usd(ba.totals.cost_usd)}. ` +
        `The price: ${ofN(pb.totals.falseBlocks, pb.totals.cases)} legitimate issues held for a maintainer, against ${ofN(bb.totals.falseBlocks, bb.totals.cases)}. [Results](#results)`,
    );
    lines.push(`- **Pre-registered targets:** ${targetsSentence(checkTargets(pa, pb, r.spam.porter))} [Targets](#pre-registered-targets)`);
  }

  const small = posthoc("small-model");
  if (small?.def.kind === "eval") {
    const [porter, baseline] = small.runs as Array<{ loaded: Loaded<EvalFile> }>;
    const s = porter && baseline ? stressFigures(porter.loaded, baseline.loaded) : null;
    if (s) lines.push(`${POST_HOC_LEAD} ${stressSentence(s)} [Details](#after-the-pre-registered-run-post-hoc-not-pre-registered)`);
  }


  const cap = posthoc("request-cap");
  if (cap?.def.kind === "spam") {
    const [capped, pre] = cap.runs as Array<{ loaded: Loaded<SpamResult> }>;
    if (capped?.loaded.state === "ok" && pre?.loaded.state === "ok") {
      const s = capped.loaded.data;
      const n = spamCounts(s);
      lines.push(
        `${POST_HOC_LEAD} with a request cap in each newcomer's daily budget, ${ofN(n.answered, s.n)} spam issues were answered and ${n.refused} were refused at the gateway${n.refusedFree ? " at no cost" : ""}; ` +
          `with the dollar cap alone, ${ofN(spamCounts(pre.loaded.data).answered, pre.loaded.data.n)} were answered.` +
          (s.legit && !s.legit.served && cap.def.legitNote ? ` The legit question in that run was not answered (${s.legit.status}): ${cap.def.legitNote}.` : ""),
      );
    }
  }

  if (r.shadow?.state === "ok") lines.push(shadowLine(r.shadow.data));
  return lines.length > 0 ? lines.join("\n") : "- Not run yet.";
}

/** The read-only run over Otari's tracker: outcomes, cost, and how many of its claims a person has checked. */
function shadowLine({ file, summary: s }: ShadowReport): string {
  const sampled = file.issues.every((i) => i.sampledBy.mode === "sample") ? " (a seeded sample)" : "";
  const outcomes = [`${s.answered} answered`, `${s.held} held for a maintainer`, ...(s.refused > 0 ? [`${s.refused} refused`] : []), `${s.failed} failed`];
  const claims =
    s.checked === 0 || s.precision === null
      ? `None of its ${s.claims} duplicate and fixed-in claims has been checked by hand yet.`
      : `${s.checked} of its ${s.claims} duplicate and fixed-in claims checked by hand so far: ${Math.round(s.precision * 100)}% correct.`;
  return (
    `- **Read-only, on Otari's own tracker:** ${s.issues} open \`mozilla-ai/otari\` issues${sampled} went through Porter and nothing was posted: ` +
    `${outcomes.join(", ")}, ${usd(s.costUsd)} in total. ${claims} [Report](https://porter-frontdesk.vercel.app/report/otari)`
  );
}

/** Replaces the text between two markers; a README without them is left as it is. */
export function applyMarked(readme: string, block: string, start: string, end: string): string {
  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const s = readme.indexOf(start);
  const e = readme.indexOf(end);
  if (s === -1 || e < s) return readme;
  return `${readme.slice(0, s + start.length)}${eol}${block.replace(/\n/g, eol)}${eol}${readme.slice(e)}`;
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
  const r = loadResults(join(root, "results"));
  const next = applyMarked(applyBlock(readFileSync(readmePath, "utf8"), renderBlock(r)), renderMeasured(r), MEASURED_START, MEASURED_END);
  writeFileSync(readmePath, next);
  console.log("README.md results block updated");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("render-results.ts")) main();
