import type { Limiter } from "../../lib/api/common";
import type { AuthorRow, AuthorsStore } from "../../lib/authors";
import type { ProposalStore, StoredProposal } from "../../lib/github/commands";
import type { KvStore } from "../../lib/kv";

export function memoryKv(clock: () => number = Date.now) {
  const m = new Map<string, { value: unknown; expiresAt: Date | null }>();
  const live = (k: string) => {
    const r = m.get(k);
    return r && (r.expiresAt === null || r.expiresAt.getTime() > clock()) ? r : undefined;
  };
  const kv: KvStore = {
    async get<T>(key: string) {
      return (live(key)?.value as T | undefined) ?? null;
    },
    async put(key, value, expiresAt) {
      m.set(key, { value, expiresAt });
    },
    async claim(key, value, expiresAt) {
      if (live(key)) return false;
      m.set(key, { value, expiresAt });
      return true;
    },
    async delete(key) {
      m.delete(key);
    },
  };
  return { kv, m };
}

/** Same fixed-window rule as the SQL limiter, in memory. Counts rejected calls too. */
export function memoryLimiter() {
  const counts = new Map<string, number>();
  const limit: Limiter = async (key, n) => {
    const c = (counts.get(key) ?? 0) + 1;
    counts.set(key, c);
    return c <= n;
  };
  return { limit, counts };
}

export function memoryAuthorsStore() {
  const rows = new Map<string, AuthorRow>();
  let upserts = 0;
  const store: AuthorsStore = {
    async upsertMany(list) {
      upserts++;
      for (const r of list) rows.set(r.externalId, r);
    },
    async list() {
      return [...rows.values()].sort((a, b) => b.spendUsd - a.spendUsd);
    },
    async patch(id, set) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, ...set });
    },
  };
  return { store, rows, upserts: () => upserts };
}

export function memoryProposalStore(list: Array<StoredProposal & { decidedBy?: string | null }>) {
  const byId = new Map(list.map((p) => [p.id, { ...p }]));
  const store: ProposalStore = {
    async load(id) {
      const p = byId.get(id);
      return p ? { ...p } : null;
    },
    async latestPending() {
      return null;
    },
    async claim(id, decidedBy) {
      const p = byId.get(id);
      if (!p || p.status !== "pending" || p.decidedBy) return false;
      p.decidedBy = decidedBy;
      return true;
    },
    async release(id) {
      const p = byId.get(id);
      if (p) p.decidedBy = null;
    },
    async finish(id, status) {
      const p = byId.get(id);
      if (p) p.status = status;
    },
  };
  return { store, byId };
}

export function req(url: string, init: { method?: string; body?: unknown; ip?: string; raw?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.ip) headers["x-forwarded-for"] = `${init.ip}, 10.0.0.1`;
  return new Request(url, {
    method: init.method ?? "POST",
    headers,
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}
