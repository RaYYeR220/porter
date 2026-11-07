import { z } from "zod";

const required = z.string().min(1);

const schema = z.object({
  OTARI_BASE_URL: z.string().min(1).default("https://api.otari.ai/api/v1"),
  OTARI_KEY_STRANGERS: required,
  OTARI_KEY_MAINTAINER: required,
  OTARI_KEY_GUARD: required,
  OTARI_KEY_BASELINE: required,
  OTARI_KEY_OPS: required,
  OTARI_MCP_SERVER_ID: required,
  OTARI_MCP_SERVER_ID_BASELINE: required,
  OTARI_BUDGET_NEWCOMER_ID: required,
  OTARI_BUDGET_REGULAR_ID: required,
  GUARD_TOKEN: required,
  MCP_TOKEN: required,
  GITHUB_APP_ID: required,
  GITHUB_APP_PRIVATE_KEY: required,
  GITHUB_WEBHOOK_SECRET: required,
  GITHUB_APP_SLUG: required,
  DEMO_REPO: required,
  DATABASE_URL: required,
  CRON_SECRET: required,
  BALANCE_FLOOR_USD: z.string().min(1).default("3"),
  IP_SALT: required,
});

export type Env = z.infer<typeof schema>;

/** Validates process.env. Call inside request handlers, never at module top level. */
export function getEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Missing or invalid environment variables: ${names.join(", ")}`);
  }
  return parsed.data;
}

const guardSchema = schema.pick({ OTARI_BASE_URL: true, GUARD_TOKEN: true }).extend({ OTARI_KEY_GUARD: z.string().min(1).optional() });

/** Narrow env for the guard service so it can run before the rest of the app is configured. */
export function getGuardEnv() {
  const parsed = guardSchema.safeParse(process.env);
  if (!parsed.success) throw new Error("Missing or invalid environment variables: GUARD_TOKEN");
  return parsed.data;
}
