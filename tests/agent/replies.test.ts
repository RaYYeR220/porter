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

  it("budget wording is true for the step the refusal hit", () => {
    for (const step of [undefined, "triage"] as const) {
      expect(fixedReply("refused_budget", { retryAfterSec: 60, step })).toContain("has not looked at this issue");
    }
    for (const step of ["repro", "review"] as const) {
      for (const scope of ["user", "api_token"]) {
        const r = fixedReply("refused_budget", { retryAfterSec: 60, step, scope });
        expect(r).not.toContain("has not looked");
        expect(r).toContain("stopped before it could finish an answer");
      }
    }
  });

  it("a held draft (output check) promises no queued post", () => {
    const r = fixedReply("held_guardrail", { profile: "output" });
    expect(r).toContain("couldn't send an automatic reply this time");
    expect(r).not.toMatch(/posted|prepared|held it back|draft|answer is ready/i);
    expect(r).toContain("follow up");
  });

  it("held reply for the secrets profile tells the reporter to revoke the credential", () => {
    expect(fixedReply("held_guardrail", { profile: "secrets" })).toMatch(/revoke/i);
  });
});

describe("UNVERIFIED_NOTE", () => {
  it("says the snippet could not be verified", () => {
    expect(UNVERIFIED_NOTE).toMatch(/could not be verified/);
  });
});
