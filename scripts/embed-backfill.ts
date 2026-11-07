// Usage: pnpm embed-backfill [owner/repo]
// Fills NULL issue embeddings (batches of at most 32 inputs per Otari call). Safe to re-run.
import { eq } from "drizzle-orm";
import { db } from "../lib/db/client";
import { repos } from "../lib/db/schema";
import { otariEmbedderFromEnv } from "../lib/snapshot/embed";
import { drizzleIngestStore } from "../lib/snapshot/drizzle-store";
import { embedMissing } from "../lib/snapshot/ingest";

async function main() {
  const only = process.argv[2];
  const embed = otariEmbedderFromEnv();
  if (!embed) throw new Error("OTARI_KEY_OPS is not set");
  const store = drizzleIngestStore();
  const rows = only
    ? await db().select({ id: repos.id, fullName: repos.fullName }).from(repos).where(eq(repos.fullName, only))
    : await db().select({ id: repos.id, fullName: repos.fullName }).from(repos);
  for (const r of rows) {
    let total = 0;
    for (;;) {
      const n = await embedMissing(store, r.id, embed, 128);
      if (n === 0) break;
      total += n;
    }
    const remaining = (await store.issuesMissingEmbedding(r.id, 1000)).length;
    console.log(JSON.stringify({ repo: r.fullName, embedded: total, stillMissing: remaining }));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
