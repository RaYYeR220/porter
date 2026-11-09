// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StepCard } from "../../../components/app/StepCard";
import { step } from "./fixtures";

const repro = (toolCalls: unknown) =>
  step({ role: "repro", requestedModel: "porter-repro", servedModel: "qwen/qwen3-coder", provider: "together", costUsd: 0.0011, durationMs: 4200, toolCalls });

const CHIP = /ran in the sandbox/;

describe("StepCard", () => {
  afterEach(cleanup);

  it("shows the sandbox chip, the code and its real output when Otari recorded a code_execution run", () => {
    const s = repro([{ type: "code_execution", code: "print(1+1)", stdout: "2\n", stderr: "", exit_code: 0, truncated: false }]);
    const { container } = render(<StepCard step={s} index={2} />);
    expect(screen.getByText(CHIP).textContent).toBe("ran in the sandbox · exit 0");
    expect(container.textContent).toContain("print(1+1)");
    expect(container.textContent).toContain("exit 0");
  });

  it("shows sandbox stdout and stderr without terminal colour codes, as a terminal would", () => {
    const red = (s: string) => `\u001b[31m${s}\u001b[0m`;
    const s = repro([{ type: "code_execution", code: "print('\\u001b[31m')", stdout: red("ERROR: no match"), stderr: red("Traceback"), exit_code: 1 }]);
    render(<StepCard step={s} index={2} />);
    expect(screen.getByLabelText("stdout").textContent).toBe("ERROR: no match");
    expect(screen.getByLabelText("stderr").textContent).toBe("Traceback");
    // the code is what the model wrote: shown as written
    expect(screen.getByLabelText("Code").textContent).toBe("print('\\u001b[31m')");
  });

  it("shows no sandbox chip without a real code_execution entry", () => {
    const cases: unknown[] = [
      null,
      [],
      // the model's own account of running the code is not proof
      [{ type: "mcp", name: "read_file", output: "I ran it: exit code 0" }],
      // an execution entry with no exit code is not proof either
      [{ type: "code_execution", code: "print(1)", stdout: "", stderr: "", exit_code: null }],
      [{ type: "code_execution", code: "print(1)", stdout: "1", exit_code: "0" }],
    ];
    for (const calls of cases) {
      render(<StepCard step={repro(calls)} index={1} />);
      expect(screen.queryByText(CHIP)).toBeNull();
      cleanup();
    }
  });

  it("shows the routing policy, the served model and provider, cost, latency and a copyable request id", () => {
    const s = step({
      role: "triage",
      requestedModel: "porter-triage",
      servedModel: "deepseek/deepseek-v4.1-flash-1017",
      provider: "groq",
      costUsd: 0.00042,
      durationMs: 2140,
      requestId: "req_abc123",
    });
    const { container } = render(<StepCard step={s} index={1} />);
    expect(container.textContent).toContain("porter-triage");
    expect(container.textContent).toContain("deepseek/deepseek-v4.1-flash-1017");
    expect(container.textContent).toContain("groq");
    expect(container.textContent).toContain("$0.0004");
    expect(container.textContent).toContain("2.1 s");
    expect(screen.getByRole("button", { name: "Copy Otari request id" })).toBeTruthy();
    expect(container.textContent).toContain("req_abc123");
  });

  it("lists MCP tool names with cut output, fetched URLs and struck claims", () => {
    const s = step({
      role: "triage",
      requestedModel: "porter-triage",
      servedModel: "deepseek/deepseek-v4.1-flash-1017",
      toolCalls: [
        { type: "mcp", server: "porter-repo", name: "search_issues", status: "ok", output: "x".repeat(900) },
        { id: "otari_wf_1", type: "web_fetch", status: "ok", url: "https://docs.example.org/export" },
        { type: "struck_claims", claims: ["fixed in 2.1"] },
      ],
    });
    const { container } = render(<StepCard step={s} index={1} />);
    expect(container.textContent).toContain("search_issues");
    expect(container.textContent).toContain("Showing the first 600 of 900 characters.");
    expect(container.textContent).toContain("https://docs.example.org/export");
    expect(container.textContent).toContain("fixed in 2.1");
  });

  it("says no model served for a refused call, but never for one that may have been served", () => {
    render(<StepCard step={step({ role: "triage", requestedModel: "porter-triage", errorKind: "guardrail_violation", errorStatus: 400 })} index={1} />);
    expect(screen.getByText("no model served")).toBeTruthy();
    cleanup();
    render(<StepCard step={step({ role: "triage", requestedModel: "porter-triage", errorKind: "timeout" })} index={1} />);
    expect(screen.queryByText("no model served")).toBeNull();
    expect(screen.getByText("Timed out waiting for the gateway")).toBeTruthy();
  });

  it("shows no cost or latency for Porter's own output check", () => {
    const s = step({ role: "output_check", guardrails: [{ profile: "output_check", mode: "block", valid: true, score: null, status: "evaluated" }] });
    const { container } = render(<StepCard step={s} index={4} />);
    expect(container.textContent).toContain("in Porter, no model call");
    expect(container.querySelector(".sc-figs")).toBeNull();
    expect(container.textContent).not.toContain("score");
  });

  it("summarises tools in compact mode", () => {
    const s = step({
      role: "triage",
      toolCalls: [
        { type: "mcp", name: "search_issues", output: "[]" },
        { type: "mcp", name: "get_issue", output: "{}" },
      ],
    });
    const { container } = render(<StepCard step={s} index={1} mode="compact" />);
    expect(container.textContent).toContain("2 tool calls: search_issues, get_issue");
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
  });
});
