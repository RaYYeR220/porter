import { describe, expect, it, vi } from "vitest";
import { DuplicateDeliveryError } from "../../lib/agent/pipeline";
import type { RunOutcome } from "../../lib/agent/pipeline";
import { postReply, RUN_PAGE_BASE } from "../../lib/github/post";
import { processJob, QUEUED_COMMAND_REPLY } from "../../lib/github/webhook";
import type { Route, Services } from "../../lib/github/webhook";
import { ratelimit } from "../../lib/ratelimit";

const writer = () => ({ addLabels: vi.fn(), closeAsDuplicate: vi.fn(), postComment: vi.fn(async () => undefined) });

describe("postReply", () => {
  it("posts once with a run-page footer", async () => {
    const w = writer();
    const queue = vi.fn();
    const r = await postReply("o/r", 3, "Hello", { writer: w, withinLimit: async () => true, queue }, "run-1");
    expect(r).toBe("posted");
    expect(w.postComment).toHaveBeenCalledTimes(1);
    expect(w.postComment.mock.calls[0]).toEqual(["o/r", 3, expect.stringContaining(`${RUN_PAGE_BASE}run-1`)]);
    expect(queue).not.toHaveBeenCalled();
  });

  it("queues the reply with the error class and status when GitHub rejects the post", async () => {
    const w = writer();
    w.postComment.mockRejectedValueOnce(Object.assign(new Error("secret detail"), { status: 502 }));
    const queue = vi.fn(async () => undefined);
    const r = await postReply("o/r", 3, "Hello", { writer: w, withinLimit: async () => true, queue }, "run-1");
    expect(r).toBe("queued");
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", reason: "post_failed", error: { name: "Error", status: 502 } }));
    expect(JSON.stringify(queue.mock.calls)).not.toContain("secret detail");
  });

  it("exempt confirmations skip the limiter", async () => {
    const w = writer();
    const withinLimit = vi.fn(async () => false);
    const r = await postReply("o/r", 3, "ok", { writer: w, withinLimit, queue: vi.fn() }, undefined, { exempt: true });
    expect(r).toBe("posted");
    expect(withinLimit).not.toHaveBeenCalled();
  });

  it("queues instead of posting or dropping when over the limit", async () => {
    const w = writer();
    const queue = vi.fn(async () => undefined);
    const r = await postReply("o/r", 3, "Hello", { writer: w, withinLimit: async () => false, queue }, "run-1");
    expect(r).toBe("queued");
    expect(w.postComment).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ repo: "o/r", issueNumber: 3, runId: "run-1" }));
  });
});

describe("ratelimit", () => {
  const runner = (count: number | null) => async () => (count === null ? [] : [{ count }]);
  it("allows up to the limit and refuses beyond it", async () => {
    expect(await ratelimit("k", 20, 3600, runner(1))).toBe(true);
    expect(await ratelimit("k", 20, 3600, runner(20))).toBe(true);
    expect(await ratelimit("k", 20, 3600, runner(21))).toBe(false);
    expect(await ratelimit("k", 20, 3600, async () => ({ rows: [{ count: "2" }] }))).toBe(true);
  });
  it("throws when the statement returns nothing", async () => {
    await expect(ratelimit("k", 20, 3600, runner(null))).rejects.toThrow();
  });
});

function services(over: Partial<Services> = {}): Services & { post: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(),
    post: vi.fn(async () => "posted" as const),
    command: vi.fn(async () => "done"),
    withinWriteLimit: vi.fn(async () => true),
    releaseDelivery: vi.fn(async () => undefined),
    recordError: vi.fn(async () => undefined),
    ...over,
  } as never;
}

const runRoute: Route = {
  action: "run",
  reason: "issue_opened",
  job: { kind: "run", input: { source: "github", arm: "porter", repo: "o/r", number: 3, title: "t", body: "b", authorExternalId: "gh:a", deliveryId: "d" } },
};
const outcome = (over: Partial<RunOutcome>): RunOutcome => ({ runId: "r1", status: "answered", reply: "hi", proposals: [], ...over });

describe("processJob", () => {
  it("posts the reply of an answered run", async () => {
    const s = services({ run: vi.fn(async () => outcome({})) });
    await processJob(runRoute, "d", s);
    expect(s.post).toHaveBeenCalledWith("o/r", 3, "hi", "r1");
  });

  it("posts nothing for refused_funds or failed runs", async () => {
    for (const status of ["refused_funds", "failed", "blocked_author"] as const) {
      const s = services({ run: vi.fn(async () => outcome({ status, reply: null })) });
      await processJob(runRoute, "d", s);
      expect(s.post).not.toHaveBeenCalled();
    }
  });

  it("posts held replies like any other", async () => {
    const s = services({ run: vi.fn(async () => outcome({ status: "held_guardrail", reply: "held" })) });
    await processJob(runRoute, "d", s);
    expect(s.post).toHaveBeenCalledTimes(1);
  });

  it("a duplicate delivery is a no-op; other failures release the claim", async () => {
    const dup = services({ run: vi.fn(async () => Promise.reject(new DuplicateDeliveryError("d"))) });
    await processJob(runRoute, "d", dup);
    expect(dup.releaseDelivery).not.toHaveBeenCalled();
    expect(dup.post).not.toHaveBeenCalled();
    const boom = services({ run: vi.fn(async () => Promise.reject(new Error("db down"))) });
    await processJob(runRoute, "d", boom);
    expect(boom.releaseDelivery).toHaveBeenCalledWith("d");
  });

  const cmdRoute = (cmd: "approve" | "reject"): Route => ({
    action: "command",
    reason: cmd,
    job: { kind: "command", repo: "o/r", issueNumber: 3, actor: "owner", command: { cmd, arg: "" } },
  });

  it("runs a command and posts its confirmation", async () => {
    const s = services();
    await processJob(cmdRoute("approve"), "d", s);
    expect(s.command).toHaveBeenCalled();
    expect(s.post).toHaveBeenCalledWith("o/r", 3, "done", undefined, { exempt: true });
  });

  it("an approve over the write limit is not executed and says so", async () => {
    const s = services({ withinWriteLimit: vi.fn(async () => false) });
    await processJob(cmdRoute("approve"), "d", s);
    expect(s.command).not.toHaveBeenCalled();
    expect(s.post).toHaveBeenCalledWith("o/r", 3, QUEUED_COMMAND_REPLY, undefined, { exempt: true });
    expect(s.withinWriteLimit).toHaveBeenCalledTimes(1);
  });

  it("a failing job leaves a durable webhook_error trace", async () => {
    const s = services({ command: vi.fn(async () => Promise.reject(new TypeError("x"))) });
    await processJob(cmdRoute("reject"), "d9", s, "issue_comment");
    expect(s.recordError).toHaveBeenCalledWith("d9", "issue_comment", expect.any(TypeError));
  });
});
