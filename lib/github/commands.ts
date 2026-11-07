import { and, desc, eq, isNull } from "drizzle-orm";
import { db as defaultDb } from "../db/client";
import { proposals, runs } from "../db/schema";
import type { OtariClient } from "../otari/client";

export type Command = { cmd: "approve" | "reject" | "upgrade" | "block"; arg: string };

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * `/porter approve [id]`, `/porter reject [id]`, `/porter upgrade @user`, `/porter block @user`.
 * Only the first line counts. approve/reject arg is "" (latest pending) or a proposal id;
 * upgrade/block arg is the login without the @. Anything else is null.
 */
export function parseCommand(text: string): Command | null {
  const first = (text ?? "").trim().split(/\r?\n/, 1)[0].trim();
  const m = /^\/porter\s+(approve|reject|upgrade|block)(?:\s+(\S+))?\s*$/i.exec(first);
  if (!m) return null;
  const cmd = m[1].toLowerCase() as Command["cmd"];
  const raw = m[2] ?? "";
  if (cmd === "approve" || cmd === "reject") {
    const id = raw.replace(/^#/, "");
    if (id !== "" && !/^\d{1,9}$/.test(id)) return null;
    return { cmd, arg: id };
  }
  const login = raw.replace(/^@/, "");
  return LOGIN_RE.test(login) ? { cmd, arg: login } : null;
}

export type StoredProposal = {
  id: number;
  runId: string;
  repo: string;
  action: string;
  args: Record<string, unknown>;
  status: string;
};

export interface ProposalStore {
  load(id: number): Promise<StoredProposal | null>;
  /** Latest pending proposal of an issue. */
  latestPending(repo: string, issueNumber: number): Promise<StoredProposal | null>;
  /** Atomically takes a pending, undecided proposal. False when someone else got it. */
  claim(id: number, decidedBy: string): Promise<boolean>;
  release(id: number): Promise<void>;
  finish(id: number, status: "executed" | "failed" | "rejected", execution: unknown): Promise<void>;
}

export function drizzleProposalStore(getDb = defaultDb): ProposalStore {
  const select = () =>
    getDb()
      .select({ id: proposals.id, runId: proposals.runId, repo: runs.repo, action: proposals.action, args: proposals.args, status: proposals.status })
      .from(proposals)
      .innerJoin(runs, eq(runs.id, proposals.runId));
  const shape = (r: { id: number; runId: string; repo: string; action: string; args: unknown; status: string }): StoredProposal => ({
    ...r,
    args: (r.args ?? {}) as Record<string, unknown>,
  });
  return {
    async load(id) {
      const [r] = await select().where(eq(proposals.id, id)).limit(1);
      return r ? shape(r) : null;
    },
    async latestPending(repo, issueNumber) {
      const [r] = await select()
        .where(and(eq(runs.repo, repo), eq(runs.issueNumber, issueNumber), eq(proposals.status, "pending")))
        .orderBy(desc(proposals.id))
        .limit(1);
      return r ? shape(r) : null;
    },
    async claim(id, decidedBy) {
      const got = await getDb()
        .update(proposals)
        .set({ decidedBy, decidedAt: new Date() })
        .where(and(eq(proposals.id, id), eq(proposals.status, "pending"), isNull(proposals.decidedAt)))
        .returning({ id: proposals.id });
      return got.length > 0;
    },
    async release(id) {
      await getDb()
        .update(proposals)
        .set({ decidedBy: null, decidedAt: null })
        .where(and(eq(proposals.id, id), eq(proposals.status, "pending")));
    },
    async finish(id, status, execution) {
      await getDb()
        .update(proposals)
        .set({ status, execution: execution ?? null, decidedAt: new Date() })
        .where(eq(proposals.id, id));
    },
  };
}

export type ApplyResult =
  | { status: "executed" | "failed"; error?: string }
  | { status: "pending"; error: string }
  | { status: "not_found" | "not_pending" };

export type ApplyDeps = {
  store: ProposalStore;
  /** Client on the MAINTAINER key. */
  otari: Pick<OtariClient, "mcp">;
  mcpServerId: string | null;
};

const errMessage = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : "unknown error");

/**
 * Executes a pending proposal through Otari's caller-orchestrated MCP under the maintainer key,
 * never through Octokit. The execute call is not retried (its outcome may be unknown), and the
 * proposal id is the client execution id.
 */
export async function applyProposal(proposalId: number, decidedBy: string, deps: ApplyDeps): Promise<ApplyResult> {
  const p = await deps.store.load(proposalId);
  if (!p) return { status: "not_found" };
  if (p.status !== "pending") return { status: "not_pending" };
  if (!deps.mcpServerId) return { status: "pending", error: "OTARI_MCP_SERVER_ID is not configured; the proposal stays pending" };
  if (!(await deps.store.claim(p.id, decidedBy))) return { status: "not_pending" };

  let revision: string;
  try {
    revision = (await deps.otari.mcp.tools(deps.mcpServerId)).server_revision;
  } catch (e) {
    // Nothing was executed yet: give the proposal back.
    await deps.store.release(p.id);
    return { status: "pending", error: errMessage(e) };
  }
  try {
    const result = await deps.otari.mcp.execute({
      serverId: deps.mcpServerId,
      toolName: p.action,
      arguments: p.args,
      serverRevision: revision,
      clientExecutionId: String(p.id),
      conversationId: `run-${p.runId}`,
    });
    if (result.isError) {
      await deps.store.finish(p.id, "failed", result);
      return { status: "failed", error: "tool reported an error" };
    }
    await deps.store.finish(p.id, "executed", result);
    return { status: "executed" };
  } catch (e) {
    const error = errMessage(e);
    await deps.store.finish(p.id, "failed", { error });
    return { status: "failed", error };
  }
}

export async function rejectProposal(
  proposalId: number,
  decidedBy: string,
  store: ProposalStore,
): Promise<"rejected" | "not_found" | "not_pending"> {
  const p = await store.load(proposalId);
  if (!p) return "not_found";
  if (p.status !== "pending") return "not_pending";
  if (!(await store.claim(p.id, decidedBy))) return "not_pending";
  await store.finish(p.id, "rejected", null);
  return "rejected";
}

export type CommandContext = { repo: string; issueNumber: number; actor: string };
export type CommandDeps = ApplyDeps & {
  /** Client on the stranger service key (end-users API). */
  strangers: Pick<OtariClient, "endUsers">;
  regularBudgetId: () => string;
};

/** Fixed, model-free confirmations. They echo only validated ids and logins. */
export const COMMAND_REPLIES = {
  approved: (id: number) => `Done: proposal #${id} was applied.`,
  failed: (id: number) => `Proposal #${id} could not be applied. The error is recorded on the run.`,
  stillPending: (id: number) => `Proposal #${id} is still pending: the tool server is not available right now.`,
  notFound: "No matching pending proposal for this issue.",
  notPending: (id: number) => `Proposal #${id} is not pending any more.`,
  wrongIssue: (id: number) => `Proposal #${id} belongs to a different repository.`,
  rejected: (id: number) => `Proposal #${id} was rejected. Nothing was changed.`,
  upgraded: (login: string) => `@${login} moved to the regular allowance.`,
  blocked: (login: string) => `@${login} is blocked from automated answers.`,
  commandFailed: "That command could not be completed. Nothing was changed.",
} as const;

/** Runs a parsed command and returns the confirmation text to post. */
export async function executeCommand(c: Command, ctx: CommandContext, deps: CommandDeps): Promise<string> {
  const decidedBy = `gh:${ctx.actor}`;
  try {
    if (c.cmd === "upgrade") {
      await deps.strangers.endUsers.put(`gh:${c.arg}`, deps.regularBudgetId());
      return COMMAND_REPLIES.upgraded(c.arg);
    }
    if (c.cmd === "block") {
      await deps.strangers.endUsers.patch(`gh:${c.arg}`, { blocked: true });
      return COMMAND_REPLIES.blocked(c.arg);
    }
    const target = c.arg === "" ? await deps.store.latestPending(ctx.repo, ctx.issueNumber) : await deps.store.load(Number(c.arg));
    if (!target) return COMMAND_REPLIES.notFound;
    if (target.repo.toLowerCase() !== ctx.repo.toLowerCase()) return COMMAND_REPLIES.wrongIssue(target.id);
    if (c.cmd === "reject") {
      const r = await rejectProposal(target.id, decidedBy, deps.store);
      if (r === "rejected") return COMMAND_REPLIES.rejected(target.id);
      return r === "not_found" ? COMMAND_REPLIES.notFound : COMMAND_REPLIES.notPending(target.id);
    }
    const r = await applyProposal(target.id, decidedBy, deps);
    switch (r.status) {
      case "executed":
        return COMMAND_REPLIES.approved(target.id);
      case "failed":
        return COMMAND_REPLIES.failed(target.id);
      case "pending":
        return COMMAND_REPLIES.stillPending(target.id);
      case "not_found":
        return COMMAND_REPLIES.notFound;
      default:
        return COMMAND_REPLIES.notPending(target.id);
    }
  } catch (e) {
    console.warn(`porter command failed: ${e instanceof Error ? e.name : "error"}`);
    return COMMAND_REPLIES.commandFailed;
  }
}
