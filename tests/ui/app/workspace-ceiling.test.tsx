// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCeiling } from "../../../components/app/WorkspaceCeiling";
import type { Ceiling } from "../../../components/app/types";

const HOSTED: Ceiling = {
  remainingUsd: 0.67,
  limitUsd: null,
  usedUsd: 0.33,
  resetsAt: "2026-11-10T00:00:00.000Z",
  scope: "workspace",
  enforced: true,
};

function stub(status: number, body: unknown) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return urls;
}

const fact = (term: string) => screen.getByText(term).parentElement?.querySelector("dd")?.textContent;

describe("WorkspaceCeiling", () => {
  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T21:00:00Z"));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows what is left today and when it resets, in UTC, from one read", async () => {
    const urls = stub(200, { ceiling: HOSTED });
    render(<WorkspaceCeiling />);
    expect(await screen.findByText("$0.67")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Workspace ceiling" })).toBeTruthy();
    expect(fact("Left today")).toBe("$0.67");
    expect(fact("Spent today")).toBe("$0.33");
    expect(fact("Resets")).toContain("10 Nov, 00:00 UTC");
    expect(fact("Resets")).toContain("in 3 h");
    expect(urls).toEqual(["/api/ceiling"]);
  });

  it("names the limit when the gateway reports one", async () => {
    stub(200, { ceiling: { ...HOSTED, limitUsd: 1, remainingUsd: 0.25, usedUsd: 0.75 } });
    render(<WorkspaceCeiling />);
    await screen.findByText("$0.25");
    expect(fact("Left today")).toBe("$0.25 of $1.00");
  });

  it("says when budgets are not enforced on the key", async () => {
    stub(200, { ceiling: { ...HOSTED, enforced: false } });
    render(<WorkspaceCeiling />);
    expect(await screen.findByText(/not enforced/)).toBeTruthy();
  });

  it("fails soft: unavailable, no figures", async () => {
    stub(503, { error: "unavailable" });
    const { container } = render(<WorkspaceCeiling />);
    expect(await screen.findByText(/Unavailable right now/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\$\d/);
  });
});
