"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { noticeFor, postProposalDecision, type Notice as NoticeCopy } from "./api";
import { Notice } from "./Notice";
import type { Proposal } from "./types";

const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** What the proposal would do, in a maintainer's words. */
export function describeProposal(p: Pick<Proposal, "action" | "args">): { what: string; labels: string[]; repo: string | null } {
  const a = p.args ?? {};
  const repo = typeof a.repo === "string" ? a.repo : null;
  const issue = num(a.issue_number);
  const ref = issue === null ? "the issue" : `#${issue}`;
  if (p.action === "add_labels") {
    const labels = Array.isArray(a.labels) ? a.labels.filter((l): l is string => typeof l === "string") : [];
    return { what: `Add ${labels.length === 1 ? "a label" : "labels"} to ${ref}`, labels, repo };
  }
  if (p.action === "close_as_duplicate") {
    const dup = num(a.duplicate_of);
    return { what: `Close ${ref} as a duplicate of ${dup === null ? "another issue" : `#${dup}`}`, labels: [], repo };
  }
  return { what: p.action.replace(/_/g, " "), labels: [], repo };
}

/** The text an executed MCP call returned, when there is any. */
export function executionText(execution: unknown): string | null {
  if (!execution || typeof execution !== "object") return null;
  const e = execution as { content?: unknown; error?: unknown };
  if (typeof e.error === "string") return e.error;
  if (!Array.isArray(e.content)) return null;
  const parts = e.content
    .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .filter(Boolean);
  return parts.length ? parts.join("\n").slice(0, 600) : null;
}

const OUTCOME: Record<string, string> = {
  executed: "Executed with the maintainer key",
  rejected: "Rejected, nothing changed",
  failed: "The tool call failed; nothing was changed",
};

export function ProposalRow({
  proposal,
  showRun = false,
  readOnly = false,
  onDecided,
}: {
  proposal: Proposal;
  showRun?: boolean;
  /** Proposals outside the demo repository (eval and shadow runs) are recorded, never applied. */
  readOnly?: boolean;
  onDecided?: (id: number, status: string) => void;
}) {
  const [status, setStatus] = useState(proposal.status);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [notice, setNotice] = useState<NoticeCopy | null>(null);
  // A second click before the first answer must not send a second decision.
  const sending = useRef(false);
  const d = describeProposal(proposal);
  const current = proposal.status !== "pending" ? proposal.status : status;
  const result = executionText(proposal.execution);

  const decide = async (decision: "approve" | "reject") => {
    if (sending.current) return;
    sending.current = true;
    setBusy(decision);
    setNotice(null);
    const r = await postProposalDecision(proposal.id, decision);
    sending.current = false;
    setBusy(null);
    if (r.ok) {
      const next = r.data?.status ?? (decision === "approve" ? "executed" : "rejected");
      setStatus(next);
      onDecided?.(proposal.id, next);
    } else {
      setNotice(noticeFor(r, "proposal"));
      if (r.status === 409 || r.status === 502) onDecided?.(proposal.id, r.status === 502 ? "failed" : "unknown");
    }
  };

  return (
    <li className="prop">
      <div className="prop-main">
        <p className="prop-what">
          {d.what}
          {d.labels.length > 0 && (
            <span className="prop-labels">
              {d.labels.map((l) => (
                <code key={l} className="label">
                  {l}
                </code>
              ))}
            </span>
          )}
        </p>
        <p className="prop-meta">
          <code>{proposal.action}</code>
          {d.repo && <code>{d.repo}</code>}
          {showRun && (
            <Link href={`/console/runs/${proposal.runId}`} className="prop-run">
              {proposal.title?.trim() || "Run trace"}
            </Link>
          )}
        </p>
      </div>
      {current === "pending" && readOnly ? (
        <p className="prop-out">Pending. Only proposals for the demo repository can be approved here.</p>
      ) : current === "pending" ? (
        <div className="prop-actions">
          <button type="button" className="btn btn-sm btn-p" onClick={() => decide("approve")} disabled={busy !== null}>
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button type="button" className="btn btn-sm btn-g" onClick={() => decide("reject")} disabled={busy !== null}>
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      ) : (
        <p className={`prop-out prop-${current}`} role="status">
          {OUTCOME[current] ?? current}
          {result && current !== "rejected" && <span className="prop-result">{result}</span>}
        </p>
      )}
      {notice && <Notice notice={notice} tone="warn" />}
    </li>
  );
}
