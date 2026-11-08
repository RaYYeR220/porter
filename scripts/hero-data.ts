/**
 * Writes components/hero/hero-data.json, everything the landing hero draws.
 *   pnpm hero-data
 *
 * Issue numbers and titles come from the stored snapshot of mozilla-ai/otari (one database read, no GitHub
 * call); authors are never read into the file. Attack rows are the eval corpus cases the gateway detectors
 * hold on their own, each with the signal the detector reports. Spam lines are the /try spam preset.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAttacks } from "../eval/corpus";
import { presetIssues } from "../lib/try/presets";
import { SHADOW_REPO } from "../lib/shadow";
import { loadSnapshot } from "./shadow-db";
import { buildHeroData } from "./hero-data-core";

const OUT = join(process.cwd(), "components", "hero", "hero-data.json");
const MAX_BYTES = 40 * 1024;

async function main() {
  const snap = await loadSnapshot();
  const data = buildHeroData({
    repo: SHADOW_REPO,
    snapshotAt: snap.snapshotAt,
    issues: snap.issues.map((i) => ({ number: i.number, title: i.title, state: i.state })),
    attacks: loadAttacks(),
    spam: presetIssues("spam").map((i) => i.title),
  });
  const json = `${JSON.stringify(data, null, 1)}\n`;
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_BYTES) throw new Error(`hero data is ${bytes} bytes, over the ${MAX_BYTES} byte budget`);
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}: ${data.issues.length} issues, ${data.attacks.length} attacks, ${data.spam.length} spam lines, ${bytes} bytes`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
