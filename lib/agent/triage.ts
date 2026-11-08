import type { ChatBody } from "../otari/types";
import type { IssueInput } from "./pipeline";
import { neutraliseMarkers, placeRunMarker, triageSystem } from "./prompts";
import type { ChatMessage } from "./prompts";
import { MAX_TOOL_ITERATIONS, ROLES } from "./roles";
import { jsonSchemaFormat, parseLenient, TRIAGE_JSON_SCHEMA, TriageResult } from "./schemas";
import { cut } from "./text";

export const MAX_BODY_CHARS = 12_000;
/** Stored title cap (runs.title). */
export const MAX_TITLE_CHARS = 300;
/** Title cap inside any prompt. */
export const MAX_PROMPT_TITLE_CHARS = 200;
const FALLBACK_SUMMARY_CHARS = 400;

/** Hosts the triage prompt names for fetching, before any per-repo docs host. */
const FETCH_DOMAINS = ["github.com", "pypi.org", "npmjs.com", "www.npmjs.com", "docs.python.org"];

/** The triage call's only tool declaration. Repo tools come through `mcp_server_ids`, not here. */
export const TRIAGE_FETCH_TOOL: Readonly<{ type: "otari_web_fetch" }> = Object.freeze({ type: "otari_web_fetch" });

const nf = new Intl.NumberFormat("en-US");

/** Untrusted issue text, made safe to embed: no forged marker, no fake delimiter. */
export function untrusted(text: string): string {
  return neutraliseMarkers(text).replace(/<(\s*\/?\s*)(issue-body)/gi, "&lt;$1$2");
}

/** The title as every prompt sees it: one line (all whitespace runs → one space), 200 chars, untrusted. */
export function promptTitle(title: string): string {
  // JS \s already covers U+2028/U+2029; NEL (U+0085) is a line break too but is not in \s.
  return untrusted(cut(title.replace(/[\s\x85]+/g, " ").trim(), MAX_PROMPT_TITLE_CHARS));
}

/**
 * Domains the triage prompt asks the model to fetch from. Guidance only: hosted Otari takes no
 * per-request fetch settings (a declaration with `allowed_domains` or `max_uses` is a 400:
 * "otari_web_fetch declarations may contain only the type field"). What bounds fetching is the
 * workspace's web-fetch policy (dashboard: workspace → Tools → Web search, allowed domains) and the
 * call's `max_tool_iterations`; what bounds a reply's links is the output check.
 * `extraFetchDomains` (eval fixtures) only add to this prompt text; they never reach the reply or
 * output-check link allowlists.
 */
export function allowedFetchDomains(docsHosts: string[] = [], extraFetchDomains: string[] = []): string[] {
  const clean = (hosts: string[]) => hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...FETCH_DOMAINS, ...clean(docsHosts), ...clean(extraFetchDomains)])];
}

/** The issue as the user message: title, number, delimited body (cut to 12,000 chars with a notice). */
export function issueBlock(input: IssueInput, maxBody = MAX_BODY_CHARS): string {
  const title = promptTitle(input.title);
  const raw = input.body ?? "";
  const lines = [
    `Repository: ${input.repo}`,
    input.number === null ? "Issue: not filed on GitHub yet (submitted through Porter's web form)" : `Issue: #${input.number}`,
    `Title: ${title}`,
    "",
  ];
  if (raw.trim() === "") {
    lines.push("<issue-body>", "(empty: the reporter wrote only a title, so triage from the title)", "</issue-body>");
    return lines.join("\n");
  }
  const body = cut(raw, maxBody);
  lines.push("<issue-body>", untrusted(body), "</issue-body>");
  if (body.length < raw.length) {
    lines.push(`[Porter note: the issue body was cut to its first ${nf.format(maxBody)} of ${nf.format(raw.length)} characters.]`);
  }
  return lines.join("\n");
}

export function buildTriageMessages(
  input: IssueInput,
  runId: string,
  docsHosts: string[] = [],
  extraFetchDomains: string[] = [],
): ChatMessage[] {
  return placeRunMarker(
    [
      { role: "system", content: triageSystem(input.repo, allowedFetchDomains(docsHosts, extraFetchDomains)) },
      { role: "user", content: issueBlock(input) },
    ],
    runId,
  );
}

export function buildTriageRequest(
  input: IssueInput,
  runId: string,
  opts: { mcpServerId: string | null; docsHosts?: string[]; extraFetchDomains?: string[] },
): ChatBody {
  const body: ChatBody = {
    model: ROLES.triage.model,
    messages: buildTriageMessages(input, runId, opts.docsHosts, opts.extraFetchDomains),
    max_tokens: ROLES.triage.maxTokens,
    user: input.authorExternalId,
    max_tool_iterations: MAX_TOOL_ITERATIONS.triage,
    // Exactly the type field: hosted Otari rejects any other key here (see allowedFetchDomains).
    tools: [{ ...TRIAGE_FETCH_TOOL }],
    response_format: jsonSchemaFormat("triage", TRIAGE_JSON_SCHEMA),
  };
  if (opts.mcpServerId) body.mcp_server_ids = [opts.mcpServerId];
  return body;
}

const LIMITS = { summary: 1000, duplicates: 5, labels: 5, label: 50, missing: 6, missingItem: 300, snippet: 8000, text: 300 };

/** Bounds every field so a chatty model cannot bloat later prompts or proposals. */
export function normaliseTriage(t: TriageResult): TriageResult {
  const seen = new Set<number>();
  const duplicates = t.duplicates
    .filter((d) => !seen.has(d.number) && seen.add(d.number))
    .slice(0, LIMITS.duplicates)
    .map((d) => ({ number: d.number, title: cut(d.title, LIMITS.text), why: cut(d.why, LIMITS.text) }));
  const labels = [...new Set(t.labels.map((l) => l.trim()).filter((l) => l.length > 0 && l.length <= LIMITS.label))].slice(
    0,
    LIMITS.labels,
  );
  const snippet = t.repro.snippet && t.repro.snippet.trim() !== "" ? cut(t.repro.snippet, LIMITS.snippet) : null;
  return {
    summary: cut(t.summary, LIMITS.summary),
    kind: t.kind,
    duplicates,
    fixed_in: t.fixed_in ? { version: cut(t.fixed_in.version, 100), evidence_url: cut(t.fixed_in.evidence_url, 500) } : null,
    missing_info: t.missing_info
      .map((m) => m.trim())
      .filter(Boolean)
      .slice(0, LIMITS.missing)
      .map((m) => cut(m, LIMITS.missingItem)),
    labels,
    repro: { snippet, language: t.repro.language },
  };
}

export function fallbackTriage(content: string): TriageResult {
  return {
    summary: cut(content, FALLBACK_SUMMARY_CHARS),
    kind: "other",
    duplicates: [],
    fixed_in: null,
    missing_info: [],
    labels: [],
    repro: { snippet: null, language: "none" },
  };
}

/** Never throws: unreadable output becomes a minimal "other" triage flagged as a fallback. */
export function parseTriage(content: string | null | undefined): { result: TriageResult; fallback: boolean } {
  const text = content ?? "";
  const parsed = parseLenient(TriageResult, text);
  if (parsed) return { result: normaliseTriage(parsed), fallback: false };
  return { result: fallbackTriage(text), fallback: true };
}
