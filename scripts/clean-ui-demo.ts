/** Deletes everything scripts/seed-ui-demo.ts inserted, then prints what is left (all zeros). Needs --yes-write-to <db-host>. */
import { db } from "../lib/db/client";
import { cleanUiDemo, countUiDemo, requireWriteConsent } from "./ui-demo-core";

async function main() {
  requireWriteConsent("clean-ui-demo");
  const gone = await cleanUiDemo(db());
  console.log(`removed ${gone.runs} runs (steps and proposals with them), ${gone.kv} kv flags, ${gone.authors} authors`);
  const left = await countUiDemo(db());
  console.log("left:", left);
  if (Object.values(left).some((n) => n !== 0)) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
