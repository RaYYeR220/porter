import { desc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "./db/client";
import { authors } from "./db/schema";
import type { KvStore } from "./kv";
import type { OtariClient } from "./otari/client";
import type { EndUser, EndUserBudget } from "./otari/types";

export const AUTHORS_REFRESH_MS = 30_000;
export const BUDGETS_CACHE_MS = 5 * 60_000;
export const AUTHORS_LOCK_KEY = "lock:authors_refresh";
export const BUDGETS_CACHE_KEY = "cache:end_user_budgets";
const LIST_LIMIT = 500;

export type AuthorRow = {
  externalId: string;
  display: string | null;
  budgetId: string | null;
  blocked: boolean;
  spendUsd: number;
  requests: number;
  nextResetAt: Date | null;
  refreshedAt: Date | null;
};

export interface AuthorsStore {
  upsertMany(rows: AuthorRow[]): Promise<void>;
  list(): Promise<AuthorRow[]>;
  get(externalId: string): Promise<AuthorRow | null>;
}

export function drizzleAuthorsStore(getDb = defaultDb): AuthorsStore {
  return {
    async upsertMany(rows) {
      if (rows.length === 0) return;
      await getDb()
        .insert(authors)
        .values(rows)
        .onConflictDoUpdate({
          target: authors.externalId,
          set: {
            display: sql`excluded.display`,
            budgetId: sql`excluded.budget_id`,
            blocked: sql`excluded.blocked`,
            spendUsd: sql`excluded.spend_usd`,
            requests: sql`excluded.requests`,
            nextResetAt: sql`excluded.next_reset_at`,
            refreshedAt: sql`excluded.refreshed_at`,
          },
        });
    },
    async list() {
      return getDb().select().from(authors).orderBy(desc(authors.spendUsd)).limit(LIST_LIMIT);
    },
    async get(externalId) {
      const [r] = await getDb().select().from(authors).where(eq(authors.externalId, externalId)).limit(1);
      return r ?? null;
    },
  };
}

/** `gh:octocat` → `octocat`; `web:ab12…` → `visitor ab12…`. */
export function displayName(externalId: string): string {
  if (externalId.startsWith("gh:")) return externalId.slice(3);
  if (externalId.startsWith("web:")) return `visitor ${externalId.slice(4, 8)}…`;
  return externalId;
}

/** Only these ids are managed through the public console. */
export const ACTIONABLE_ID_RE = /^(?:gh:[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?|web:[0-9a-f]{16})$/;
export const isActionableId = (id: string) => ACTIONABLE_ID_RE.test(id);

export type AuthorView = {
  id: string;
  display: string;
  tier: "newcomer" | "regular";
  budgetId: string | null;
  budgetName: string | null;
  budgetLimitUsd: number | null;
  spendUsd: number;
  remainingUsd: number | null;
  requests: number;
  nextResetAt: string | null;
  blocked: boolean;
  refreshedAt: string | null;
};

export type AuthorsDeps = {
  kv: KvStore;
  store: AuthorsStore;
  /** Client on the stranger service key. */
  otari: Pick<OtariClient, "endUsers" | "endUserBudgets">;
  regularBudgetId: string;
  newcomerBudgetId: string;
  now?: () => Date;
};

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toRow(u: EndUser, at: Date): AuthorRow {
  const reset = u.next_budget_reset_at ? new Date(u.next_budget_reset_at) : null;
  return {
    externalId: u.external_id,
    display: displayName(u.external_id),
    budgetId: u.budget_id ?? null,
    blocked: !!u.blocked,
    spendUsd: finite(u.spend) ?? 0,
    requests: finite(u.current_requests) ?? 0,
    nextResetAt: reset && !Number.isNaN(reset.getTime()) ? reset : null,
    refreshedAt: at,
  };
}

/** Pulls the end-user list from Otari into the authors table, at most once per 30 s (kv lock). */
export async function refreshAuthors(d: AuthorsDeps): Promise<boolean> {
  const now = (d.now ?? (() => new Date()))();
  if (!(await d.kv.claim(AUTHORS_LOCK_KEY, { at: now.toISOString() }, new Date(now.getTime() + AUTHORS_REFRESH_MS)))) return false;
  // The lock stays after a failure too, so a flapping gateway is not hammered.
  const users = await d.otari.endUsers.list(LIST_LIMIT);
  const rows = users
    .filter((u) => typeof u?.external_id === "string" && isManaged(u.external_id))
    .map((u) => toRow(u, now));
  await d.store.upsertMany(rows);
  return true;
}

const isManaged = (id: string) => id.startsWith("gh:") || id.startsWith("web:");

async function budgetsById(d: AuthorsDeps): Promise<Map<string, EndUserBudget>> {
  const now = (d.now ?? (() => new Date()))();
  let list = await d.kv.get<EndUserBudget[]>(BUDGETS_CACHE_KEY);
  if (!Array.isArray(list)) {
    try {
      list = await d.otari.endUserBudgets();
      await d.kv.put(BUDGETS_CACHE_KEY, list, new Date(now.getTime() + BUDGETS_CACHE_MS)).catch(() => undefined);
    } catch {
      list = [];
    }
  }
  return new Map(list.filter((b) => b && typeof b.budget_id === "string").map((b) => [b.budget_id, b]));
}

/** Live meters for the console. Otari is the source of truth; the table is the throttled cache. */
export async function getAuthors(d: AuthorsDeps): Promise<AuthorView[]> {
  try {
    await refreshAuthors(d);
  } catch (e) {
    console.warn(`porter authors refresh failed: ${e instanceof Error ? e.name : "error"}`);
  }
  const [rows, budgets] = await Promise.all([d.store.list(), budgetsById(d)]);
  return rows.filter((r) => isManaged(r.externalId)).map((r) => {
    const b = r.budgetId ? budgets.get(r.budgetId) : undefined;
    const limit = finite(b?.max_budget);
    return {
      id: r.externalId,
      display: displayName(r.externalId),
      tier: r.budgetId !== null && r.budgetId === d.regularBudgetId ? "regular" : "newcomer",
      budgetId: r.budgetId,
      budgetName: b?.name ?? null,
      budgetLimitUsd: limit,
      spendUsd: r.spendUsd,
      remainingUsd: limit === null ? null : Math.max(0, limit - r.spendUsd),
      requests: r.requests,
      nextResetAt: r.nextResetAt ? r.nextResetAt.toISOString() : null,
      blocked: r.blocked,
      refreshedAt: r.refreshedAt ? r.refreshedAt.toISOString() : null,
    };
  });
}

export const AUTHOR_ACTIONS = ["block", "unblock", "upgrade", "downgrade"] as const;
export type AuthorAction = (typeof AUTHOR_ACTIONS)[number];
export const isAuthorAction = (v: unknown): v is AuthorAction => typeof v === "string" && (AUTHOR_ACTIONS as readonly string[]).includes(v);

/**
 * Applies a maintainer action through the stranger key's end-users API and upserts the mirror row.
 * The target must already exist (in `authors`, or known to Otari): the console never creates
 * end users. Returns "unknown_author" otherwise, with nothing written.
 */
export async function applyAuthorAction(id: string, action: AuthorAction, d: AuthorsDeps): Promise<"ok" | "unknown_author"> {
  const at = (d.now ?? (() => new Date()))();
  let row = await d.store.get(id);
  if (!row) {
    const user = isManaged(id) ? await d.otari.endUsers.get(id) : null;
    if (!user || user.external_id !== id) return "unknown_author";
    row = toRow(user, at);
  }
  if (action === "upgrade" || action === "downgrade") {
    const budgetId = action === "upgrade" ? d.regularBudgetId : d.newcomerBudgetId;
    await d.otari.endUsers.put(id, budgetId);
    row = { ...row, budgetId };
  } else {
    const blocked = action === "block";
    await d.otari.endUsers.patch(id, { blocked });
    row = { ...row, blocked };
  }
  await d.store.upsertMany([{ ...row, refreshedAt: at }]);
  return "ok";
}
