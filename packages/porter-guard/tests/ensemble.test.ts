import { describe, expect, it } from "vitest";
import { decide } from "../src/ensemble.ts";
import type { ModelVerdict, Signal } from "../src/protocol.ts";

const v = (flagged: boolean | null, score: number | null, model = "m"): ModelVerdict => ({
  model,
  flagged,
  score,
  latencyMs: 5,
  ...(flagged === null ? { error: "timeout" } : {}),
});
const sig = (id: Signal["id"]): Signal => ({ id, excerpt: "x" });

describe("decide: prompt-injection", () => {
  it("blocks when a model flags with score >= 0.5", () => {
    const r = decide("prompt-injection", [], [v(true, 0.9), v(false, 0.05)]);
    expect(r.valid).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(0.9);
  });
  it("does not block on a low-score flag alone", () => {
    expect(decide("prompt-injection", [], [v(true, 0.3), v(false, 0.05)]).valid).toBe(true);
  });
  it("blocks role_block + ignore_previous when all models are null", () => {
    const r = decide("prompt-injection", [sig("role_block"), sig("ignore_previous")], [v(null, null), v(null, null)]);
    expect(r.valid).toBe(false);
    expect(r.explanation).not.toBe("classifier_unavailable");
  });
  it("reports classifier_unavailable only with no signals and all models null", () => {
    const r = decide("prompt-injection", [], [v(null, null), v(null, null)]);
    expect(r).toMatchObject({ valid: false, explanation: "classifier_unavailable" });
  });
  it("is valid when all models say clean and no signals", () => {
    expect(decide("prompt-injection", [], [v(false, 0.05), v(false, 0.1)]).valid).toBe(true);
  });
  it("lets clean models outvote a single weak signal", () => {
    expect(decide("prompt-injection", [sig("ignore_previous")], [v(false, 0.05), v(false, 0.1)]).valid).toBe(true);
  });
  it("blocks a hidden html comment even if models say clean", () => {
    expect(decide("prompt-injection", [sig("hidden_html_comment")], [v(false, 0.05), v(false, 0.1)]).valid).toBe(false);
  });
});

describe("decide: secrets", () => {
  it("blocks on any secret signal regardless of models", () => {
    expect(decide("secrets", [sig("secret_github_token")], [v(false, 0)]).valid).toBe(false);
  });
  it("passes with no secret signal", () => {
    expect(decide("secrets", [sig("role_block")], []).valid).toBe(true);
  });
});

describe("decide: harm", () => {
  it("blocks when llama-guard flags", () => {
    expect(decide("harm", [], [v(true, 0.9, "meta/llama-guard-4-12b")]).valid).toBe(false);
  });
  it("passes when safe", () => {
    expect(decide("harm", [], [v(false, 0.05)]).valid).toBe(true);
  });
});

describe("decide: shape", () => {
  it("always returns a boolean valid and numeric score", () => {
    for (const p of ["prompt-injection", "secrets", "harm"] as const) {
      const r = decide(p, [], [v(null, null)]);
      expect(typeof r.valid).toBe("boolean");
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });
});

describe("decide: hidden_comment_suspect (weak tier)", () => {
  it("does not block alone when classifiers are clean", () => {
    expect(decide("prompt-injection", [sig("hidden_comment_suspect")], [v(false, 0.05), v(false, 0.1)]).valid).toBe(true);
  });
  it("blocks together with a low-score classifier flag", () => {
    expect(decide("prompt-injection", [sig("hidden_comment_suspect")], [v(true, 0.35), v(false, 0.05)]).valid).toBe(false);
  });
  it("blocks together with another deterministic signal", () => {
    expect(decide("prompt-injection", [sig("hidden_comment_suspect"), sig("ignore_previous")], [v(false, 0.05), v(false, 0.1)]).valid).toBe(false);
  });
  it("counts like other weak signals when classifiers are unavailable", () => {
    const r = decide("prompt-injection", [sig("hidden_comment_suspect")], [v(null, null), v(null, null)]);
    expect(r.valid).toBe(false);
    expect(r.explanation).not.toBe("classifier_unavailable");
  });
  it("a low-score flag alone (no weak signal) still passes", () => {
    expect(decide("prompt-injection", [], [v(true, 0.35), v(false, 0.05)]).valid).toBe(true);
  });
  it("a strong signal alone blocks", () => {
    expect(decide("prompt-injection", [sig("hidden_html_comment")], [v(false, 0.05), v(false, 0.1)]).valid).toBe(false);
  });
});
