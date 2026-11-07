import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDbRecorder, guardVerdictRow } from "../../lib/agent/record";
import { db } from "../../lib/db/client";
import { guardVerdicts, kv, proposals, runs, steps } from "../../lib/db/schema";

const live = process.env.DB_LIVE === "1";

describe.skipIf(!live)("db recorder (live Neon)", () => {
  const runId = randomUUID();
  const deliveryId = `test-${randomBytes(6).toString("hex")}`;
  const kvKey = `test:review:${runId}`;
  const sha = randomBytes(32).toString("hex");

  beforeAll(() => {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  });

  afterAll(async () => {
    const d = db();
    await d.delete(runs).where(eq(runs.id, runId)); // cascades to steps and proposals
    await d.delete(kv).where(inArray(kv.key, [kvKey]));
    await d.delete(guardVerdicts).where(eq(guardVerdicts.inputSha256, sha));
  });

  it("writes a run, its steps, proposals and a kv item, and refuses a redelivery", async () => {
    const d = db();
    const rec = createDbRecorder(d);
    const start = {
      id: runId,
      source: "eval" as const,
      arm: "porter" as const,
      repo: "test/recorder",
      issueNumber: 1,
      deliveryId,
      authorExternalId: "eval:recorder",
      title: "t",
      body: "b\u0000 lone \ud83d end",
      status: "running",
    };
    expect(await rec.createRun(start)).toEqual({ created: true });
    expect(await rec.createRun({ ...start, id: randomUUID() })).toEqual({ created: false });

    await rec.addStep(runId, {
      role: "triage",
      requestedModel: "porter-triage",
      servedModel: "openai/gpt-oss-120b",
      provider: "p",
      fallback: true,
      attemptCount: 2,
      requestId: "req",
      costUsd: 0.0021,
      durationMs: 1234,
      guardrails: null,
      toolCalls: [{ type: "code_execution", stdout: "nul\u0000 and \udc00 here", exit_code: 0 }],
      errorKind: null,
      errorStatus: null,
    });
    await rec.addProposals(runId, [{ action: "add_labels", args: { repo: "test/recorder", issue_number: 1, labels: ["bug"] } }]);
    const finishedAt = new Date();
    await rec.finishRun(runId, { status: "answered", reply: "hi", triage: { kind: "bug" }, totalCostUsd: 0.0021, finishedAt });
    await rec.putKv(kvKey, { runId }, null);
    await rec.putKv(kvKey, { runId, again: true }, new Date(finishedAt.getTime() + 60_000));

    const [run] = await d.select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({ status: "answered", reply: "hi", totalCostUsd: 0.0021, deliveryId, body: "b lone � end" });
    expect(run.finishedAt?.getTime()).toBe(finishedAt.getTime());
    const stepRows = await d.select().from(steps).where(eq(steps.runId, runId));
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]).toMatchObject({ role: "triage", fallback: true, attemptCount: 2, durationMs: 1234 });
    expect(stepRows[0].toolCalls).toEqual([{ type: "code_execution", stdout: "nul and � here", exit_code: 0 }]);
    const props = await d.select().from(proposals).where(eq(proposals.runId, runId));
    expect(props).toMatchObject([{ action: "add_labels", status: "pending" }]);
    const [item] = await d.select().from(kv).where(eq(kv.key, kvKey));
    expect(item.value).toEqual({ runId, again: true });
  });

  it("inserts a guard verdict row", async () => {
    await db()
      .insert(guardVerdicts)
      .values(
        guardVerdictRow({
          inputSha256: sha,
          profile: "secrets",
          valid: true,
          score: 0,
          explanation: "no signals",
          signals: [],
          modelVerdicts: [],
          latencyMs: 3,
        }),
      );
    const rows = await db().select().from(guardVerdicts).where(eq(guardVerdicts.inputSha256, sha));
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBeNull();
  });
});
