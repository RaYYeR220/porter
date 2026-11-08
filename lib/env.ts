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
  BALANCE_FLOOR_USD: z.string().min(1).default("0.20"),
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

type Arm = "porter" | "baseline";

const nonEmpty = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);

/** Stored MCP server id for an arm, or null while it is not registered yet. */
export function getMcpServerId(arm: Arm): string | null {
  return nonEmpty(arm === "porter" ? process.env.OTARI_MCP_SERVER_ID : process.env.OTARI_MCP_SERVER_ID_BASELINE);
}

/** Narrow env for GitHub intake: webhook secret and the App slug (bot identity). */
export function getGithubEnv(): { webhookSecret: string; slug: string } {
  const webhookSecret = nonEmpty(process.env.GITHUB_WEBHOOK_SECRET);
  const slug = nonEmpty(process.env.GITHUB_APP_SLUG);
  if (!webhookSecret || !slug) {
    const missing = [!webhookSecret && "GITHUB_WEBHOOK_SECRET", !slug && "GITHUB_APP_SLUG"].filter(Boolean);
    throw new Error(`Missing or invalid environment variables: ${missing.join(", ")}`);
  }
  return { webhookSecret, slug };
}

/** Maintainer-key Otari settings, for executing approved proposals. */
export function getMaintainerEnv(): { baseUrl: string; apiKey: string; mcpServerId: string | null } {
  const apiKey = nonEmpty(process.env.OTARI_KEY_MAINTAINER);
  if (!apiKey) throw new Error("Missing or invalid environment variables: OTARI_KEY_MAINTAINER");
  return {
    baseUrl: nonEmpty(process.env.OTARI_BASE_URL) ?? schema.shape.OTARI_BASE_URL.parse(undefined),
    apiKey,
    mcpServerId: getMcpServerId("porter"),
  };
}

/** Budget id the `/porter upgrade` command moves an author to. */
export function getRegularBudgetId(): string {
  const id = nonEmpty(process.env.OTARI_BUDGET_REGULAR_ID);
  if (!id) throw new Error("Missing or invalid environment variables: OTARI_BUDGET_REGULAR_ID");
  return id;
}

/** Narrow env for the agent pipeline: the arm's service key (desk strangers or baseline) and its MCP server. */
export function getAgentEnv(arm: Arm): { baseUrl: string; apiKey: string; mcpServerId: string | null } {
  const name = arm === "porter" ? "OTARI_KEY_STRANGERS" : "OTARI_KEY_BASELINE";
  const apiKey = nonEmpty(process.env[name]);
  if (!apiKey) throw new Error(`Missing or invalid environment variables: ${name}`);
  return {
    baseUrl: nonEmpty(process.env.OTARI_BASE_URL) ?? schema.shape.OTARI_BASE_URL.parse(undefined),
    apiKey,
    mcpServerId: getMcpServerId(arm),
  };
}
