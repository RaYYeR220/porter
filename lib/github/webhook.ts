import { verify } from "@octokit/webhooks-methods";
import { DuplicateDeliveryError } from "../agent/pipeline";
import type { IssueInput, RunOutcome } from "../agent/pipeline";
import { parseCommand } from "./commands";
import type { Command } from "./commands";

/** Constant-time HMAC check of the raw body against X-Hub-Signature-256. Never throws. */
export async function verifySignature(rawBody: string, signature256: string | null, secret: string): Promise<boolean> {
  if (!signature256 || !secret) return false;
  try {
    return await verify(secret, rawBody, signature256);
  } catch {
    return false;
  }
}

export type RunJob = { kind: "run"; input: IssueInput };
export type CommandJob = { kind: "command"; repo: string; issueNumber: number; actor: string; command: Command };
export type Job = RunJob | CommandJob;

export type Route = { action: "run" | "command" | "ignore"; reason: string; job?: Job };

export type RouteDeps = {
  /** The App slug; Porter's own comments are `<slug>[bot]`. */
  slug: string;
  /** Atomically records the delivery id. False when it was seen before (redelivery). */
  claimDelivery: (deliveryId: string) => Promise<boolean>;
  /** The repo is a known demo repo with an installation. */
  isDemoRepo: (fullName: string) => Promise<boolean>;
};

const COMMANDERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

type Actor = { login: string; type: string };
type Payload = {
  action?: string;
  repository?: { full_name?: string };
  issue?: { number?: number; title?: string; body?: string | null; user?: Partial<Actor>; pull_request?: unknown };
  comment?: { body?: string | null; user?: Partial<Actor>; author_association?: string };
};

const ignore = (reason: string): Route => ({ action: "ignore", reason });

function isBot(u: Partial<Actor> | undefined, slug: string): boolean {
  if (!u) return false;
  const login = (u.login ?? "").toLowerCase();
  return u.type === "Bot" || login === `${slug.toLowerCase()}[bot]` || login.endsWith("[bot]");
}

function mentions(text: string, slug: string): boolean {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9-])@${escaped}(?![A-Za-z0-9-])`, "i").test(text);
}

/**
 * Decides what a delivery means. Redeliveries are ignored (the claim is the only dedupe for
 * commands and ignored events; runs are also guarded by runs.delivery_id).
 */
export async function routeEvent(name: string, deliveryId: string, payload: unknown, deps: RouteDeps): Promise<Route> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Payload;
  const isIssues = name === "issues" && p.action === "opened";
  const isComment = name === "issue_comment" && p.action === "created";
  if (!isIssues && !isComment) return ignore("unhandled_event");

  const repo = p.repository?.full_name;
  const issue = p.issue;
  if (typeof repo !== "string" || !issue || typeof issue.number !== "number") return ignore("malformed_payload");
  if (!(await deps.isDemoRepo(repo))) return ignore("unknown_repo");
  if (!(await deps.claimDelivery(deliveryId))) return ignore("duplicate_delivery");

  const title = typeof issue.title === "string" ? issue.title : "";

  if (isIssues) {
    if (isBot(issue.user, deps.slug)) return ignore("bot_author");
    const login = issue.user?.login;
    if (!login) return ignore("malformed_payload");
    return {
      action: "run",
      reason: "issue_opened",
      job: {
        kind: "run",
        input: {
          source: "github",
          arm: "porter",
          repo,
          number: issue.number,
          title,
          body: issue.body ?? "",
          authorExternalId: `gh:${login}`,
          deliveryId,
        },
      },
    };
  }

  const comment = p.comment;
  const login = comment?.user?.login;
  if (!comment || typeof comment.body !== "string" || !login) return ignore("malformed_payload");
  if (isBot(comment.user, deps.slug)) return ignore("bot_author");
  if (issue.pull_request) return ignore("pull_request");

  if (/^\s*\/porter(\s|$)/i.test(comment.body)) {
    if (!COMMANDERS.has(comment.author_association ?? "")) return ignore("not_a_maintainer");
    const command = parseCommand(comment.body);
    if (!command) return ignore("unknown_command");
    return { action: "command", reason: command.cmd, job: { kind: "command", repo, issueNumber: issue.number, actor: login, command } };
  }

  if (mentions(comment.body, deps.slug)) {
    return {
      action: "run",
      reason: "mention",
      job: {
        kind: "run",
        input: {
          source: "github",
          arm: "porter",
          repo,
          number: issue.number,
          title,
          body: comment.body,
          authorExternalId: `gh:${login}`,
          deliveryId,
        },
      },
    };
  }
  return ignore("no_mention");
}

export type Services = {
  run: (input: IssueInput) => Promise<RunOutcome>;
  /** Posts one comment (rate limited, queued when over the limit). */
  post: (repo: string, issueNumber: number, body: string, runId?: string) => Promise<"posted" | "queued">;
  command: (job: CommandJob) => Promise<string>;
  /** Whether a write to the repo is still within the hourly allowance. */
  withinWriteLimit: (repo: string) => Promise<boolean>;
  releaseDelivery: (deliveryId: string) => Promise<void>;
};

export const QUEUED_COMMAND_REPLY =
  "The hourly limit for automated actions on this repository is reached, so this command was not run. The proposal stays pending; send the command again later.";

/** Carries out a routed job. Never throws: failures are logged by name only. */
export async function processJob(route: Route, deliveryId: string, s: Services): Promise<void> {
  const job = route.job;
  if (route.action === "ignore" || !job) return;
  try {
    if (job.kind === "run") {
      let outcome: RunOutcome;
      try {
        outcome = await s.run(job.input);
      } catch (e) {
        if (e instanceof DuplicateDeliveryError) return;
        // Nothing durable happened for this delivery id: let GitHub's redelivery try again.
        await s.releaseDelivery(deliveryId).catch(() => undefined);
        throw e;
      }
      // refused_funds / failed / blocked_author carry no reply: nothing is posted.
      if (outcome.reply !== null && job.input.number !== null) {
        await s.post(job.input.repo, job.input.number, outcome.reply, outcome.runId);
      }
      return;
    }
    const mutates = job.command.cmd === "approve";
    if (mutates && !(await s.withinWriteLimit(job.repo))) {
      console.warn(`porter: write limit reached for ${job.repo}; approve left pending`);
      await s.post(job.repo, job.issueNumber, QUEUED_COMMAND_REPLY);
      return;
    }
    const text = await s.command(job);
    await s.post(job.repo, job.issueNumber, text);
  } catch (e) {
    console.warn(`porter webhook job failed: ${e instanceof Error ? e.name : "error"}`);
  }
}
