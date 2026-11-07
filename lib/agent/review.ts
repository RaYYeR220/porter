import type { ChatBody } from "../otari/types";
import { allowedLinkHosts } from "./output-check";
import type { IssueInput } from "./pipeline";
import { neutraliseMarkers, placeRunMarker, reviewSystem } from "./prompts";
import type { ReproResult } from "./repro";
import { ROLES } from "./roles";
import { jsonSchemaFormat, parseLenient, REVIEW_JSON_SCHEMA, ReviewResult } from "./schemas";
import type { TriageResult } from "./schemas";
import { cut } from "./text";

const REVIEW_BODY_CHARS = 4000;
const SOURCE_OUTPUT_CHARS = 1500;
const SOURCES_TOTAL_CHARS = 10_000;
const MAX_SOURCES = 12;
const MAX_REPLY_CHARS = 5000;

type ToolCall = Record<string, unknown>;

export type Source = {
  type: string;
  name?: string;
  status?: string;
  output?: string;
  url?: string;
  query?: string;
  sources?: Array<{ url: string; title: string }>;
  error?: string;
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const asCalls = (v: unknown): ToolCall[] =>
  Array.isArray(v) ? v.filter((c): c is ToolCall => !!c && typeof c === "object" && !Array.isArray(c)) : [];

function outputText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Gateway tool results from the triage loop, cut to what the reviewer needs to check claims. */
export function evidenceSources(toolCalls: unknown): Source[] {
  let budget = SOURCES_TOTAL_CHARS;
  const out: Source[] = [];
  for (const c of asCalls(toolCalls).slice(0, MAX_SOURCES)) {
    const type = str(c.type) ?? "unknown";
    const base: Source = { type, status: str(c.status), error: str(c.error) ? cut(str(c.error)!, 300) : undefined };
    if (type === "mcp") {
      const output = cut(outputText(c.output), Math.max(0, Math.min(SOURCE_OUTPUT_CHARS, budget)));
      budget -= output.length;
      out.push({ ...base, name: str(c.name), output });
    } else if (type !== "code_execution") {
      const sources = Array.isArray(c.sources)
        ? asCalls(c.sources)
            .slice(0, 5)
            .map((s) => ({ url: cut(str(s.url) ?? "", 500), title: cut(str(s.title) ?? "", 200) }))
        : undefined;
      out.push({ ...base, url: str(c.url), query: str(c.query), sources });
    }
  }
  return out;
}

/** True when an MCP result the triage model actually received shows issue `n` (search or get_issue). */
export function issueSeenInTools(n: number, toolCalls: unknown): boolean {
  const re = new RegExp(`"number"\\s*:\\s*${n}(?![0-9])|/issues/${n}(?![0-9])`);
  return asCalls(toolCalls).some((c) => c.type === "mcp" && re.test(outputText(c.output)));
}

export function buildEvidenceBundle(p: {
  input: IssueInput;
  triage: TriageResult;
  repro: ReproResult;
  toolCalls: unknown;
}): string {
  const body = p.input.body ?? "";
  const bundle = {
    repo: p.input.repo,
    issue: {
      number: p.input.number,
      title: cut(p.input.title, 300),
      body: cut(body, REVIEW_BODY_CHARS),
      body_truncated: body.length > REVIEW_BODY_CHARS,
    },
    triage: p.triage,
    repro: p.repro,
    sources: evidenceSources(p.toolCalls),
  };
  return neutraliseMarkers(JSON.stringify(bundle));
}

export function buildReviewRequest(input: IssueInput, runId: string, bundle: string, docsHosts: string[] = []): ChatBody {
  return {
    model: ROLES.review.model,
    messages: placeRunMarker(
      [
        { role: "system", content: reviewSystem(input.repo, allowedLinkHosts(docsHosts)) },
        { role: "user", content: `Evidence bundle (JSON):\n${bundle}` },
      ],
      runId,
    ),
    max_tokens: ROLES.review.maxTokens,
    user: input.authorExternalId,
    response_format: jsonSchemaFormat("review", REVIEW_JSON_SCHEMA),
  };
}

/**
 * JSON {reply, struck_claims}, else plain prose taken as the reply (flagged as a fallback).
 * Anything that looks like broken JSON gives reply null: better nothing than a JSON fragment in public.
 */
export function parseReview(content: string | null | undefined): { reply: string | null; struck: string[]; fallback: boolean } {
  const text = content ?? "";
  const parsed = parseLenient(ReviewResult, text);
  if (parsed && parsed.reply.trim() !== "") {
    return {
      reply: cut(parsed.reply.trim(), MAX_REPLY_CHARS),
      struck: parsed.struck_claims.slice(0, 20).map((s) => cut(s, 300)),
      fallback: false,
    };
  }
  const t = text.trim();
  const looksLikeJson = t.startsWith("{") || t.startsWith("[") || t.startsWith("```") || /"reply"\s*:/.test(t);
  if (t !== "" && !looksLikeJson) return { reply: cut(t, MAX_REPLY_CHARS), struck: [], fallback: true };
  return { reply: null, struck: [], fallback: true };
}
