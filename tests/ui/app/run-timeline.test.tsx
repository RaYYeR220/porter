// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunTimeline } from "../../../components/app/RunTimeline";
import { detail, step, triageOk } from "./fixtures";

const HELD_REPLY = "Thanks for opening this issue. Porter has passed it to a maintainer instead of answering it automatically.";
const BUDGET_REPLY = "Thanks for opening this issue. You have reached the limit of automated answers. The limit resets in about 3 h 12 min.";

const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, " ") ?? "";

describe("RunTimeline", () => {
  afterEach(cleanup);

  it("shows a skeleton until the first read arrives", () => {
    const { container } = render(<RunTimeline detail={undefined} />);
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
  });

  it("renders a running run with the gateway line in progress", () => {
    const { container } = render(<RunTimeline detail={detail("running", [triageOk()])} />);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(text(container)).toContain("calls in progress");
    expect(text(container)).toContain("Working: the next call is in flight.");
  });

  it("renders an answered run with its reply as Markdown", () => {
    const d = detail("answered", [triageOk(), step({ role: "review", requestedModel: "porter-review", servedModel: "zai/glm-5.3-flash", costUsd: 0.0002 })], {
      reply: "Looks like **#12**. See [the docs](https://docs.example.org/export).",
    });
    const { container } = render(<RunTimeline detail={d} />);
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(container.querySelector(".md strong")?.textContent).toBe("#12");
    expect(text(container)).toContain("passed");
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("renders a gateway hold: 0 answer tokens and the fixed reply, no answer", () => {
    const held = step({
      role: "triage",
      requestedModel: "porter-triage",
      errorKind: "guardrail_violation",
      errorStatus: 400,
      guardrails: [{ profile: "prompt-injection", explanation: "hidden_html_comment", score: 0.97 }],
    });
    const { container } = render(<RunTimeline detail={detail("held_guardrail", [held], { reply: HELD_REPLY })} />);
    const all = text(container);
    expect(screen.getByText("Held")).toBeTruthy();
    expect(all).toContain("held here");
    expect(all).toContain("0 answer tokens");
    expect(all).toContain("Held at the gateway");
    expect(all).toContain(HELD_REPLY);
    expect(all).toContain("prompt-injection");
    expect(all).toContain("score 0.97");
    expect(container.querySelector(".md")).toBeNull();
  });

  it("does not claim 0 answer tokens when a model already ran before the hold", () => {
    const held = step({ role: "review", requestedModel: "porter-review", errorKind: "guardrail_violation", errorStatus: 400 });
    const { container } = render(<RunTimeline detail={detail("held_guardrail", [triageOk(), held], { reply: HELD_REPLY })} />);
    expect(text(container)).not.toContain("0 answer tokens");
    expect(text(container)).toContain("A later call was held at the gateway.");
  });

  it("renders an output-check hold apart from a gateway hold", () => {
    const check = step({
      role: "output_check",
      errorKind: "output_blocked",
      guardrails: [{ profile: "output_check", mode: "block", valid: false, score: null, status: "evaluated", reason: "link_not_allowed" }],
    });
    const { container } = render(<RunTimeline detail={detail("held_guardrail", [triageOk(), check], { reply: HELD_REPLY })} />);
    const all = text(container);
    expect(all).toContain("Held by Porter’s output check");
    expect(all).toContain("in Porter, no model call");
    expect(all).not.toContain("0 answer tokens");
    expect(all).toContain(HELD_REPLY);
  });

  it("renders a budget refusal with the fixed reply and its reset time", () => {
    const refused = step({ role: "triage", requestedModel: "porter-triage", errorKind: "budget_exceeded", errorStatus: 403 });
    const { container } = render(<RunTimeline detail={detail("refused_budget", [refused], { reply: BUDGET_REPLY })} />);
    const all = text(container);
    expect(screen.getByText("Refused: budget")).toBeTruthy();
    expect(all).toContain("refused here");
    expect(all).toContain("Refused by the author’s budget");
    expect(all).toContain("resets in about 3 h 12 min");
  });

  it("renders a blocked author and a funds stop", () => {
    const blocked = render(<RunTimeline detail={detail("blocked_author", [step({ role: "triage", errorKind: "end_user_blocked", errorStatus: 403 })])} />);
    expect(text(blocked.container)).toContain("Refused: the author is blocked");
    cleanup();
    const funds = render(<RunTimeline detail={detail("refused_funds", [step({ role: "triage", errorKind: "insufficient_funds", errorStatus: 402 })])} />);
    expect(text(funds.container)).toContain("Stopped: Porter’s balance is low");
  });

  it("renders a failed run with its last error and nothing posted", () => {
    const failed = [
      step({ role: "triage", requestedModel: "porter-triage", errorKind: "upstream", errorStatus: 503 }),
      step({ role: "triage", requestedModel: "porter-triage", errorKind: "upstream", errorStatus: 502 }),
    ];
    const { container } = render(<RunTimeline detail={detail("failed", failed)} />);
    const all = text(container);
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    expect(all).toContain("Nothing was posted. Last error: Provider error after fallback (502).");
    expect(all).toContain("did not complete");
  });

  it("marks the tier-down model and a fallback on the step", () => {
    const tier = triageOk({ servedModel: "deepseek/deepseek-v4-flash-0731", fallback: true, attemptCount: 2 });
    const { container } = render(<RunTimeline detail={detail("answered", [tier], { reply: "ok" })} />);
    expect(text(container)).toContain("tier-down");
    expect(text(container)).toContain("fallback · attempt 2");
  });
});
