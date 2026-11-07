import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { runIssue, armClient } from "../agent/pipeline";
import { createDbRecorder } from "../agent/record";
import { db } from "../db/client";
import { kv, repos } from "../db/schema";
import { getGithubEnv, getMaintainerEnv, getRegularBudgetId } from "../env";
import { githubAppWriter } from "../mcp/github-write";
import { createOtariClient } from "../otari/client";
import { ratelimit, repoWriteKey, WRITES_PER_HOUR } from "../ratelimit";
import { drizzleProposalStore, executeCommand } from "./commands";
import { postReply } from "./post";
import type { Services, RouteDeps } from "./webhook";

const DELIVERY_TTL_MS = 7 * 24 * 3600_000;

/** Installation id of a demo repo, or null when the repo is unknown, not a demo repo, or not installed. */
export async function demoInstallationId(fullName: string): Promise<string | null> {
  const rows = await db()
    .select({ installationId: repos.installationId })
    .from(repos)
    .where(and(sql`lower(${repos.fullName}) = ${fullName.toLowerCase()}`, eq(repos.kind, "demo"), isNotNull(repos.installationId)))
    .limit(1);
  return rows[0]?.installationId ?? null;
}

export function routeDeps(): RouteDeps {
  return {
    slug: getGithubEnv().slug,
    isDemoRepo: async (fullName) => (await demoInstallationId(fullName)) !== null,
    // One atomic statement: insert, or take over an expired claim. A live claim returns no row.
    claimDelivery: async (deliveryId) => {
      const expires = new Date(Date.now() + DELIVERY_TTL_MS);
      const got = await db()
        .insert(kv)
        .values({ key: `delivery:${deliveryId}`, value: { at: new Date().toISOString() }, expiresAt: expires })
        .onConflictDoUpdate({
          target: kv.key,
          set: { value: { at: new Date().toISOString() }, expiresAt: expires, updatedAt: new Date() },
          setWhere: sql`${kv.expiresAt} is not null and ${kv.expiresAt} < now()`,
        })
        .returning({ key: kv.key });
      return got.length > 0;
    },
  };
}

/** Durable trace of a failed delivery: class name only, kept 7 days. */
export async function recordWebhookError(deliveryId: string, event: string, e: unknown): Promise<void> {
  await createDbRecorder(db()).putKv(
    `webhook_error:${deliveryId}`,
    { event, error: e instanceof Error ? e.name : "Error", at: new Date().toISOString() },
    new Date(Date.now() + DELIVERY_TTL_MS),
  );
}

/** Production wiring: stranger arm for issue content, maintainer key only for /porter commands. */
export function productionServices(): Services {
  const writer = githubAppWriter(demoInstallationId);
  const withinWriteLimit = (repo: string) => ratelimit(repoWriteKey(repo), WRITES_PER_HOUR, 3600);
  const recorder = createDbRecorder(db());
  const post: Services["post"] = (repo, issueNumber, body, runId, opts) =>
    postReply(
      repo,
      issueNumber,
      body,
      {
        writer,
        withinLimit: withinWriteLimit,
        queue: async (item) => {
          await recorder.putKv(`queued_reply:${item.runId ?? randomUUID()}`, { ...item, queuedAt: new Date().toISOString() }, null);
          if (item.runId) {
            await recorder.addStep(item.runId, {
              role: "warning", requestedModel: null, servedModel: null, provider: null, fallback: false, attemptCount: null,
              requestId: null, costUsd: null, durationMs: null, guardrails: null, toolCalls: null,
              errorKind: item.reason, errorStatus: item.error?.status ?? null,
            });
          }
        },
      },
      runId,
      opts,
    );
  return {
    run: async (input) => runIssue(input, { otari: armClient("porter").otari, recorder }),
    post,
    withinWriteLimit,
    recordError: recordWebhookError,
    releaseDelivery: async (deliveryId) => {
      await db().delete(kv).where(eq(kv.key, `delivery:${deliveryId}`));
    },
    command: async (job) => {
      const m = getMaintainerEnv();
      const s = armClient("porter");
      return executeCommand(
        job.command,
        { repo: job.repo, issueNumber: job.issueNumber, actor: job.actor },
        {
          store: drizzleProposalStore(),
          otari: createOtariClient({ apiKey: m.apiKey, baseUrl: m.baseUrl }),
          mcpServerId: m.mcpServerId,
          strangers: s.otari,
          regularBudgetId: getRegularBudgetId,
        },
      );
    },
  };
}
