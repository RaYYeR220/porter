import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db as defaultDb } from "./db/client";
import { kv } from "./db/schema";

/** Small window on the kv table so API logic runs against an in-memory fake in tests. */
export interface KvStore {
  /** The live value, or null when absent or expired. */
  get<T = unknown>(key: string): Promise<T | null>;
  put(key: string, value: unknown, expiresAt: Date | null): Promise<void>;
  /** Atomically takes `key` unless a live value exists. False when someone else holds it. */
  claim(key: string, value: unknown, expiresAt: Date): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export function drizzleKv(getDb = defaultDb): KvStore {
  const live = (key: string) => and(eq(kv.key, key), or(isNull(kv.expiresAt), gt(kv.expiresAt, sql`now()`)));
  return {
    async get<T>(key: string) {
      const [r] = await getDb().select({ value: kv.value }).from(kv).where(live(key)).limit(1);
      return r ? (r.value as T) : null;
    },
    async put(key, value, expiresAt) {
      await getDb()
        .insert(kv)
        .values({ key, value: value ?? null, expiresAt })
        .onConflictDoUpdate({ target: kv.key, set: { value: value ?? null, expiresAt, updatedAt: new Date() } });
    },
    async claim(key, value, expiresAt) {
      const got = await getDb()
        .insert(kv)
        .values({ key, value: value ?? null, expiresAt })
        .onConflictDoUpdate({
          target: kv.key,
          set: { value: value ?? null, expiresAt, updatedAt: new Date() },
          setWhere: sql`${kv.expiresAt} is not null and ${kv.expiresAt} < now()`,
        })
        .returning({ key: kv.key });
      return got.length > 0;
    },
    async delete(key) {
      await getDb().delete(kv).where(eq(kv.key, key));
    },
  };
}
