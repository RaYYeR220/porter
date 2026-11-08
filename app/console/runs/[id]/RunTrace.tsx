"use client";

import Link from "next/link";
import { noticeFor } from "../../../../components/app/api";
import { CodeBlock } from "../../../../components/app/CodeBlock";
import { CopyId } from "../../../../components/app/CopyId";
import { authorName, duration, stamp, usd } from "../../../../components/app/format";
import { Notice } from "../../../../components/app/Notice";
import { ProposalRow } from "../../../../components/app/ProposalRow";
import { RunTimeline } from "../../../../components/app/RunTimeline";
import { StatusBadge } from "../../../../components/app/StatusBadge";
import { useRunPolling } from "../../../../components/app/useRunPolling";

const SOURCE: Record<string, string> = { github: "GitHub issue", web: "Try page", eval: "Eval case", shadow: "Shadow run" };

export function RunTrace({ id }: { id: string }) {
  const { runs, errors, paused } = useRunPolling([id]);
  const d = runs[id];
  const err = errors[id];

  if (!d && err && (err.status === 404 || err.status === 400)) {
    return (
      <header className="trace-head">
        <p className="crumb">
          <Link href="/console">Console</Link>
          <span aria-hidden="true">/</span>
          <span>Run</span>
        </p>
        <h1>No run with this id</h1>
        <p className="trace-missing">
          It may have been removed. The <Link href="/console">console</Link> lists every run.
        </p>
      </header>
    );
  }

  const run = d?.run;
  const took = run?.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime() : null;

  return (
    <>
      <header className="trace-head">
        <p className="crumb">
          <Link href="/console">Console</Link>
          <span aria-hidden="true">/</span>
          <span>Run</span>
        </p>
        {run ? (
          <>
            <h1>{run.title?.trim() || "Untitled issue"}</h1>
            <dl className="facts">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={run.status} />
                </dd>
              </div>
              <div>
                <dt>Author</dt>
                <dd>
                  {authorName(run.authorExternalId)}
                  {run.authorExternalId && <code className="dim"> {run.authorExternalId}</code>}
                </dd>
              </div>
              <div>
                <dt>From</dt>
                <dd>
                  {SOURCE[run.source] ?? run.source}
                  <code className="dim">
                    {" "}
                    {run.repo}
                    {run.issueNumber !== null ? `#${run.issueNumber}` : ""}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Total cost</dt>
                <dd>
                  <code>{usd(run.totalCostUsd)}</code>
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{stamp(run.createdAt)}</dd>
              </div>
              <div>
                <dt>Took</dt>
                <dd>
                  <code>{duration(took)}</code>
                </dd>
              </div>
            </dl>
            <p className="trace-id">
              <span>Run</span>
              <CopyId value={run.id} label="run id" />
              <span>Otari conversation</span>
              <CopyId value={`run-${run.id}`} label="Otari conversation id" />
            </p>
            {d.reviewItem && <p className="trace-flag">Waiting for a maintainer to review this hold.</p>}
            {d.queued && <p className="trace-flag">A reply is queued for posting to GitHub.</p>}
          </>
        ) : (
          <div aria-busy="true">
            <h1 className="sr-only">Run trace</h1>
            <div className="sk sk-h1" />
            <div className="sk sk-facts" />
          </div>
        )}
      </header>

      {err && !d && <Notice notice={noticeFor(err, "read")} tone="warn" />}
      {paused && <p className="muted small">Updates resume when this tab is visible.</p>}

      {run && (
        <details className="issue-text">
          <summary>Issue text, as the gateway read it</summary>
          <CodeBlock label="Title" code={run.title ?? ""} />
          <CodeBlock label="Body" code={run.body ?? ""} max={12_000} />
        </details>
      )}

      <section className="trace-steps" aria-labelledby="steps-title">
        <h2 id="steps-title" className="panel-title">
          Steps
        </h2>
        <RunTimeline detail={d} mode="full" />
      </section>

      {d && d.guardVerdicts.length > 0 && (
        <section className="panel" aria-labelledby="verdicts-title">
          <h2 id="verdicts-title" className="panel-title">
            Guard service log
          </h2>
          <table className="tbl tbl-verdicts">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Verdict</th>
                <th scope="col">Score</th>
                <th scope="col">Latency</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {d.guardVerdicts.map((g) => (
                <tr key={g.id}>
                  <th scope="row" data-label="Profile">
                    <code>{g.profile}</code>
                  </th>
                  <td data-label="Verdict">{g.valid ? "passed" : <span className="tag tag-hold">held</span>}</td>
                  <td data-label="Score">
                    <code>{g.score === null ? "—" : g.score.toFixed(2)}</code>
                  </td>
                  <td data-label="Latency">
                    <code>{duration(g.latencyMs)}</code>
                  </td>
                  <td data-label="Why">{g.explanation ? g.explanation.replace(/_/g, " ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {d && (
        <section className="panel" aria-labelledby="run-props-title">
          <h2 id="run-props-title" className="panel-title">
            Proposals
          </h2>
          {d.proposals.length === 0 ? (
            <p className="muted">
              {d.run.issueNumber === null ? "None: issues from the try page get a reply only." : "Porter proposed no labels or duplicate close for this issue."}
            </p>
          ) : (
            <ul className="props">
              {d.proposals.map((p) => (
                <ProposalRow key={p.id} proposal={p} readOnly={d.run.source !== "github"} />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
