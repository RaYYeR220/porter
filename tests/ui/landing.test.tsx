// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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
    expect(screen.getByRole("link", { name: /Open a test issue/ }).getAttribute("href")).toBe("/try");
    expect(screen.getByRole("link", { name: "Try it without an account" }).getAttribute("href")).toBe("/try");
    const proof = screen.getByText("Running on otari.ai").parentElement as HTMLElement;
    expect(proof.textContent?.replace(/\s+/g, " ")).toBe("Running on otari.ai · gpt-oss-120b · Qwen3Guard · Llama Guard 4 · Qwen3-Embedding");
    expect(screen.getByRole("img", { name: /gateway line/ })).toBeTruthy();
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
    // the "How it works" link in the nav lands here
    expect(document.getElementById("how")).toBe(how);
  });
});
