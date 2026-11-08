// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorsPanel } from "../../../components/app/AuthorsPanel";
import { ProposalRow } from "../../../components/app/ProposalRow";
import type { Author, Proposal } from "../../../components/app/types";
import { author, RUN_ID } from "./fixtures";

type Reply = { status: number; body: unknown };

/** A fetch that answers GET /api/authors with `list` and every POST with what `post` returns. */
function stubFetch(list: () => Author[], post: (url: string, body: unknown) => Reply | Promise<Reply>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const r = method === "POST" ? await post(url, body) : { status: 200, body: { authors: list() } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const row = (name: string) => screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr") as HTMLElement;

describe("console author actions", () => {
  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("applies a block at once and rolls it back when the gateway call fails", async () => {
    let release!: (r: Reply) => void;
    const calls = stubFetch(
      () => [author()],
      () => new Promise<Reply>((r) => (release = r)),
    );
    render(<AuthorsPanel />);
    await screen.findByText("visitor 5eed…");
    expect(within(row("visitor 5eed")).getByText("active")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Block visitor 5eed…" }));
    // optimistic: blocked before the server answers
    expect(within(row("visitor 5eed")).getByText("blocked")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unblock visitor 5eed…" })).toHaveProperty("disabled", true);

    await act(async () => release({ status: 500, body: { error: "internal" } }));
    await waitFor(() => expect(within(row("visitor 5eed")).getByText("active")).toBeTruthy());
    expect(screen.getByText("Block visitor 5eed… was not applied")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Block visitor 5eed…" })).toHaveProperty("disabled", false);
    expect(calls.filter((c) => c.method === "POST")).toEqual([
      { url: "/api/authors/web%3A5eed000000000001", method: "POST", body: { action: "block" } },
    ]);
  });

  it("explains the hourly limit when the console is rate limited, and keeps the old tier", async () => {
    stubFetch(
      () => [author()],
      () => ({ status: 429, body: { error: "rate_limited" } }),
    );
    render(<AuthorsPanel />);
    await screen.findByText("visitor 5eed…");
    fireEvent.click(screen.getByRole("button", { name: "Upgrade visitor 5eed… to regular" }));
    expect(within(row("visitor 5eed")).getByText("regular")).toBeTruthy();
    await screen.findByText("Upgrade visitor 5eed… was not applied");
    expect(screen.getByText(/limited per address each hour/)).toBeTruthy();
    expect(within(row("visitor 5eed")).getByText("newcomer")).toBeTruthy();
  });

  it("keeps the change and re-reads the meters when the gateway accepts it", async () => {
    let blocked = false;
    const calls = stubFetch(
      () => [author({ blocked })],
      () => {
        blocked = true;
        return { status: 200, body: { ok: true } };
      },
    );
    render(<AuthorsPanel />);
    await screen.findByText("visitor 5eed…");
    fireEvent.click(screen.getByRole("button", { name: "Block visitor 5eed…" }));
    await screen.findByText("visitor 5eed… blocked at the gateway.");
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBe(2));
    expect(within(row("visitor 5eed")).getByText("blocked")).toBeTruthy();
  });

  it("shows an empty state when no stranger has filed anything", async () => {
    stubFetch(
      () => [],
      () => ({ status: 200, body: {} }),
    );
    render(<AuthorsPanel />);
    expect(await screen.findByText("No authors yet.")).toBeTruthy();
  });
});

describe("ProposalRow", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const proposal: Proposal = {
    id: 7,
    runId: RUN_ID,
    action: "add_labels",
    args: { repo: "demo/porter-ui-seed", issue_number: 14, labels: ["bug", "export"] },
    status: "pending",
    decidedBy: null,
    execution: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    decidedAt: null,
  };

  it("approves through the API and reports that the maintainer key ran it", async () => {
    stubFetch(
      () => [],
      () => ({ status: 200, body: { ok: true, status: "executed" } }),
    );
    const onDecided = vi.fn();
    render(
      <ul>
        <ProposalRow proposal={proposal} onDecided={onDecided} />
      </ul>,
    );
    expect(screen.getByText("Add labels to #14")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Executed with the maintainer key")).toBeTruthy();
    expect(onDecided).toHaveBeenCalledWith(7, "executed");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("keeps the proposal pending with a calm notice when approval is rate limited", async () => {
    stubFetch(
      () => [],
      () => ({ status: 429, body: { error: "rate_limited" } }),
    );
    render(
      <ul>
        <ProposalRow proposal={proposal} />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("That’s the limit for this hour")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", false);
  });
});
