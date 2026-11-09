// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Console } from "../../../app/console/Console";
import { usePoll } from "../../../components/app/usePoll";
import type { Proposal, RunRow } from "../../../components/app/types";

const id = (n: number) => `0b6a3c8e-5d1f-4c2a-9e7b-2f4d6a8c0e${String(n).padStart(2, "0")}`;

const run = (n: number, over: Partial<RunRow> = {}): RunRow => ({
  id: id(n),
  source: "github",
  arm: "porter",
  repo: "acme/widgets",
  issueNumber: n,
  authorExternalId: "gh:octocat",
  title: `Issue ${n}`,
  status: "answered",
  totalCostUsd: 0.0012,
  createdAt: new Date(Date.UTC(2026, 10, 8, 10, 0, 60 - n)).toISOString(),
  finishedAt: null,
  servedModel: "deepseek/deepseek-v4.1-flash-1017",
  pendingProposals: 0,
  heldBy: null,
  ...over,
});

const RUNS: RunRow[] = [
  run(1, { pendingProposals: 2 }),
  run(2, { servedModel: "deepseek/deepseek-v4-flash-0731" }),
  run(3, { status: "held_guardrail", servedModel: null, heldBy: "gateway" }),
  run(4, { status: "held_guardrail", heldBy: "output" }),
  run(5, { status: "held_guardrail", servedModel: null, heldBy: "gateway" }),
  run(6, { status: "refused_budget", servedModel: null }),
];

const PROPOSAL: Proposal = {
  id: 7,
  runId: id(1),
  action: "add_labels",
  args: { repo: "acme/widgets", issue_number: 1, labels: ["bug"] },
  status: "pending",
  execution: null,
  createdAt: "2026-11-08T10:00:00.000Z",
  decidedAt: null,
  repo: "acme/widgets",
  issueNumber: 1,
  title: "Issue 1",
};

function stubApi() {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.startsWith("/api/runs?")
        ? { runs: RUNS, nextCursor: null }
        : url.startsWith("/api/proposals?")
          ? { proposals: [PROPOSAL] }
          : url === "/api/authors"
            ? { authors: [] }
            : url === "/api/ceiling"
              ? { ceiling: { remainingUsd: 0.67, limitUsd: null, usedUsd: 0.33, resetsAt: "2026-11-10T00:00:00.000Z", scope: "workspace", enforced: true } }
              : { error: "not_found" };
      return new Response(JSON.stringify(body), { status: body && "error" in body ? 404 : 200 });
    }),
  );
  return urls;
}

describe("console cold load", () => {
  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders queue, scoreboard, ceiling and proposals from four reads, with no run details", async () => {
    const urls = stubApi();
    render(<Console />);
    await screen.findByRole("link", { name: "Issue 6" });
    await screen.findByText("Add a label to #1");
    await screen.findByText("No authors yet.");
    await screen.findByText("$0.67");

    expect(urls).toHaveLength(4);
    expect(urls.map((u) => u.split("?")[0]).sort()).toEqual(["/api/authors", "/api/ceiling", "/api/proposals", "/api/runs"]);
    expect(urls.some((u) => /^\/api\/runs\/[0-9a-f-]{36}/.test(u))).toBe(false);
    expect(urls.find((u) => u.startsWith("/api/proposals"))).toBe("/api/proposals?status=pending&limit=50");

    // the queue's model column and marks come from the list itself
    expect(screen.getAllByText("deepseek-v4.1-flash-1017").length).toBeGreaterThan(0);
    expect(screen.getByText("deepseek-v4-flash-0731").className).toBe("is-tier");
    expect(screen.getByText("2 waiting for approval")).toBeTruthy();

    // the scoreboard splits holds by heldBy
    const cell = (label: string) => screen.getByText(label).parentElement?.querySelector("dd")?.textContent;
    expect(cell("held at the gateway")).toBe("2");
    expect(cell("held by the output check")).toBe("1");
    expect(cell("refused by budget")).toBe("1");
    expect(cell("answered")).toBe("2");
    expect(screen.getByText("Last 6 runs")).toBeTruthy();

    // the proposal links to its run by the issue title
    const propLink = document.querySelector(".prop-run") as HTMLAnchorElement;
    expect(propLink.textContent).toBe("Issue 1");
    expect(propLink.getAttribute("href")).toBe(`/console/runs/${id(1)}`);
  });
});

describe("console queue scope", () => {
  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const SHADOW = run(20, { source: "shadow", repo: "mozilla-ai/otari", title: "Shadow issue", issueNumber: 120 });
  const EVAL = run(21, { source: "eval", repo: "porter-shadow/widgets", title: "Eval case", issueNumber: null });

  function stubScoped() {
    const runUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        let body: unknown;
        if (url.startsWith("/api/runs?")) {
          runUrls.push(url);
          const source = new URLSearchParams(url.split("?")[1]).get("source");
          body = { runs: source === null ? [SHADOW, EVAL, ...RUNS] : RUNS, nextCursor: null };
        } else if (url.startsWith("/api/proposals?")) body = { proposals: [] };
        else if (url === "/api/authors") body = { authors: [] };
        return new Response(JSON.stringify(body ?? { error: "not_found" }), { status: body ? 200 : 404 });
      }),
    );
    return runUrls;
  }

  it("lists the demo repository and the try page by default, and shadow and eval runs on request", async () => {
    const runUrls = stubScoped();
    render(<Console />);
    await screen.findByRole("link", { name: "Issue 6" });
    expect(runUrls[0]).toBe("/api/runs?limit=50&source=github%2Cweb");
    expect(screen.queryByRole("link", { name: "Shadow issue" })).toBeNull();
    expect(screen.getByText("Last 6 runs")).toBeTruthy();

    const toggle = screen.getByRole("checkbox", { name: "Include shadow and eval runs" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await screen.findByRole("link", { name: "Shadow issue" });
    expect(screen.getByRole("link", { name: "Eval case" })).toBeTruthy();
    expect(runUrls[runUrls.length - 1]).toBe("/api/runs?limit=50");
    expect(toggle.checked).toBe(true);
    expect(screen.getByText("Last 8 runs")).toBeTruthy();

    fireEvent.click(toggle);
    await screen.findByText("Last 6 runs");
    expect(screen.queryByRole("link", { name: "Shadow issue" })).toBeNull();
    expect(runUrls[runUrls.length - 1]).toBe("/api/runs?limit=50&source=github%2Cweb");
  });
});

describe("usePoll", () => {
  let state: DocumentVisibilityState = "visible";
  beforeEach(() => {
    vi.useFakeTimers();
    state = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("refreshes at once when the tab comes back, and not while it is hidden", async () => {
    const fn = vi.fn();
    renderHook(() => usePoll(fn, 15_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    state = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    state = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fn).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("console proposal decisions", () => {
  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("after an approve, reads that one run to show what the maintainer key's tool call returned", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(`${init?.method ?? "GET"} ${url}`);
        let body: unknown;
        if (url.startsWith("/api/runs?")) body = { runs: RUNS, nextCursor: null };
        else if (url.startsWith("/api/proposals?")) body = { proposals: [PROPOSAL] };
        else if (url === "/api/authors") body = { authors: [] };
        else if (url === "/api/proposals/7") body = { ok: true, status: "executed" };
        else if (url === `/api/runs/${id(1)}`)
          body = { run: {}, steps: [], guardVerdicts: [], proposals: [{ ...PROPOSAL, status: "executed", execution: { content: [{ type: "text", text: "Labels on #1: bug" }] } }] };
        return new Response(JSON.stringify(body ?? { error: "not_found" }), { status: body ? 200 : 404 });
      }),
    );
    render(<Console />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Labels on #1: bug")).toBeTruthy();
    expect(screen.getByText(/Executed with the maintainer key/)).toBeTruthy();
    const details = urls.filter((u) => /^GET \/api\/runs\/[0-9a-f-]{36}$/.test(u));
    expect(details).toEqual([`GET /api/runs/${id(1)}`]);
    expect(urls).toContain("POST /api/proposals/7");
  });
});
