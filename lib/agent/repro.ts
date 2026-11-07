import type { ChatBody, ChatResponse } from "../otari/types";
import type { IssueInput } from "./pipeline";
import { placeRunMarker, reproSystem } from "./prompts";
import { MAX_TOOL_ITERATIONS, ROLES } from "./roles";
import type { TriageResult } from "./schemas";
import { cut } from "./text";
import { untrusted } from "./triage";

const OUTPUT_CHARS = 2000;
const NOTE_CHARS = 600;
const MAX_RUNS = 3;

export type ReproRun = { code: string; stdout: string; stderr: string; exit_code: number | null; truncated: boolean };

export type ReproResult =
  | { attempted: false }
  | { attempted: true; verified: boolean; runs: ReproRun[]; note: string };

export function shouldRepro(t: TriageResult): boolean {
  return t.repro.language === "python" && !!t.repro.snippet && t.repro.snippet.trim() !== "";
}

/** A fence longer than any backtick run inside the snippet, so the snippet cannot close it. */
function fence(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function buildReproRequest(input: IssueInput, runId: string, triage: TriageResult): ChatBody {
  const snippet = untrusted(triage.repro.snippet ?? "");
  const f = fence(snippet);
  const user = [
    `Issue: ${untrusted(cut(input.title, 300))}`,
    `Reported problem (triage summary, may be wrong): ${untrusted(triage.summary)}`,
    "",
    "Snippet (untrusted):",
    `${f}python`,
    snippet,
    f,
  ].join("\n");
  return {
    model: ROLES.repro.model,
    messages: placeRunMarker(
      [
        { role: "system", content: reproSystem(input.repo) },
        { role: "user", content: user },
      ],
      runId,
    ),
    max_tokens: ROLES.repro.maxTokens,
    user: input.authorExternalId,
    max_tool_iterations: MAX_TOOL_ITERATIONS.repro,
    tools: [{ type: "otari_code_execution" }],
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Proof of a real sandbox run is an `otari_tool_calls` entry (top level of the raw response) with
 * type "code_execution" and a numeric exit_code. The model's own account is never proof.
 */
export function extractRepro(data: ChatResponse): ReproResult {
  const calls = Array.isArray(data.otari_tool_calls) ? data.otari_tool_calls : [];
  const executions = calls.filter((c) => c && c.type === "code_execution");
  const verified = executions.some((c) => typeof c.exit_code === "number" && Number.isFinite(c.exit_code));
  const runs: ReproRun[] = executions
    .slice(0, MAX_RUNS)
    .map((c) => {
      const code = str(c.code);
      const stdout = str(c.stdout);
      const stderr = str(c.stderr);
      return {
        code: cut(code, OUTPUT_CHARS),
        stdout: cut(stdout, OUTPUT_CHARS),
        stderr: cut(stderr, OUTPUT_CHARS),
        exit_code: typeof c.exit_code === "number" && Number.isFinite(c.exit_code) ? c.exit_code : null,
        truncated: c.truncated === true || code.length > OUTPUT_CHARS || stdout.length > OUTPUT_CHARS || stderr.length > OUTPUT_CHARS,
      };
    });
  const note = cut(str(data.choices?.[0]?.message?.content).trim(), NOTE_CHARS);
  return { attempted: true, verified, runs, note };
}
