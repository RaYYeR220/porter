import { describe, expect, it, vi } from "vitest";
import { endUserIdForLogin } from "../../lib/github/ids";
import { applyProposal, executeCommand, parseCommand, rejectProposal } from "../../lib/github/commands";
import type { ProposalStore, StoredProposal } from "../../lib/github/commands";

describe("parseCommand", () => {
  it("parses approve with and without an id", () => {
    expect(parseCommand("/porter approve 12")).toEqual({ cmd: "approve", arg: "12" });
    expect(parseCommand("/porter approve")).toEqual({ cmd: "approve", arg: "" });
    expect(parseCommand("  /porter   reject #7  ")).toEqual({ cmd: "reject", arg: "7" });
  });
  it("parses upgrade/block with a login, @ stripped", () => {
    expect(parseCommand("/porter upgrade @alice")).toEqual({ cmd: "upgrade", arg: "alice" });
    expect(parseCommand("/porter block mallory-1")).toEqual({ cmd: "block", arg: "mallory-1" });
  });
  it("only reads the first line", () => {
    expect(parseCommand("/porter approve 3\nthanks!")).toEqual({ cmd: "approve", arg: "3" });
    expect(parseCommand("hello\n/porter approve 3")).toBeNull();
  });
  it("returns null for garbage", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("/porter")).toBeNull();
    expect(parseCommand("/porter dance")).toBeNull();
    expect(parseCommand("/porter approve abc")).toBeNull();
    expect(parseCommand("/porter upgrade")).toBeNull();
    expect(parseCommand("/porter upgrade @a b")).toBeNull();
    expect(parseCommand("/porter block @bad_login!")).toBeNull();
    expect(parseCommand("please /porter approve 1")).toBeNull();
  });
});

function fakeStore(seed: Partial<StoredProposal> = {}) {
  const row: StoredProposal & { decided: boolean; execution?: unknown } = {
    id: 5,
    runId: "11111111-1111-1111-1111-111111111111",
    repo: "RaYYeR220/porter-demo",
    action: "add_labels",
    args: { repo: "RaYYeR220/porter-demo", issue_number: 12, labels: ["bug"] },
    status: "pending",
    decided: false,
    ...seed,
  };
  const store: ProposalStore = {
    load: async (id) => (id === row.id ? row : null),
    latestPending: async () => (row.status === "pending" ? row : null),
    claim: async () => {
      if (row.status !== "pending" || row.decided) return false;
      row.decided = true;
      return true;
    },
    release: async () => {
      row.decided = false;
    },
    finish: async (_id, status, execution) => {
      row.status = status;
      row.execution = execution;
    },
  };
  return { store, row };
}

function fakeMcp(over: { execute?: () => Promise<unknown>; tools?: () => Promise<unknown> } = {}) {
  const execute = vi.fn(over.execute ?? (async () => ({ content: [{ type: "text", text: "ok" }] })));
  const tools = vi.fn(over.tools ?? (async () => ({ tools: [], server_revision: "rev-9" })));
  return { otari: { mcp: { tools, execute } } as never, execute, tools };
}

describe("applyProposal", () => {
  it("executes through otari.mcp.execute with the proposal id as the execution id", async () => {
    const { store, row } = fakeStore();
    const m = fakeMcp();
    const r = await applyProposal(5, "gh:owner", { store, otari: m.otari, mcpServerId: "srv-1" });
    expect(r).toEqual({ status: "executed" });
    expect(m.tools).toHaveBeenCalledWith("srv-1");
    expect(m.execute).toHaveBeenCalledWith({
      serverId: "srv-1",
      toolName: "add_labels",
      arguments: row.args,
      serverRevision: "rev-9",
      clientExecutionId: "5",
      conversationId: "run-11111111-1111-1111-1111-111111111111",
    });
    expect(row.status).toBe("executed");
    expect(row.execution).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("records failure and never retries an execute", async () => {
    const { store, row } = fakeStore();
    const m = fakeMcp({ execute: async () => Promise.reject(new Error("boom")) });
    const r = await applyProposal(5, "gh:owner", { store, otari: m.otari, mcpServerId: "srv-1" });
    expect(r.status).toBe("failed");
    expect(m.execute).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("failed");
    expect(JSON.stringify(row.execution)).toContain("boom");
  });

  it("marks a tool-reported error as failed", async () => {
    const { store, row } = fakeStore();
    const m = fakeMcp({ execute: async () => ({ isError: true, content: [] }) });
    expect((await applyProposal(5, "gh:o", { store, otari: m.otari, mcpServerId: "s" })).status).toBe("failed");
    expect(row.status).toBe("failed");
  });

  it("keeps the proposal pending when no MCP server is configured", async () => {
    const { store, row } = fakeStore();
    const m = fakeMcp();
    const r = await applyProposal(5, "gh:o", { store, otari: m.otari, mcpServerId: null });
    expect(r).toMatchObject({ status: "pending", error: expect.stringContaining("OTARI_MCP_SERVER_ID") });
    expect(m.execute).not.toHaveBeenCalled();
    expect(row.status).toBe("pending");
  });

  it("releases the claim when the revision lookup fails (nothing executed)", async () => {
    const { store, row } = fakeStore();
    const m = fakeMcp({ tools: async () => Promise.reject(new Error("net")) });
    const r = await applyProposal(5, "gh:o", { store, otari: m.otari, mcpServerId: "s" });
    expect(r.status).toBe("pending");
    expect(row.status).toBe("pending");
    expect(row.decided).toBe(false);
    expect(m.execute).not.toHaveBeenCalled();
  });

  it("does not run twice", async () => {
    const { store } = fakeStore();
    const m = fakeMcp();
    const deps = { store, otari: m.otari, mcpServerId: "s" };
    await applyProposal(5, "gh:o", deps);
    expect(await applyProposal(5, "gh:o", deps)).toEqual({ status: "not_pending" });
    expect(m.execute).toHaveBeenCalledTimes(1);
  });

  it("reports unknown ids", async () => {
    const { store } = fakeStore();
    expect(await applyProposal(99, "gh:o", { store, otari: fakeMcp().otari, mcpServerId: "s" })).toEqual({ status: "not_found" });
  });
});

describe("rejectProposal / executeCommand", () => {
  const ctx = { repo: "RaYYeR220/porter-demo", issueNumber: 12, actor: "owner" };

  it("reject marks it rejected without calling Otari", async () => {
    const { store, row } = fakeStore();
    expect(await rejectProposal(5, "gh:owner", store)).toBe("rejected");
    expect(row.status).toBe("rejected");
  });

  it("approve with no id takes the issue's latest pending proposal", async () => {
    const { store, row } = fakeStore();
    const m = fakeMcp();
    const text = await executeCommand({ cmd: "approve", arg: "" }, ctx, {
      store, otari: m.otari, mcpServerId: "s", strangers: { endUsers: {} as never }, regularBudgetId: () => "b",
    });
    expect(text).toContain("#5");
    expect(row.status).toBe("executed");
  });

  it("approve refuses a proposal of another repository", async () => {
    const { store, row } = fakeStore({ repo: "other/repo" });
    const m = fakeMcp();
    const text = await executeCommand({ cmd: "approve", arg: "5" }, ctx, {
      store, otari: m.otari, mcpServerId: "s", strangers: { endUsers: {} as never }, regularBudgetId: () => "b",
    });
    expect(text).toContain("different repository");
    expect(m.execute).not.toHaveBeenCalled();
    expect(row.status).toBe("pending");
  });

  it("upgrade PUTs the regular budget, block PATCHes blocked:true, via the stranger service", async () => {
    const put = vi.fn(async () => ({}));
    const patch = vi.fn(async () => ({}));
    const { store } = fakeStore();
    const deps = { store, otari: fakeMcp().otari, mcpServerId: "s", strangers: { endUsers: { put, patch } as never }, regularBudgetId: () => "budget-regular" };
    expect(await executeCommand({ cmd: "upgrade", arg: "alice" }, ctx, deps)).toContain("@alice");
    expect(put).toHaveBeenCalledWith("gh:alice", "budget-regular");
    expect(await executeCommand({ cmd: "block", arg: "mallory" }, ctx, deps)).toContain("@mallory");
    expect(patch).toHaveBeenCalledWith("gh:mallory", { blocked: true });
  });

  it("block/upgrade of a differently-cased login hit the same end-user id as the run", async () => {
    const put = vi.fn(async () => ({}));
    const patch = vi.fn(async () => ({}));
    const { store } = fakeStore();
    const deps = { store, otari: fakeMcp().otari, mcpServerId: "s", strangers: { endUsers: { put, patch } as never }, regularBudgetId: () => "b" };
    const runId = endUserIdForLogin("Mallory");
    await executeCommand({ cmd: "block", arg: "mallory" }, ctx, deps);
    await executeCommand({ cmd: "upgrade", arg: "MALLORY" }, ctx, deps);
    expect(patch).toHaveBeenCalledWith(runId, { blocked: true });
    expect(put).toHaveBeenCalledWith(runId, "b");
    expect(runId).toBe("gh:mallory");
  });

  it("a failing Otari call yields a fixed failure text, not the error", async () => {
    const { store } = fakeStore();
    const put = vi.fn(async () => Promise.reject(new Error("secret detail")));
    const text = await executeCommand({ cmd: "upgrade", arg: "alice" }, ctx, {
      store, otari: fakeMcp().otari, mcpServerId: "s", strangers: { endUsers: { put } as never }, regularBudgetId: () => "b",
    });
    expect(text).not.toContain("secret detail");
  });
});
