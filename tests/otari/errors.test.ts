import { describe, expect, it } from "vitest";
import { classifyOtariError } from "../../lib/otari/errors";

describe("classifyOtariError", () => {
  it("maps a budget refusal from headers", () => {
    const err = classifyOtariError(
      403,
      new Headers({ "Otari-Error-Code": "budget_exceeded", "Otari-Budget-Scope": "user", "Retry-After": "3600" }),
      JSON.stringify({ detail: "User has exceeded budget limit", code: "budget_exceeded" }),
    );
    expect(err.kind).toBe("budget_exceeded");
    expect(err.budgetScope).toBe("user");
    expect(err.retryAfterSec).toBe(3600);
    expect(err.status).toBe(403);
  });

  it("maps a guardrail block from the body", () => {
    const err = classifyOtariError(
      403,
      new Headers(),
      JSON.stringify({
        detail: {
          code: "guardrail_violation",
          guardrails: [{ profile: "prompt-injection", explanation: "x", score: 0.97 }],
        },
      }),
    );
    expect(err.kind).toBe("guardrail_violation");
    expect(err.guardrails).toEqual([{ profile: "prompt-injection", explanation: "x", score: 0.97 }]);
  });

  it("maps 402 and 429", () => {
    expect(classifyOtariError(402, new Headers({ "Otari-Error-Code": "insufficient_funds" }), "{}").kind).toBe(
      "insufficient_funds",
    );
    expect(classifyOtariError(429, new Headers(), "").kind).toBe("rate_limited");
  });

  it("classifies a 502 HTML body as upstream without throwing", () => {
    const err = classifyOtariError(502, new Headers(), "<html><body>Bad Gateway</body></html>");
    expect(err.kind).toBe("upstream");
    expect(err.code).toBeNull();
  });

  it("keeps unknown 403 codes as other with the raw code", () => {
    const err = classifyOtariError(403, new Headers({ "Otari-Error-Code": "model_not_allowed" }), "{}");
    expect(err.kind).toBe("other");
    expect(err.code).toBe("model_not_allowed");
  });

  it("does not put the body in the message", () => {
    const err = classifyOtariError(500, new Headers(), "secret-ish body text");
    expect(err.message).not.toContain("secret-ish");
  });
});
