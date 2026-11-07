import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

let cached: ReturnType<typeof create> | undefined;

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing environment variable: DATABASE_URL");
  return drizzle(neon(url), { schema });
}

/** Lazy Drizzle client over the pooled Neon HTTP driver. */
export function db() {
  return (cached ??= create());
}

export type Db = ReturnType<typeof db>;
