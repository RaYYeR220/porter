import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnv } from "../lib/env";

const REQUIRED = [
  "OTARI_KEY_STRANGERS",
  "OTARI_KEY_MAINTAINER",
  "OTARI_KEY_GUARD",
  "OTARI_KEY_BASELINE",
  "OTARI_KEY_OPS",
  "OTARI_MCP_SERVER_ID",
  "OTARI_MCP_SERVER_ID_BASELINE",
  "OTARI_BUDGET_NEWCOMER_ID",
  "OTARI_BUDGET_REGULAR_ID",
  "GUARD_TOKEN",
  "MCP_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_SLUG",
  "DEMO_REPO",
  "DATABASE_URL",
  "CRON_SECRET",
  "IP_SALT",
] as const;

const OPTIONAL = ["OTARI_BASE_URL", "BALANCE_FLOOR_USD"] as const;

let saved: Record<string, string | undefined>;

function setAll() {
  for (const k of REQUIRED) process.env[k] = `value-of-${k}`;
  process.env.OTARI_BASE_URL = "https://example.test/api/v1";
  process.env.BALANCE_FLOOR_USD = "5";
}

beforeEach(() => {
  saved = {};
  for (const k of [...REQUIRED, ...OPTIONAL]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("getEnv", () => {
  it("returns all vars when set", () => {
    setAll();
    const env = getEnv();
    for (const k of REQUIRED) expect(env[k]).toBe(`value-of-${k}`);
    expect(env.OTARI_BASE_URL).toBe("https://example.test/api/v1");
    expect(env.BALANCE_FLOOR_USD).toBe("5");
  });

  it("names the missing variable in the error", () => {
    setAll();
    delete process.env.OTARI_KEY_STRANGERS;
    expect(() => getEnv()).toThrow(/OTARI_KEY_STRANGERS/);
  });

  it("defaults OTARI_BASE_URL and BALANCE_FLOOR_USD when unset", () => {
    setAll();
    delete process.env.OTARI_BASE_URL;
    delete process.env.BALANCE_FLOOR_USD;
    const env = getEnv();
    expect(env.OTARI_BASE_URL).toBe("https://api.otari.ai/api/v1");
    expect(env.BALANCE_FLOOR_USD).toBe("0.20");
  });
});
