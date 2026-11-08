import { MarkdownReply } from "./MarkdownReply";
import { StatusBadge } from "./StatusBadge";
import { StepCard } from "./StepCard";
import { usd } from "./format";
import { errorText, heldBeforeAnyAnswer, holdKind, isSoftError } from "./runs";
import type { RunDetail } from "./types";

type GateState = { cls: string; text: string };

function gate(d: RunDetail): GateState {
  const s = d.run.status;
  if (s === "running") return { cls: "gate-live", text: d.steps.length ? "calls in progress" : "waiting for the first call" };
  if (s === "held_guardrail") return holdKind(d) === "output" ? { cls: "gate-pass", text: "passed" } : { cls: "gate-hold", text: "held here" };
  if (s === "refused_budget" || s === "blocked_author" || s === "refused_funds") return { cls: "gate-hold", text: "refused here" };
  if (s === "answered") return { cls: "gate-pass", text: "passed" };
  return { cls: "gate-muted", text: "did not complete" };
}

function Outcome({ d }: { d: RunDetail }) {
  const { status, reply } = d.run;
  const kind = holdKind(d);
  const zero = heldBeforeAnyAnswer(d.steps);
  switch (status) {
    case "running":
      return (
        <div className="outcome outcome-live" aria-live="polite">
          <span className="live-dot" aria-hidden="true" />
          {d.steps.length === 0 ? "Waiting for its turn at the gateway." : "Working: the next call is in flight."}
        </div>
      );
    case "answered":
      return (
        <div className="outcome outcome-ok">
          <p className="outcome-head">Reply</p>
          {reply ? <MarkdownReply text={reply} /> : <p className="muted">No reply text was stored.</p>}
        </div>
      );
    case "held_guardrail":
      return (
        <div className="outcome outcome-hold">
          <p className="outcome-head">
            {kind === "output" ? "Held by Porter’s output check" : "Held at the gateway"}
          </p>
          <p>
            {kind === "output"
              ? "The draft did not pass the output check, so it was not sent. The issue gets the fixed reply instead and a maintainer reviews it."
              : zero
                ? "The issue never reached the answering model and spent 0 answer tokens. It gets the fixed reply instead and a maintainer reviews it."
                : "A later call was held at the gateway. The issue gets the fixed reply instead and a maintainer reviews it."}
          </p>
        </div>
      );
    case "refused_budget":
      return (
        <div className="outcome outcome-hold">
          <p className="outcome-head">Refused by the author’s budget</p>
          <p>The gateway refused the call because this author’s daily budget is spent. Other authors are not affected.</p>
          {reply && (
            <div className="sc-fixed">
              <p className="sc-fixed-label">Fixed reply, written by Porter without a model</p>
              <p className="sc-fixed-text">{reply}</p>
            </div>
          )}
        </div>
      );
    case "blocked_author":
      return (
        <div className="outcome outcome-hold">
          <p className="outcome-head">Refused: the author is blocked</p>
          <p>A maintainer blocked this author at the gateway. No call reached a model and no reply is sent.</p>
        </div>
      );
    case "refused_funds":
      return (
        <div className="outcome outcome-warn">
          <p className="outcome-head">Stopped: Porter’s balance is low</p>
          <p>The gateway refused the call for lack of funds. No reply is posted, and new test issues pause until the balance is topped up.</p>
        </div>
      );
    case "failed": {
      const errs = d.steps.filter((s) => s.errorKind && !isSoftError(s.errorKind)).map((s) => errorText(s.errorKind, s.errorStatus));
      return (
        <div className="outcome outcome-warn">
          <p className="outcome-head">Failed</p>
          <p>Nothing was posted. {errs.length ? `Last error: ${errs[errs.length - 1]}.` : "No step recorded an error."}</p>
        </div>
      );
    }
    default:
      return (
        <div className="outcome">
          <p className="outcome-head">{status}</p>
        </div>
      );
  }
}

/** The run as it happened: the gateway line, each recorded call in order, then what came of it. */
export function RunTimeline({ detail, mode = "full" }: { detail: RunDetail | undefined; mode?: "full" | "compact" }) {
  if (!detail) {
    return (
      <div className="timeline" aria-busy="true">
        <div className="sk sk-line" />
        <div className="sk sk-card" />
        <div className="sk sk-card" />
      </div>
    );
  }
  const g = gate(detail);
  const zero = heldBeforeAnyAnswer(detail.steps);
  const fixed = detail.run.status === "held_guardrail" ? detail.run.reply : null;
  return (
    <div className="timeline" data-status={detail.run.status}>
      <div className="tl-top">
        <StatusBadge status={detail.run.status} />
        <span className="tl-figs">
          <span>
            {detail.steps.length} {detail.steps.length === 1 ? "step" : "steps"}
          </span>
          <code title="Total generation cost of the run">{usd(detail.run.totalCostUsd)}</code>
        </span>
      </div>
      <div className={`gate ${g.cls}`}>
        <span className="gate-name">Otari gateway</span>
        <span className="gate-rule" aria-hidden="true" />
        <span className="gate-state">{g.text}</span>
      </div>
      {detail.steps.length > 0 ? (
        <ol className="tl-steps">
          {detail.steps.map((s, i) => (
            <li key={s.id}>
              <StepCard step={s} index={i + 1} mode={mode} heldReply={fixed} zeroAnswer={zero} />
            </li>
          ))}
        </ol>
      ) : (
        detail.run.status !== "running" && <p className="muted tl-empty">No calls were recorded for this run.</p>
      )}
      <Outcome d={detail} />
    </div>
  );
}
