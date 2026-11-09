import { stripAnsi } from "./ansi";
import { CodeBlock } from "./CodeBlock";
import { CopyId } from "./CopyId";
import { duration, usd } from "./format";
import { ModelChip } from "./ModelChip";
import { errorText, guardEntries, isSoftError, ROLE_LABEL, sandboxProof, toolCalls, type ToolCall } from "./runs";
import type { Step } from "./types";

const OUTPUT_PREVIEW = 600;
/** A timeout or a non-JSON body may still have been served and billed upstream; never claim otherwise. */
const MAYBE_SERVED = new Set(["timeout", "invalid_json"]);

function ToolCallView({ call }: { call: ToolCall }) {
  switch (call.kind) {
    case "mcp":
      return (
        <li className="tc">
          <p className="tc-head">
            <code className="tc-name">{call.name}</code>
            <span className="tc-kind">repo tool{call.server ? ` on ${call.server}` : ""}</span>
            {call.status && <span className="tc-status">{call.status}</span>}
          </p>
          {call.error && <p className="tc-err">{call.error}</p>}
          {call.output && <CodeBlock label={`${call.name} output`} code={call.output} max={OUTPUT_PREVIEW} />}
        </li>
      );
    case "fetch":
      return (
        <li className="tc">
          <p className="tc-head">
            <code className="tc-name">web fetch</code>
            {call.status && <span className="tc-status">{call.status}</span>}
          </p>
          <p className="tc-url">
            <code>{call.url ?? "no URL recorded"}</code>
          </p>
          {call.error && <p className="tc-err">{call.error}</p>}
        </li>
      );
    case "search":
      return (
        <li className="tc">
          <p className="tc-head">
            <code className="tc-name">web search</code>
            {call.query && <span className="tc-kind">“{call.query}”</span>}
            {call.status && <span className="tc-status">{call.status}</span>}
          </p>
          {call.sources.length > 0 && (
            <ul className="tc-sources">
              {call.sources.map((s) => (
                <li key={s.url}>
                  <code>{s.url}</code>
                </li>
              ))}
            </ul>
          )}
          {call.error && <p className="tc-err">{call.error}</p>}
        </li>
      );
    case "code":
      return (
        <li className="tc">
          <p className="tc-head">
            <code className="tc-name">code execution</code>
            <span className="tc-status">{call.exitCode === null ? "no exit code recorded" : `exit ${call.exitCode}`}</span>
            {call.truncated && <span className="tc-kind">output cut by the sandbox</span>}
          </p>
          <CodeBlock label="Code" code={call.code} />
          <CodeBlock label="stdout" code={stripAnsi(call.stdout)} />
          {call.stderr !== "" && <CodeBlock label="stderr" code={stripAnsi(call.stderr)} tone="err" />}
        </li>
      );
    case "struck":
      return (
        <li className="tc">
          <p className="tc-head">
            <code className="tc-name">struck claims</code>
            <span className="tc-kind">
              {call.claims.length === 0 ? "the reviewer struck nothing" : `${call.claims.length} removed from the draft for lack of evidence`}
            </span>
          </p>
          {call.claims.length > 0 && (
            <ul className="tc-claims">
              {call.claims.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </li>
      );
    case "truncated":
      return (
        <li className="tc">
          <p className="tc-kind">{call.dropped} more tool calls were not stored (the trace keeps about 32 KB per step).</p>
        </li>
      );
    default:
      return (
        <li className="tc">
          <p className="tc-head">
            <code className="tc-name">{call.type}</code>
          </p>
        </li>
      );
  }
}

const toolSummary = (calls: ToolCall[]) => {
  const names = calls
    .map((c) => (c.kind === "mcp" ? c.name : c.kind === "fetch" ? "web fetch" : c.kind === "search" ? "web search" : c.kind === "code" ? "code execution" : null))
    .filter((n): n is string => n !== null);
  return names.length ? `${names.length} tool call${names.length === 1 ? "" : "s"}: ${[...new Set(names)].join(", ")}` : null;
};

/**
 * One recorded call: the routing policy → the model and provider Otari served, what it cost and
 * how long it took, the guard verdicts the gateway returned, and the tools it ran.
 */
export function StepCard({
  step,
  index,
  mode = "full",
  heldReply = null,
  zeroAnswer = false,
}: {
  step: Step;
  index: number;
  mode?: "full" | "compact";
  heldReply?: string | null;
  zeroAnswer?: boolean;
}) {
  const role = ROLE_LABEL[step.role] ?? step.role;
  const guards = guardEntries(step.guardrails);
  const calls = toolCalls(step.toolCalls);
  const proof = sandboxProof(step.toolCalls);
  const err = errorText(step.errorKind, step.errorStatus);
  const heldHere = step.errorKind === "guardrail_violation" || step.errorKind === "output_blocked";
  const local = step.role === "output_check" || step.role === "warning";
  const kindClass = heldHere ? " step-held" : step.errorKind && !isSoftError(step.errorKind) ? " step-err" : "";

  return (
    <article className={`step-card${kindClass}`} aria-label={`Step ${index}: ${role}`}>
      <header className="sc-head">
        <span className="sc-n">{String(index).padStart(2, "0")}</span>
        <h3 className="sc-role">{role}</h3>
        {local ? (
          <span className="sc-local">{step.role === "output_check" ? "in Porter, no model call" : "recorded by Porter"}</span>
        ) : (
          <ModelChip
            requested={step.requestedModel}
            served={step.servedModel}
            provider={step.provider}
            fallback={step.fallback}
            attempts={step.attemptCount}
            unserved={step.errorKind && !isSoftError(step.errorKind) && !MAYBE_SERVED.has(step.errorKind) ? "no model served" : null}
          />
        )}
        {proof && (
          <span className="tag tag-proof" title="Otari recorded a code_execution entry with an exit code for this call">
            ran in the sandbox · exit {proof.exitCode}
          </span>
        )}
        {!local && (
          <span className="sc-figs">
            <code title="Cost of this call as Otari reported it">{usd(step.costUsd)}</code>
            <code title="Latency">{duration(step.durationMs)}</code>
          </span>
        )}
      </header>

      {err && <p className={heldHere ? "sc-hold" : isSoftError(step.errorKind) ? "sc-note" : "sc-err"}>{err}</p>}

      {step.errorKind === "guardrail_violation" && (
        <p className="sc-zero">
          {zeroAnswer
            ? "The answering model never saw this issue: 0 answer tokens. The guard models bill to a separate workspace."
            : "Stopped at the gateway before this call reached a model."}
        </p>
      )}

      {guards.length > 0 && (
        <ul className="guards" aria-label="Guard verdicts">
          {guards.map((g, i) => (
            <li key={`${g.profile}-${i}`} className={g.valid === false ? "g-held" : g.valid === true ? "g-pass" : "g-unknown"}>
              <code className="g-prof">{g.profile}</code>
              <span className="g-verdict">{g.valid === false ? "held" : g.valid === true ? "passed" : (g.status ?? "no verdict")}</span>
              {g.score !== null && <code className="g-score">score {g.score.toFixed(2)}</code>}
              {mode === "full" && g.detail && <span className="g-detail">{g.detail.replace(/_/g, " ")}</span>}
            </li>
          ))}
        </ul>
      )}

      {heldHere && heldReply && (
        <div className="sc-fixed">
          <p className="sc-fixed-label">Fixed reply, written by Porter without a model</p>
          <p className="sc-fixed-text">{heldReply}</p>
        </div>
      )}

      {mode === "full" ? (
        <>
          {step.requestId && (
            <p className="sc-rid">
              <span>Otari request</span>
              <CopyId value={step.requestId} label="Otari request id" />
            </p>
          )}
          {calls.length > 0 && <ul className="tcs">{calls.map((c, i) => <ToolCallView key={i} call={c} />)}</ul>}
        </>
      ) : (
        toolSummary(calls) && <p className="sc-tools">{toolSummary(calls)}</p>
      )}
    </article>
  );
}
