import Link from "next/link";
import type { ReactNode } from "react";
import { stamp, usd } from "../app/format";
import { StatusBadge } from "../app/StatusBadge";
import { claimState, precisionLine, runHref, safeHttpUrl, sampleText } from "../../lib/site/evidence";
import type { Loaded } from "../../lib/site/evidence";
import type { ShadowReport as Report } from "../../lib/site/results";
import { SHADOW_REPO, issueUrl } from "../../lib/shadow-summary";
import type { ShadowIssue } from "../../lib/shadow-summary";
import { FileState } from "./FileState";
import { VerifyChip } from "./VerifyChip";

function ReadOnly() {
  return (
    <p className="sh-readonly" data-readonly>
      <i aria-hidden="true" />
      Read-only: nothing was posted to Otari’s tracker. In quoted issue text, names of commercial AI assistants and
      their vendor appear as [assistant] and [vendor].
    </p>
  );
}

function Claims({ issue }: { issue: ShadowIssue }) {
  const rows: Array<{ key: string; dt: string; dd: ReactNode }> = [];
  if (issue.kind) rows.push({ key: "kind", dt: "Kind", dd: issue.kind });
  if (issue.duplicates.length > 0) {
    rows.push({
      key: "dup",
      dt: "Claims duplicate of",
      dd: (
        <ul className="sh-cl">
          {issue.duplicates.map((d) => (
            <li key={d.number} data-claim-kind="duplicate">
              <span className="sh-cl-what">
                <a href={issueUrl(d.number)}>#{d.number}</a>
                {d.title && <span className="sh-cl-title"> {d.title}</span>}
              </span>
              <VerifyChip state={claimState(d)} />
              {d.why && <span className="sh-why">Porter’s reason: {d.why}</span>}
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (issue.fixed_in) {
    const ev = safeHttpUrl(issue.fixed_in.evidence_url);
    rows.push({
      key: "fixed",
      dt: "Claims fixed in",
      dd: (
        <ul className="sh-cl">
          <li data-claim-kind="fixed">
            <span className="sh-cl-what">
              <code>{issue.fixed_in.version}</code>
              {ev && (
                <>
                  {" "}
                  <a className="sh-ev" href={ev} rel="nofollow noreferrer">
                    cited source
                  </a>
                </>
              )}
            </span>
            <VerifyChip state={claimState(issue.fixed_in)} />
          </li>
        </ul>
      ),
    });
  }
  if (issue.missing_info.length > 0) {
    rows.push({
      key: "missing",
      dt: "Asks the reporter for",
      dd: (
        <ul className="sh-missing">
          {issue.missing_info.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ),
    });
  }
  if (issue.labels.length > 0) {
    rows.push({
      key: "labels",
      dt: "Suggested labels",
      dd: (
        <span className="sh-labels">
          {issue.labels.map((l) => (
            <span key={l} className="tag">
              {l}
            </span>
          ))}
        </span>
      ),
    });
  }
  if (rows.length === 0) {
    return <p className="sh-none">{issue.status === "answered" ? "No claims beyond the reply." : "No triage stored for this run, so no claims."}</p>;
  }
  return (
    <dl className="sh-claims">
      {rows.map((r) => (
        <div key={r.key} data-row={r.key}>
          <dt>{r.dt}</dt>
          <dd>{r.dd}</dd>
        </div>
      ))}
    </dl>
  );
}

function Issue({ issue }: { issue: ShadowIssue }) {
  const trace = runHref(issue.runId);
  return (
    <li className="sh-issue" data-issue={issue.number}>
      <div className="sh-head">
        <a className="sh-num" href={issueUrl(issue.number)}>
          #{issue.number}
        </a>
        <h3 className="sh-title">
          <a href={issueUrl(issue.number)}>{issue.title}</a>
        </h3>
        <div className="sh-meta">
          <StatusBadge status={issue.status} />
          {issue.sampledBy.mode === "ids" && <span className="tag">added by number</span>}
          <code>{usd(issue.costUsd)}</code>
          {trace && (
            <Link className="ev-link" href={trace}>
              Run trace
            </Link>
          )}
        </div>
      </div>
      <Claims issue={issue} />
    </li>
  );
}

function NotRun() {
  return (
    <div className="empty ev-empty sh-empty">
      <p className="empty-title">Not run yet</p>
      <p>
        When it runs, Porter takes a sample of open issues from a read-only snapshot of <code>{SHADOW_REPO}</code>: half the newest, half picked
        at random with a fixed seed, leaving out the issues the eval already uses. Each goes through the same pipeline as a stranger’s issue.
      </p>
      <p>
        What Porter claims about duplicates and fixes is listed here as unchecked until a person checks each claim by hand. Only those checks
        count toward the share of correct claims, and a claim about an issue outside the snapshot is never counted.
      </p>
    </div>
  );
}

export function ShadowReport({ loaded }: { loaded: Loaded<Report> }) {
  return (
    <div className="wrap app ev sh">
      <header className="app-head ev-head">
        <h1>Porter on Otari’s own tracker</h1>
        <ReadOnly />
        <p>
          Porter triaged open issues from <code>{SHADOW_REPO}</code> the way it would answer a stranger: what kind of issue it is, possible
          duplicates, whether it looks fixed already, what is missing and which labels fit. The results stay on this page.
        </p>
      </header>

      {loaded.state === "missing" && <NotRun />}
      {loaded.state === "error" && (
        <div className="notice notice-warn" role="status">
          <p className="notice-title">The report file is there but can’t be shown</p>
          <p>
            <FileState loaded={loaded} />
          </p>
        </div>
      )}
      {loaded.state === "ok" && <Body report={loaded.data} />}
    </div>
  );
}

function Body({ report }: { report: Report }) {
  const { file, summary: s } = report;
  const checked = s.checked > 0 && s.precision !== null;
  return (
    <>
      <dl className="facts sh-facts">
        <div>
          <dt>Sample</dt>
          <dd>{sampleText(file)}</dd>
        </div>
        <div>
          <dt>Sampled</dt>
          <dd>{stamp(file.sampledAt)}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>{stamp(file.snapshotAt)}</dd>
        </div>
        <div>
          <dt>Total cost</dt>
          <dd>
            <code>{usd(s.costUsd)}</code>
          </dd>
        </div>
        <div>
          <dt>Outcomes</dt>
          <dd>
            {s.answered} answered, {s.held} held, {s.refused} refused, {s.failed} failed
          </dd>
        </div>
      </dl>

      <p className={`ev-sentence sh-precision${checked ? "" : " ev-sentence-none"}`} data-precision={checked ? "checked" : "unchecked"}>
        {precisionLine(s)}
      </p>
      <p className="sh-precision-note">
        {s.claims} {s.claims === 1 ? "claim" : "claims"} can be checked: duplicates inside the snapshot, plus fixed-in versions.
        {s.dangling > 0 &&
          (s.dangling === 1
            ? " 1 more points at an issue outside the snapshot and is not counted."
            : ` ${s.dangling} more point at issues outside the snapshot and are not counted.`)}{" "}
        Every claim below says whether a person has checked it.
      </p>

      <section className="panel" aria-labelledby="sh-list">
        <div className="panel-head">
          <h2 id="sh-list" className="panel-title">
            Sampled issues
          </h2>
          <p className="sh-count">
            {file.issues.length} {file.issues.length === 1 ? "issue" : "issues"}
          </p>
        </div>
        {file.issues.length === 0 ? <p className="empty">The file lists no issues yet.</p> : <ol className="sh-list">{file.issues.map((i) => <Issue key={i.number} issue={i} />)}</ol>}
      </section>
    </>
  );
}
