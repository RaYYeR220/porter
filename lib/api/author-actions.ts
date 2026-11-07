import { applyAuthorAction, isActionableId, isAuthorAction, type AuthorsDeps } from "../authors";
import type { KvStore } from "../kv";
import { errorJson, internalError, requestHash, type Limiter, rateLimited } from "./common";

export const AUTHOR_ACTIONS_PER_HOUR = 5;
export const AUDIT_TTL_MS = 30 * 24 * 3600_000;

export type AuthorActionDeps = {
  limit: Limiter;
  salt: () => string;
  authors: AuthorsDeps;
  kv: KvStore;
  now?: () => number;
};

/** POST /api/authors/:id {action}. Public console action; per-IP limited and written to the audit trail. */
export async function handleAuthorAction(req: Request, rawId: string, d: AuthorActionDeps): Promise<Response> {
  let id: string;
  try {
    id = decodeURIComponent(rawId).toLowerCase();
  } catch {
    return errorJson(400, "invalid_request", "bad id");
  }
  if (!isActionableId(id)) return errorJson(400, "invalid_request", "only gh: and web: authors can be managed");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "invalid_request", "invalid JSON");
  }
  const action = (body as { action?: unknown } | null)?.action;
  if (!isAuthorAction(action)) return errorJson(400, "invalid_request", "action must be block, unblock, upgrade or downgrade");

  const hash = requestHash(req, d.salt);
  if (hash instanceof Response) return hash;
  if (!(await d.limit(`rl:author:${hash.slice(0, 16)}`, AUTHOR_ACTIONS_PER_HOUR, 3600))) return rateLimited();

  try {
    if ((await applyAuthorAction(id, action, d.authors)) === "unknown_author") return errorJson(404, "unknown_author");
    const ts = (d.now ?? Date.now)();
    await d.kv.put(
      `author_action:${ts}-${Math.random().toString(36).slice(2, 6)}`,
      { at: new Date(ts).toISOString(), by: `ip:${hash.slice(0, 8)}`, action, target: id },
      new Date(ts + AUDIT_TTL_MS),
    );
  } catch (e) {
    console.warn(`porter author action failed: ${e instanceof Error ? e.name : "error"}`);
    return internalError();
  }
  return Response.json({ ok: true, id, action });
}
