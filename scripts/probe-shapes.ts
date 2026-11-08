/**
 * Request-shape probe against the live Otari API.
 *   pnpm probe:shapes [--allow-spend]
 *
 * Sends every request the app builds, with the real builders, keys and headers, and prints one row per
 * HTTP exchange: route, status, what the status means, and the response body (redacted, cut short).
 * On an org with a $0 balance Otari checks the request shape before funds, so a model route answering
 * 402 accepted the shape and cost nothing; a 400/422 means a builder sends something Otari rejects.
 *
 * Safety: the first call is an embedding of two words, and the model probes run only if it answers
 * exactly 402 (insufficient funds). Served, rate-limited, failed or timed out, the canary proves nothing
 * about funds, so the script skips every model call and probes the non-model routes only (re-run with
 * --allow-spend to send the model calls anyway). List routes print counts, not bodies.
 * Keys and other secrets are read from the environment and never printed. The end user it touches is
 * spike:shape-<random> and is deleted at the end on both service keys.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { classifyHarm, classifyInjection } from "porter-guard";
import { runCallOpts } from "../lib/agent/pipeline";
import type { IssueInput } from "../lib/agent/pipeline";
import { buildReproRequest } from "../lib/agent/repro";
import type { ReproResult } from "../lib/agent/repro";
import { buildEvidenceBundle, buildReviewRequest } from "../lib/agent/review";
import type { Role } from "../lib/agent/roles";
import type { TriageResult } from "../lib/agent/schemas";
import { buildTriageRequest } from "../lib/agent/triage";
import { getMcpServerId } from "../lib/env";
import { otariChat } from "../lib/guard";
import { createOtariClient, DEFAULT_BASE_URL } from "../lib/otari/client";
import type { ChatBody } from "../lib/otari/types";
import { EMBEDDING_MODEL } from "../lib/snapshot/embed";
import { canaryDecision, listSummary, recordingFetch, redact, row, secretValues, verdict } from "./probe-shapes-core";
import type { Exchange } from "./probe-shapes-core";

const KEYS = {
  strangers: "OTARI_KEY_STRANGERS",
  baseline: "OTARI_KEY_BASELINE",
  ops: "OTARI_KEY_OPS",
  guard: "OTARI_KEY_GUARD",
  maintainer: "OTARI_KEY_MAINTAINER",
} as const;
type KeyName = keyof typeof KEYS;

const allowSpend = process.argv.includes("--allow-spend");
const baseUrl = process.env.OTARI_BASE_URL?.trim() || DEFAULT_BASE_URL;
const secrets = secretValues(process.env);
const log: Exchange[] = [];
const fetchImpl = recordingFetch(log);

function key(name: KeyName): string {
  const v = process.env[KEYS[name]]?.trim();
  if (!v) throw new Error(`Missing environment variable: ${KEYS[name]}`);
  return v;
}
const client = (name: KeyName) => createOtariClient({ apiKey: key(name), baseUrl, fetchImpl });

/** A raw call for routes the client has no method for; still recorded. */
async function raw(name: KeyName, method: string, path: string): Promise<void> {
  await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key(name)}`, "User-Agent": "porter/0.1", Accept: "application/json" },
  });
}

const endUser = `spike:shape-${randomBytes(4).toString("hex")}`;
const runId = randomUUID();

const input = (arm: IssueInput["arm"]): IssueInput => ({
  source: "eval",
  arm,
  repo: "mozilla-ai/otari",
  number: null,
  title: "Shape probe: parse() fails on an empty string",
  body: "Running `parse('')` raises IndexError on 1.2.0.",
  authorExternalId: endUser,
});

const TRIAGE: TriageResult = {
  summary: "parse('') raises IndexError",
  kind: "bug",
  duplicates: [],
  fixed_in: null,
  missing_info: ["full traceback"],
  labels: ["bug"],
  repro: { snippet: "print('shape probe')", language: "python" },
};
const NO_REPRO: ReproResult = { attempted: false };

const chatOn = (name: KeyName, arm: IssueInput["arm"], role: Role, body: ChatBody, endUserBudget?: string) => () =>
  client(name).chat(body, runCallOpts(runId, role, arm, endUserBudget));

const withTools = (body: ChatBody, tools: Array<Record<string, unknown>>): ChatBody => ({ ...body, tools });

/** A `variant` is informational (an alternative or a deliberately old shape) and never fails the run. */
/** `list` routes print a count instead of their body (other end users' ids and meters). */
type Probe = { name: string; key: KeyName; kind: "model" | "api"; run: () => Promise<unknown>; variant?: boolean; list?: boolean };

function modelProbes(): Probe[] {
  const out: Probe[] = [];
  for (const arm of ["porter", "baseline"] as const) {
    const k: KeyName = arm === "porter" ? "strangers" : "baseline";
    const i = input(arm);
    const mcp = getMcpServerId(arm);
    const triage = buildTriageRequest(i, runId, { mcpServerId: mcp });
    const repro = buildReproRequest(i, runId, TRIAGE);
    const review = buildReviewRequest(i, runId, buildEvidenceBundle({ input: i, triage: TRIAGE, repro: NO_REPRO, toolCalls: [] }));
    const { tools: _fetchTool, ...triageNoTools } = triage;
    void _fetchTool;
    out.push(
      { name: `triage, ${arm} arm${mcp ? "" : " (no MCP server id)"}`, key: k, kind: "model", run: chatOn(k, arm, "triage", triage) },
      {
        name: `variant: triage, ${arm} arm, without the fetch tool`,
        key: k,
        kind: "model",
        variant: true,
        run: chatOn(k, arm, "triage", triageNoTools),
      },
      { name: `repro, ${arm} arm`, key: k, kind: "model", run: chatOn(k, arm, "repro", repro) },
      { name: `review, ${arm} arm`, key: k, kind: "model", run: chatOn(k, arm, "review", review) },
    );
    if (arm === "porter") {
      const regular = process.env.OTARI_BUDGET_REGULAR_ID?.trim();
      if (regular) {
        out.push({ name: "triage + Otari-End-User-Budget (eval authors)", key: k, kind: "model", run: chatOn(k, arm, "triage", triage, regular) });
      }
      out.push(
        {
          name: "variant: triage with an unregistered mcp_server_ids",
          key: k,
          kind: "model",
          variant: true,
          run: chatOn(k, arm, "triage", { ...triage, mcp_server_ids: [randomUUID()] }),
        },
        {
          name: "variant: triage fetch with allowed_domains + max_uses (old shape)",
          key: k,
          kind: "model",
          variant: true,
          run: chatOn(k, arm, "triage", withTools(triage, [{ type: "otari_web_fetch", max_uses: 2, allowed_domains: ["github.com"] }])),
        },
        {
          name: 'variant: repro code execution with container "auto"',
          key: k,
          kind: "model",
          variant: true,
          run: chatOn(k, arm, "repro", withTools(repro, [{ type: "otari_code_execution", container: "auto" }])),
        },
        {
          name: "variant: repro code execution with purpose_hint",
          key: k,
          kind: "model",
          variant: true,
          run: chatOn(k, arm, "repro", withTools(repro, [{ type: "otari_code_execution", purpose_hint: "Run the reporter's Python snippet." }])),
        },
      );
    }
  }
  const guardChat = otariChat(key("guard"), baseUrl, fetchImpl);
  out.push(
    { name: "guard: prompt-injection classifiers (qwen3guard, gpt-oss-safeguard)", key: "guard", kind: "model", run: () => classifyInjection("Shape probe text.", guardChat, 20_000) },
    { name: "guard: harm classifier (llama-guard-4)", key: "guard", kind: "model", run: () => classifyHarm("Shape probe text.", guardChat, 20_000) },
  );
  return out;
}

function apiProbes(): Probe[] {
  const s = () => client("strangers");
  const newcomer = process.env.OTARI_BUDGET_NEWCOMER_ID?.trim() ?? "";
  return [
    { name: "end user: get (meter)", key: "strangers", kind: "api", run: () => s().endUsers.get(endUser) },
    { name: "end user: put (create on newcomer)", key: "strangers", kind: "api", run: () => s().endUsers.put(endUser, newcomer) },
    { name: "end user: patch (unblock)", key: "strangers", kind: "api", run: () => s().endUsers.patch(endUser, { blocked: false }) },
    { name: "end users: list", key: "strangers", kind: "api", list: true, run: () => s().endUsers.list(5) },
    { name: "end-user budgets", key: "strangers", kind: "api", list: true, run: () => s().endUserBudgets() },
    { name: "key budget (strangers, /try floor)", key: "strangers", kind: "api", run: () => s().keyBudget() },
    { name: "mcp servers (maintainer)", key: "maintainer", kind: "api", run: () => raw("maintainer", "GET", "/mcp/servers") },
    { name: "mcp servers (strangers)", key: "strangers", kind: "api", run: () => raw("strangers", "GET", "/mcp/servers") },
    { name: "mcp tools of an unregistered server (approve path)", key: "maintainer", kind: "api", run: () => client("maintainer").mcp.tools(randomUUID()) },
  ];
}

const rows: string[] = [];
/** Exchanges of the app's own requests (variants excluded): these decide the exit code. */
const counted: Exchange[] = [];
async function runProbe(p: Probe): Promise<Exchange[]> {
  const from = log.length;
  try {
    await p.run();
  } catch {
    // the status and body are in the log; the client's error adds nothing
  }
  const got = log.slice(from);
  if (!p.variant) counted.push(...got);
  for (const x of got) {
    const shown = p.list && x.status >= 200 && x.status < 300 ? listSummary(x.body) : redact(x.body, secrets);
    rows.push(row([p.name, p.key, `${x.method} ${x.path}`, x.model, x.status, verdict(x.status, x.body, p.kind), shown]));
  }
  if (got.length === 0) rows.push(row([p.name, p.key, "–", null, "no request", "builder threw before sending", "–"]));
  return got;
}

async function main() {
  console.log(`Otari shape probe, ${new Date().toISOString()}, base ${new URL(baseUrl).host}, end user ${endUser}\n`);
  console.log(row(["probe", "key", "request", "model", "status", "meaning", "response (redacted)"]));
  console.log(row(["---", "---", "---", "---", "---", "---", "---"]));

  const canary = await runProbe({
    name: "embeddings (ops key; also the funds canary)",
    key: "ops",
    kind: "model",
    run: () => client("ops").embed(["shape probe"], EMBEDDING_MODEL, { tags: { app: "porter", role: "embed" } }),
  });
  // Fails closed: model probes run only after an exact 402 (or with --allow-spend).
  const gate = canaryDecision(
    canary.map((x) => x.status),
    allowSpend,
  );
  if (gate.runModels) {
    for (const p of modelProbes()) await runProbe(p);
  } else {
    rows.push(row(["model probes", "–", "–", null, "skipped", gate.note, "–"]));
  }
  for (const p of apiProbes()) await runProbe(p);

  // Cleanup: the end user may exist on either service key (a chat with `user` can create it).
  const q = `/end-users?external_id=${encodeURIComponent(endUser)}`;
  for (const k of ["strangers", "baseline"] as const) {
    await runProbe({ name: `cleanup: delete ${endUser}`, key: k, kind: "api", run: () => raw(k, "DELETE", q) });
  }

  for (const r of rows) console.log(r);
  const rejected = counted.filter((x) => x.status === 400 || x.status === 422).length;
  console.log(`\n${log.length} requests; ${rejected} of the app's own requests rejected for shape (400/422; variants not counted).`);
  process.exitCode = rejected > 0 ? 1 : 0;
}

main().catch((e: unknown) => {
  console.error(`probe failed: ${e instanceof Error ? e.message : "error"}`);
  process.exitCode = 2;
});
