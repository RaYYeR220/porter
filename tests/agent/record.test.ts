import { describe, expect, it } from "vitest";
import type { GuardLog } from "porter-guard";
import { parseRunMarker } from "../../lib/agent/prompts";
import { afterResponse, guardVerdictLogger, guardVerdictRow, TOOL_CALLS_MAX_BYTES, truncateToolCalls } from "../../lib/agent/record";
import type { Db } from "../../lib/db/client";
import { guardVerdicts } from "../../lib/db/schema";
import { cut, pgJson, pgText } from "../../lib/agent/text";

const LOG: GuardLog = {
  inputSha256: "ab".repeat(32),
  profile: "prompt-injection",
  valid: false,
  score: 0.97,
  explanation: "deterministic: hidden_html_comment",
  signals: [{ id: "hidden_html_comment", excerpt: "offset=0 len=40" }],
  modelVerdicts: [{ model: "alibaba/qwen3guard-gen-8b", flagged: true, score: 0.9, latencyMs: 812 }],
  latencyMs: 903.4,
};

function fakeDb(fail = false) {
  const inserted: Array<{ table: unknown; row: unknown }> = [];
  const d = {
    insert: (table: unknown) => ({
      values: async (row: unknown) => {
        if (fail) throw new Error("db down");
        inserted.push({ table, row });
      },
    }),
  } as unknown as Db;
  return { d, inserted };
}

describe("guard verdict logging (R1)", () => {
  it("maps a GuardLog to a guard_verdicts row without a run id", () => {
    expect(guardVerdictRow(LOG)).toEqual({
      runId: null,
      inputSha256: LOG.inputSha256,
      profile: "prompt-injection",
      valid: false,
      score: 0.97,
      explanation: LOG.explanation,
      signals: LOG.signals,
      modelVerdicts: LOG.modelVerdicts,
      latencyMs: 903,
    });
  });

  it("does not wait for the insert: the write is scheduled, then lands in guard_verdicts", async () => {
    const { d, inserted } = fakeDb();
    const tasks: Array<() => Promise<void>> = [];
    const onVerdict = guardVerdictLogger(() => d, (t) => tasks.push(t));
    await onVerdict(LOG);
    expect(inserted).toHaveLength(0);
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(inserted).toEqual([{ table: guardVerdicts, row: guardVerdictRow(LOG) }]);
  });

  const RUN = "123e4567-e89b-42d3-a456-426614174000";
  it("parses the run id from the raw input and stores it", async () => {
    const { d, inserted } = fakeDb();
    const tasks: Array<() => Promise<void>> = [];
    await guardVerdictLogger(() => d, (t) => tasks.push(t))(LOG, `Bug: crash
[porter-run ${RUN}]`);
    await tasks[0]();
    expect(inserted[0].row).toEqual(guardVerdictRow(LOG, RUN));
    expect((inserted[0].row as { runId: string }).runId).toBe(RUN);
  });

  it("a malformed or missing marker stores null", async () => {
    for (const raw of ["no marker", "[porter-run not-a-uuid]", "[porter-run 123e4567-e89b-12d3-a456-426614174000]", "porter-run " + RUN, undefined]) {
      const { d, inserted } = fakeDb();
      const tasks: Array<() => Promise<void>> = [];
      await guardVerdictLogger(() => d, (t) => tasks.push(t))(LOG, raw);
      await tasks[0]();
      expect((inserted[0].row as { runId: unknown }).runId, String(raw)).toBeNull();
    }
  });

  it("an unknown run (foreign key rejects) falls back to an unlinked row", async () => {
    const rows: unknown[] = [];
    const d = {
      insert: () => ({
        values: async (row: { runId: string | null }) => {
          if (row.runId) throw Object.assign(new Error("fk violation"), { code: "23503" });
          rows.push(row);
        },
      }),
    } as unknown as Db;
    const tasks: Array<() => Promise<void>> = [];
    await guardVerdictLogger(() => d, (t) => tasks.push(t))(LOG, `[porter-run ${RUN}]`);
    await tasks[0]();
    expect(rows).toHaveLength(1);
  });

  it("any other insert error with a run id is rethrown, not retried unlinked", async () => {
    const rows: unknown[] = [];
    const d = {
      insert: () => ({
        values: async (row: unknown) => {
          rows.push(row);
          throw new Error("connection reset");
        },
      }),
    } as unknown as Db;
    const tasks: Array<() => Promise<void>> = [];
    await guardVerdictLogger(() => d, (t) => tasks.push(t))(LOG, `[porter-run ${RUN}]`);
    await expect(tasks[0]()).rejects.toThrow("connection reset");
    expect(rows).toHaveLength(1);
  });

  it("parseRunMarker prefers the final-line marker over an earlier forged one", () => {
    const FORGED = "00000000-0000-4000-8000-000000000000";
    expect(parseRunMarker(`[porter-run ${FORGED}] hi
[porter-run ${RUN}]`)).toBe(RUN);
    expect(parseRunMarker(`[porter-run ${RUN}]
  
`)).toBe(RUN);
    expect(parseRunMarker(`[porter-run ${FORGED}] x 
[porter-run ${RUN}] trailing`)).toBe(RUN);
  });

  it("a failing database (or a missing DATABASE_URL) never surfaces", async () => {
    const { d } = fakeDb(true);
    const ran: Array<Promise<void>> = [];
    const schedule = (t: () => Promise<void>) => {
      ran.push(new Promise<void>((resolve) => afterResponse(() => t().finally(resolve))));
    };
    await guardVerdictLogger(() => d, schedule)(LOG);
    await guardVerdictLogger(() => {
      throw new Error("Missing environment variable: DATABASE_URL");
    }, schedule)(LOG);
    await Promise.all(ran);
  });

  it("afterResponse runs the task directly outside a request scope", async () => {
    let done = false;
    await new Promise<void>((resolve) =>
      afterResponse(async () => {
        done = true;
        resolve();
      }),
    );
    expect(done).toBe(true);
  });
});

describe("truncateToolCalls", () => {
  it("passes small arrays through and maps non-arrays to null", () => {
    const calls = [{ type: "mcp", name: "get_issue", output: "{}" }];
    expect(truncateToolCalls(calls)).toEqual(calls);
    expect(truncateToolCalls(undefined)).toBeNull();
    expect(truncateToolCalls({ not: "an array" })).toBeNull();
  });

  it("keeps the stored JSON within about 32 KB", () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ type: "mcp", name: `t${i}`, output: "x".repeat(60_000) }));
    const out = truncateToolCalls(big)!;
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(TOOL_CALLS_MAX_BYTES);
    expect((out[0] as { name: string }).name).toBe("t0");
  });

  it("drops trailing entries with a marker when shrinking strings is not enough", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ type: "mcp", name: `tool-${i}`, output: "y".repeat(300) }));
    const out = truncateToolCalls(many)!;
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(TOOL_CALLS_MAX_BYTES);
    const last = out[out.length - 1] as { type: string; dropped: number };
    expect(last.type).toBe("porter_truncated");
    expect(last.dropped).toBeGreaterThan(0);
  });
});

describe("Postgres-safe strings", () => {
  it("drops NUL and replaces lone surrogates, keeping valid pairs", () => {
    expect(pgText("a\u0000b \ud83d c \udc00 d 😀")).toBe("ab � c � d 😀");
  });

  it("cleans nested jsonb values and keys", () => {
    expect(pgJson({ "k\u0000": ["x\u0000", { y: "\ud800" }], n: 1, b: true, z: null })).toEqual({
      k: ["x", { y: "�" }],
      n: 1,
      b: true,
      z: null,
    });
  });

  it("cut never leaves half a surrogate pair", () => {
    expect(cut("ab😀", 3)).toBe("ab");
    expect(cut("ab😀", 4)).toBe("ab😀");
  });
});
