/**
 * Offline aid for checking the shadow run's claims by hand. No GitHub API: reads results/shadow-otari.json
 * and the stored snapshot (issues, releases).
 *   pnpm shadow:verify                              print every claim next to its evidence
 *   pnpm shadow:verify --set 12:dup:true --set 15:fixed:false   record verdicts
 *   (--set <issue>:dup=<n>:<true|false> marks one duplicate of the issue)
 * Judge each claim against the issues themselves (and, for fixed_in, the release it cites), then record it.
 * The README and report only ever show precision over claims with a recorded verdict.
 */
import { parseArgs } from "node:util";
import { applyVerdict, firstLine, lockHeld, LOCK_FILE, parseVerdict, readShadowFile, releaseEvidence, RESULTS_FILE, summarizeShadow, writeJsonAtomic } from "../lib/shadow";
import type { ReleaseRow, ShadowFile, SnapshotIssue } from "../lib/shadow";
import { loadSnapshot } from "./shadow-db";

const mark = (v: boolean | null) => (v === null ? "unchecked" : v ? "VERIFIED" : "WRONG");

export function renderClaims(file: ShadowFile, issues: Map<number, SnapshotIssue>, releases: ReleaseRow[]): string {
  const out: string[] = [];
  const line = (n: number) => {
    const i = issues.get(n);
    return i ? `#${n} ${i.title}\n      ${firstLine(i.body)}` : `#${n} (not in the snapshot)`;
  };
  for (const it of file.issues) {
    for (const d of it.duplicates) {
      out.push(`DUPLICATE [${mark(d.verified)}]  #${it.number} -> #${d.number}${d.inSnapshot === false ? "  (DANGLING: not in the snapshot, cannot be marked true)" : ""}`);
      out.push(`  this:   ${line(it.number)}`);
      out.push(`  other:  ${line(d.number)}`);
      out.push(`  model says: ${d.why}`);
      out.push(`  record: --set ${it.number}:dup=${d.number}:true|false`, "");
    }
    if (it.fixed_in) {
      const f = it.fixed_in;
      const e = releaseEvidence(releases, it.number, it.title, f.version);
      out.push(`FIXED_IN [${mark(f.verified)}]  #${it.number} -> ${f.version}`);
      out.push(`  issue:  ${line(it.number)}`);
      out.push(`  evidence url: ${f.evidence_url || "(none)"}`);
      out.push(`  release ${f.version} in the table: ${e.claimedReleaseFound ? "yes" : "NO (claim cannot be checked offline)"}`);
      if (e.mentions.length === 0) out.push(`  no release note cites #${it.number}`);
      for (const m of e.mentions) out.push(`  cites #${it.number} [${m.tag}]: ${m.line}`);
      for (const k of e.keywordHits.slice(0, 8)) out.push(`  keyword (${k.words.join(",")}) [${k.tag}]: ${k.line}`);
      out.push(`  record: --set ${it.number}:fixed:true|false`, "");
    }
  }
  if (out.length === 0) out.push("no duplicate or fixed_in claims in the file", "");
  const s = summarizeShadow(file);
  out.push(`${s.checkedLabel}${s.precision === null ? "" : `; precision ${s.correct}/${s.checked}`}`);
  return out.join("\n");
}


/** Records verdicts into the results file. Refuses while a shadow run holds the lock; the write is atomic. */
export function recordVerdicts(args: string[], path = RESULTS_FILE, lock = LOCK_FILE): ShadowFile {
  let file = readShadowFile(path);
  if (!file) throw new Error("results/shadow-otari.json does not exist yet");
  if (args.length === 0) return file;
  const held = lockHeld(lock);
  if (held) throw new Error(`a shadow run is writing the results file (pid ${held.pid}, since ${held.at}); record verdicts after it finishes`);
  for (const arg of args) file = applyVerdict(file, parseVerdict(arg));
  writeJsonAtomic(path, file);
  return file;
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { set: { type: "string", multiple: true } } });
  const file = recordVerdicts(values.set ?? []);
  if (values.set && values.set.length > 0) console.log(`recorded ${values.set.length} verdict(s)`);
  const snap = await loadSnapshot();
  console.log(renderClaims(file, new Map(snap.issues.map((i) => [i.number, i])), snap.releases));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/shadow-verify.ts")) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : "verify failed");
    process.exit(1);
  });
}
