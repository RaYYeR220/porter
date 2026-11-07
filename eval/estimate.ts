import { ROLES } from "../lib/agent/roles";
import type { Role } from "../lib/agent/roles";
import { MAX_BODY_CHARS } from "../lib/agent/triage";

/**
 * Cost model for --dry-run and --max-usd. No Otari calls. Inputs:
 *  - catalog prices on 2026-11-07, USD per million tokens (in / out);
 *  - per-role max_tokens from lib/agent/roles.ts as the output ceiling of every call;
 *  - gateway tool fees: $0.01 per web fetch, $0.01 per code-execution run.
 * Guard-model calls bill to a separate workspace, so they are reported apart.
 */
export const PRICES = {
  "gpt-oss-120b": { in: 0.037, out: 0.17 },
  "glm-5.3-flash": { in: 0.15, out: 0.5 },
  "qwen3-coder-480b-turbo": { in: 0.3, out: 1.0 },
  "gpt-oss-safeguard-120b": { in: 0.15, out: 0.6 },
  "llama-guard-4": { in: 0.18, out: 0.18 },
  qwen3guard: { in: 0, out: 0 },
} as const;

export const ROLE_MODEL: Record<Role, keyof typeof PRICES> = {
  triage: "gpt-oss-120b",
  repro: "qwen3-coder-480b-turbo",
  review: "glm-5.3-flash",
};

export const FEES = { fetch: 0.01, codeRun: 0.01 };

/** Prompt overhead and tool-result tokens per triage round (documented assumptions, not measurements). */
const SYSTEM_TOKENS = 700;
const TOOL_RESULT_TOKENS = 1_500;
/** Triage rounds priced: the tool loop allows 6; most issues need two or three tool calls. */
const TRIAGE_ROUNDS = 4;
const MAX_FETCHES = 2;

const tokens = (chars: number) => Math.ceil(chars / 4);
const usd = (model: keyof typeof PRICES, tokensIn: number, tokensOut: number) =>
  (tokensIn * PRICES[model].in + tokensOut * PRICES[model].out) / 1_000_000;

export type CaseShape = { title: string; body: string; hasPage?: boolean };
export type Estimate = {
  /** Likely: one fetch for an ordinary issue, two when the case links a page; repro only for a Python fence. */
  expectedUsd: number;
  /** Ceiling: two fetches, a repro run, every call at max_tokens. Used by --max-usd. */
  ceilingUsd: number;
  /** Input guardrail calls (Porter arm only), billed to the guard workspace. */
  guardUsd: number;
};

const wantsRepro = (c: CaseShape) => /```\s*(python|py)\b/i.test(c.body);

export function estimateCase(c: CaseShape, arm: "porter" | "baseline"): Estimate {
  const issueTokens = tokens(Math.min(c.body.length, MAX_BODY_CHARS) + c.title.length);
  const triageIn = TRIAGE_ROUNDS * (issueTokens + SYSTEM_TOKENS) + (TRIAGE_ROUNDS - 1) * TOOL_RESULT_TOKENS;
  const triage = usd(ROLE_MODEL.triage, triageIn, TRIAGE_ROUNDS * ROLES.triage.maxTokens);
  const repro = usd(ROLE_MODEL.repro, issueTokens + SYSTEM_TOKENS, ROLES.repro.maxTokens);
  const review = usd(ROLE_MODEL.review, issueTokens + SYSTEM_TOKENS + 2 * TOOL_RESULT_TOKENS, ROLES.review.maxTokens);

  const expectedFetches = c.hasPage ? MAX_FETCHES : 1;
  const base = triage + review + (wantsRepro(c) ? repro + FEES.codeRun : 0);
  const expectedUsd = base + expectedFetches * FEES.fetch;
  const ceilingUsd = triage + review + repro + FEES.codeRun + MAX_FETCHES * FEES.fetch;

  // One input-only guard pass per gateway call (triage, repro, review): safeguard + llama-guard on the call's input.
  const calls = [issueTokens + SYSTEM_TOKENS, issueTokens + SYSTEM_TOKENS, issueTokens + SYSTEM_TOKENS + 2 * TOOL_RESULT_TOKENS];
  const guardUsd =
    arm === "porter"
      ? calls.reduce((s, t) => s + usd("gpt-oss-safeguard-120b", t, 100) + usd("llama-guard-4", t, 20), 0)
      : 0;
  return { expectedUsd, ceilingUsd, guardUsd };
}

export function sumEstimates(list: Estimate[]): Estimate {
  return list.reduce(
    (a, e) => ({ expectedUsd: a.expectedUsd + e.expectedUsd, ceilingUsd: a.ceilingUsd + e.ceilingUsd, guardUsd: a.guardUsd + e.guardUsd }),
    { expectedUsd: 0, ceilingUsd: 0, guardUsd: 0 },
  );
}

export const fmtUsd = (n: number) => `$${n.toFixed(4)}`;
