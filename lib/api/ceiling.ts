import { workspaceCeiling, type WorkspaceCeiling } from "../balance";
import type { KvStore } from "../kv";
import type { KeyBudget } from "../otari/types";
import { errorJson, safeJson } from "./common";

export const CEILING_CACHE_KEY = "cache:workspace_ceiling";
export const CEILING_TTL_MS = 60_000;

export type CeilingDeps = {
  kv: KvStore;
  /** `GET /key/budget` with the strangers key. */
  keyBudget: () => Promise<KeyBudget>;
  now?: () => number;
};

type Cached = { ceiling: WorkspaceCeiling | null };

/**
 * The workspace ceiling, read from the gateway at most once a minute. A failed read is cached too,
 * so a gateway outage costs one call a minute, not one per console load. Null when unavailable.
 */
export async function readCeiling(d: CeilingDeps): Promise<WorkspaceCeiling | null> {
  const now = d.now ?? Date.now;
  try {
    const hit = await d.kv.get<Cached>(CEILING_CACHE_KEY);
    if (hit && typeof hit === "object" && "ceiling" in hit) return hit.ceiling;
  } catch {
    // An unreadable cache is a miss.
  }
  let ceiling: WorkspaceCeiling | null;
  try {
    ceiling = workspaceCeiling(await d.keyBudget());
  } catch {
    ceiling = null;
  }
  await d.kv.put(CEILING_CACHE_KEY, { ceiling } satisfies Cached, new Date(now() + CEILING_TTL_MS)).catch(() => undefined);
  return ceiling;
}

/** GET /api/ceiling → { ceiling }, or 503 when the gateway did not say. */
export async function handleCeiling(d: CeilingDeps): Promise<Response> {
  const ceiling = await readCeiling(d);
  return ceiling ? safeJson({ ceiling }) : errorJson(503, "unavailable", "The gateway did not report the workspace ceiling.");
}
