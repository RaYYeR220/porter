import { INSUFFICIENT_FUNDS_FLAG } from "./agent/pipeline";
import type { KvStore } from "./kv";
import type { KeyBudget } from "./otari/types";

export const KEY_BUDGET_CACHE_KEY = "cache:key_budget";
export const KEY_BUDGET_TTL_MS = 60_000;
/** Below the desk workspace's daily ceiling, which the strangers key's tightest limit can never exceed. */
export const DEFAULT_FLOOR_USD = 0.2;

export type FundsGate = { paused: false } | { paused: true; reason: "funds_low" };

export type FundsDeps = {
  kv: KvStore;
  /** Reads the stranger service key's headroom. */
  keyBudget: () => Promise<KeyBudget>;
  floorUsd: number;
  now?: () => number;
};

/** Floor from BALANCE_FLOOR_USD; anything unusable falls back to the default of 0.20. */
export function parseFloor(raw: string | undefined): number {
  const n = Number(raw);
  return raw && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_FLOOR_USD;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The tightest remaining USD across the key's overall headroom and each of its limits. */
export function tightestRemainingUsd(b: KeyBudget): number | null {
  const all = [num(b.remaining_usd), ...(Array.isArray(b.limits) ? b.limits.map((l) => num(l?.remaining_usd)) : [])];
  const known = all.filter((v): v is number => v !== null);
  return known.length > 0 ? Math.min(...known) : null;
}

export type WorkspaceCeiling = {
  /** The tightest USD the strangers key may still spend: the figure the /try floor reads. */
  remainingUsd: number | null;
  /** The limit that figure comes from, as the gateway reports it (a workspace limit may have none). */
  limitUsd: number | null;
  usedUsd: number | null;
  /** When that limit resets, ISO in UTC. */
  resetsAt: string | null;
  scope: string | null;
  enforced: boolean;
};

const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/**
 * The desk's daily ceiling from `GET /key/budget` on the strangers key: what is left, and the limit
 * it comes from (the tightest one, else the workspace one, else the first). Only these fields leave
 * the server.
 */
export function workspaceCeiling(b: KeyBudget): WorkspaceCeiling {
  const limits = (Array.isArray(b.limits) ? b.limits : []).filter(
    (l): l is Record<string, unknown> => !!l && typeof l === "object" && !Array.isArray(l),
  );
  const withRemaining = limits.filter((l) => num(l.remaining_usd) !== null);
  const tightest = withRemaining.sort((x, y) => (num(x.remaining_usd) as number) - (num(y.remaining_usd) as number))[0];
  const pick = tightest ?? limits.find((l) => l.scope === "workspace") ?? limits[0] ?? null;
  const earliest = limits.map((l) => iso(l.resets_at)).filter((v): v is string => v !== null).sort()[0] ?? null;
  return {
    remainingUsd: tightestRemainingUsd(b),
    limitUsd: pick ? num(pick.limit_usd) : null,
    usedUsd: pick ? num(pick.used_usd) : null,
    resetsAt: (pick ? iso(pick.resets_at) : null) ?? earliest,
    scope: pick && typeof pick.scope === "string" ? pick.scope : null,
    enforced: b.budgets_enforced === true,
  };
}

/**
 * Should /try refuse right now? Yes when a 402 was seen in the last 10 minutes (kv flag set by the
 * pipeline) or the stranger key's tightest remaining headroom is below the floor. The keyBudget
 * answer is cached for 60 s so Otari is not called per request. An unreadable budget does not pause:
 * a real shortage then shows up as a 402, which sets the flag.
 */
export async function fundsGate(d: FundsDeps): Promise<FundsGate> {
  if ((await d.kv.get(INSUFFICIENT_FUNDS_FLAG)) !== null) return { paused: true, reason: "funds_low" };

  const now = d.now ?? Date.now;
  let remaining: number | null | undefined;
  const cached = await d.kv.get<{ remaining: number | null }>(KEY_BUDGET_CACHE_KEY);
  if (cached && "remaining" in cached) remaining = cached.remaining;
  if (remaining === undefined) {
    try {
      remaining = tightestRemainingUsd(await d.keyBudget());
    } catch {
      return { paused: false };
    }
    await d.kv.put(KEY_BUDGET_CACHE_KEY, { remaining }, new Date(now() + KEY_BUDGET_TTL_MS)).catch(() => undefined);
  }
  return remaining !== null && remaining < d.floorUsd ? { paused: true, reason: "funds_low" } : { paused: false };
}
