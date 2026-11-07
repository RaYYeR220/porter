import { timingSafeEqual } from "node:crypto";
import { createOtariClient } from "../otari/client";
import { toStoredEmbedding } from "../db/vector";
import { EMBEDDING_MODEL } from "../snapshot/embed";
import { drizzleRepoStore } from "./db-store";
import { githubAppWriter } from "./github-write";
import type { ToolDeps } from "./tools";

/** Constant-time bearer check against MCP_TOKEN. Missing configuration always fails closed. */
export function bearerMatches(header: string | null, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice("Bearer ".length));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function embedQuery(text: string): Promise<number[] | null> {
  const apiKey = process.env.OTARI_KEY_OPS;
  if (!apiKey) return null;
  try {
    const client = createOtariClient({ apiKey, baseUrl: process.env.OTARI_BASE_URL });
    const [v] = await client.embed([text.slice(0, 6000)], EMBEDDING_MODEL, {
      tags: { app: "porter", role: "embed" },
      signal: AbortSignal.timeout(8000),
    });
    return v ? toStoredEmbedding(v) : null;
  } catch {
    return null;
  }
}

export function runtimeDeps(): ToolDeps {
  const store = drizzleRepoStore();
  return {
    store,
    embedQuery,
    writer: githubAppWriter(async (repo) => (await store.getRepo(repo))?.installationId ?? null),
  };
}
