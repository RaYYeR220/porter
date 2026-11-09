// @vitest-environment jsdom
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { buildEvalFile } from "../../eval/harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, stubReducedMotion } from "./canvas-stub";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import Home from "../../app/page";

describe("landing page", () => {
  let canvas: ReturnType<typeof stubCanvas>;
  beforeEach(() => {
    canvas = stubCanvas();
    stubReducedMotion(true);
  });
  afterEach(() => {
    cleanup();
    canvas.restore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("leads with the claim, both calls to action and the proof line", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_REPO", "");
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("A front desk strangers can’t talk their way past.");
    expect(screen.getByText(/^Porter answers GitHub issues/).textContent?.replace(/\s+/g, " ")).toBe(
      "Porter answers GitHub issues from strangers on open-weight models through Otari. Every issue is screened at the " +
        "gateway before the answering model sees it, every author gets their own budget, and nothing gets labelled or " +
        "closed until you approve it.",
    );
    expect(screen.getByRole("link", { name: /Open a test issue/ }).getAttribute("href")).toBe("/try");
    expect(screen.getByRole("link", { name: "Try it without an account" }).getAttribute("href")).toBe("/try");
    const proof = screen.getByText("Running on otari.ai").parentElement as HTMLElement;
    expect(proof.textContent?.replace(/\s+/g, " ")).toBe("Running on otari.ai · deepseek-v4.1-flash · Qwen3Guard · Llama Guard 4 · Qwen3-Embedding");
    expect(screen.getByRole("img", { name: /gateway line/ })).toBeTruthy();
  });

  it("states one measured result under the proof line, labelled post-hoc, read from the results files", () => {
    const dir = mkdtempSync(join(tmpdir(), "porter-landing-"));
    vi.stubEnv("PORTER_RESULTS_DIR", dir);
    const cases = (arm: "porter" | "baseline", hijacked: number) =>
      buildEvalFile(
        arm,
        "attacks",
        Array.from({ length: 4 }, (_, i) => ({
          id: `atk-${i}`, set: "attacks" as const, arm, status: "answered", hijacked: i < hijacked, falseBlock: false,
          blocked_at: i < hijacked ? null : arm === "porter" && i < 3 ? ("gateway_guardrail" as const) : ("model_refused" as const),
          inconclusive: false, reason: "", cost_usd: 0, latency_ms: 0, run_id: "r",
          goal: { kind: "reply_canary" as const, canary: "X" },
        })),
        null,
      );
    render(<Home />);
    expect(document.querySelector(".proof-measured")).toBeNull();
    cleanup();
    writeFileSync(join(dir, "eval-porter-attacks-small-model.json"), JSON.stringify(cases("porter", 0)));
    writeFileSync(join(dir, "eval-baseline-attacks-small-model.json"), JSON.stringify(cases("baseline", 2)));
    render(<Home />);
    const line = document.querySelector<HTMLElement>(".proof-measured")!;
    expect(line.textContent?.replace(/\s+/g, " ")).toBe(
      "Post-hoc, not pre-registered: on a smaller open-weight model, a prompt-only bot leaked attacker text in 2 of 4 replies; Porter let 0 through. How it was measured",
    );
    expect(within(line).getByRole("link", { name: "How it was measured" }).getAttribute("href")).toBe("/eval");
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends 'Open a test issue' to the demo repo when it is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_REPO", "RaYYeR220/porter-demo");
    render(<Home />);
    expect(screen.getByRole("link", { name: /Open a test issue/ }).getAttribute("href")).toBe(
      "https://github.com/RaYYeR220/porter-demo/issues/new",
    );
  });

  it("explains the mechanism as three verbs, then what runs on Otari", () => {
    render(<Home />);
    const how = screen.getByRole("region", { name: /Strangers can type anything/ });
    expect(within(how).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Hold", "Answer", "Approve"]);
    // a hold spends no answer tokens; the guard's own classifiers still run, and the page says so
    expect(how.textContent).toContain("held · 0 answer tokens · screened by Qwen3Guard + gpt-oss-safeguard");
    expect(how.textContent).toContain("spends nothing from its author’s budget");
    expect(how.textContent).not.toMatch(/· 0 tokens/);
    const runs = screen.getByRole("region", { name: "What runs where" });
    const terms = [...runs.querySelectorAll("dt")].map((d) => d.textContent);
    expect(terms).toEqual([
      "Per-author budgets",
      "Guardrails at the gateway",
      "Read-only tools for strangers",
      "Sandbox repro",
      "Web fetch",
      "Routing with fallback",
      "Open-weight models, one job each",
    ]);
    // the reviewer writes the reply, and the guard runs three classifiers (two for injection, one for harm)
    const models = [...runs.querySelectorAll("dd")].at(-1)?.textContent ?? "";
    expect(models).toContain(
      "One model triages, another writes the reply from the evidence, one reproduces bugs, three screen the input (two for injection, one for harm) and one finds duplicates.",
    );
    expect(models).not.toMatch(/two check the input/);
    // the "How it works" link in the nav lands here
    expect(document.getElementById("how")).toBe(how);
  });
});
