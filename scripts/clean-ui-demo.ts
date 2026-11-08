/** Deletes everything scripts/seed-ui-demo.ts inserted, then prints what is left (all zeros). */
import { db } from "../lib/db/client";
import { cleanUiDemo, countUiDemo } from "./ui-demo-core";

async function main() {
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
