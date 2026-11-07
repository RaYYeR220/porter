import { describe, expect, it } from "vitest";
import { fixedReply, formatWait, UNVERIFIED_NOTE } from "../../lib/agent/replies";

const INTERNALS = [
  "prompt-injection",
  "hidden_html_comment",
  "deterministic",
  "classifier",
  "detector",
  "score",
  "safeguard",
  "llama",
  "qwen",
  "guardrail",
  "explanation",
];

describe("formatWait", () => {
  it("renders hours and minutes, rounding up to the minute", () => {
    expect(formatWait(5400)).toBe("1 h 30 min");
    expect(formatWait(3600)).toBe("1 h");
    expect(formatWait(7261)).toBe("2 h 2 min");
    expect(formatWait(59)).toBe("1 min");
    expect(formatWait(0)).toBe("1 min");
  });
});

describe("fixedReply", () => {
  it("budget refusal with retryAfterSec 5400 says 1 h 30 min and carries no model text", () => {
    const r = fixedReply("refused_budget", { retryAfterSec: 5400 });
    expect(r).toContain("1 h 30 min");
    expect(r).toBe(fixedReply("refused_budget", { retryAfterSec: 5400 }));
    expect(r).not.toMatch(/undefined|null|NaN/);
  });

  it("budget refusal without Retry-After still reads well", () => {
    const r = fixedReply("refused_budget", {});
    expect(r).not.toMatch(/undefined|null|NaN/);
    expect(r.toLowerCase()).toContain("reset");
  });

  it("a non-user budget scope is not blamed on the reporter", () => {
    const user = fixedReply("refused_budget", { retryAfterSec: 60, scope: "user" });
    const pooled = fixedReply("refused_budget", { retryAfterSec: 60, scope: "api_token" });
    expect(user).toMatch(/you/i);
    expect(pooled).not.toBe(user);
    expect(pooled).toContain("1 min");
  });

  it.each([undefined, "prompt-injection", "secrets", "harm", "output", "something-new"])(
    "held reply for profile %s names no detector internals",
    (profile) => {
      const r = fixedReply("held_guardrail", { profile });
      expect(r.toLowerCase()).toContain("maintainer");
      for (const word of INTERNALS) expect(r.toLowerCase()).not.toContain(word);
      expect(r).not.toMatch(/undefined|null|NaN/);
    },
  );

  it("held reply for the secrets profile tells the reporter to revoke the credential", () => {
    expect(fixedReply("held_guardrail", { profile: "secrets" })).toMatch(/revoke/i);
  });
});

describe("UNVERIFIED_NOTE", () => {
  it("says the snippet could not be verified", () => {
    expect(UNVERIFIED_NOTE).toMatch(/could not be verified/);
  });
});
