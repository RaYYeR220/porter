"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { fetchRuns, noticeFor, type ApiFail } from "../../components/app/api";
import { AuthorsPanel } from "../../components/app/AuthorsPanel";
import { ago, authorName, DASH, stamp, usd } from "../../components/app/format";
import { Notice } from "../../components/app/Notice";
import { ProposalRow } from "../../components/app/ProposalRow";
import { FILTERS, holdKind, isTierDown, matchesFilter, modelName, servedModelOf, triageModel, type Filter } from "../../components/app/runs";
import { StatusBadge } from "../../components/app/StatusBadge";
import type { Proposal, RunDetail, RunRow } from "../../components/app/types";
import { useNow } from "../../components/app/useNow";
import { usePoll } from "../../components/app/usePoll";
import { useRunDetails } from "../../components/app/useRunDetails";

const PAGE = 50;
const SHOWN = 20;
const REFRESH_MS = 15_000;

const FILTER_LABEL: Record<Filter, string> = { all: "All", answered: "Answered", held: "Held", refused: "Refused", failed: "Failed" };

function Scoreboard({ rows, details }: { rows: RunRow[]; details: Record<string, RunDetail> }) {
  const held = rows.filter((r) => r.status === "held_guardrail");
  const heldKnown = held.every((r) => details[r.id]);
  const gateway = held.filter((r) => details[r.id] && holdKind(details[r.id]) === "gateway").length;
  const output = held.filter((r) => details[r.id] && holdKind(details[r.id]) === "output").length;
  const cells = [
    { n: heldKnown ? gateway : null, label: "held at the gateway", tone: "hold" },
    { n: heldKnown ? output : null, label: "held by the output check", tone: "hold" },
    { n: rows.filter((r) => r.status === "refused_budget").length, label: "refused by budget", tone: "hold" },
    { n: rows.filter((r) => r.status === "answered").length, label: "answered", tone: "ok" },
  ];
  return (
    <section className="score" aria-labelledby="score-title">
      <h2 id="score-title" className="score-title">
        {rows.length === 0 ? "No runs yet" : `Last ${rows.length} ${rows.length === 1 ? "run" : "runs"}`}
      </h2>
      <dl className="score-cells">
        {cells.map((c) => (
          <div key={c.label} className={`score-cell score-${c.tone}`}>
            <dt>{c.label}</dt>
            <dd>{c.n === null ? <span className="sk sk-fig" aria-label="counting" /> : c.n}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function QueueRow({ row, detail, now }: { row: RunRow; detail: RunDetail | undefined; now: number }) {
  // The triage model is the one an author's budget tier decides, so a tier-down shows here.
  const model = detail ? (triageModel(detail.steps) ?? servedModelOf(detail.steps)) : null;
  return (
    <tr>
      <td data-label="Status">
        <StatusBadge status={row.status} />
        {detail?.reviewItem && <span className="q-review">needs review</span>}
      </td>
      <th scope="row" data-label="Issue" className="q-title">
        <Link href={`/console/runs/${row.id}`}>{row.title?.trim() || "Untitled issue"}</Link>
        <span className="q-repo">
          <code>
            {row.repo}
            {row.issueNumber !== null ? `#${row.issueNumber}` : ""}
          </code>
          <span>{row.source === "web" ? "try page" : row.source}</span>
        </span>
      </th>
      <td data-label="Author">{authorName(row.authorExternalId)}</td>
      <td data-label="Model">
        {detail ? (
          <code className={isTierDown(model) ? "is-tier" : undefined} title={model ?? undefined}>
            {modelName(model) ?? DASH}
          </code>
        ) : (
          <span className="sk sk-text" aria-label="loading" />
        )}
      </td>
      <td data-label="Cost">
        <code>{row.status === "running" ? DASH : usd(row.totalCostUsd)}</code>
      </td>
      <td data-label="Age" title={stamp(row.createdAt)}>
        {now ? ago(row.createdAt, now) : DASH}
      </td>
    </tr>
  );
}

export function Console() {
  const now = useNow();
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<ApiFail | null>(null);
  const [older, setOlder] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(SHOWN);
  const [decided, setDecided] = useState<Proposal[]>([]);

  const loadFirst = useCallback(async () => {
    const r = await fetchRuns({ limit: PAGE });
    if (!r.ok) {
      setLoadErr(r);
      return;
    }
    setLoadErr(null);
    setRows((prev) => {
      const fresh = r.data.runs;
      if (!prev) return fresh;
      // Keep pages loaded with "Load older runs": rows older than the oldest fresh one.
      const ids = new Set(fresh.map((x) => x.id));
      const oldest = fresh[fresh.length - 1]?.createdAt;
      return [...fresh, ...prev.filter((x) => !ids.has(x.id) && oldest !== undefined && x.createdAt < oldest)];
    });
    setCursor((c) => c ?? r.data.nextCursor);
  }, []);

  usePoll(loadFirst, REFRESH_MS);

  const loadOlder = async () => {
    if (!cursor) return;
    setOlder(true);
    const r = await fetchRuns({ limit: PAGE, cursor });
    setOlder(false);
    if (!r.ok) {
      setLoadErr(r);
      return;
    }
    setRows((prev) => {
      const have = new Set((prev ?? []).map((x) => x.id));
      return [...(prev ?? []), ...r.data.runs.filter((x) => !have.has(x.id))];
    });
    setCursor(r.data.nextCursor);
    setShown((n) => n + PAGE);
  };

  const all = useMemo(() => rows ?? [], [rows]);
  const filtered = all.filter((r) => matchesFilter(r, filter));
  const visible = filtered.slice(0, shown);
  // Details are read for what is on screen, for held runs (the scoreboard splits them) and for answered
  // GitHub issues (the only runs whose proposals this console can approve).
  const actionable = (r: RunRow) => r.source === "github" && r.status === "answered" && r.issueNumber !== null;
  const needDetail = all.filter((r) => visible.includes(r) || r.status === "held_guardrail" || actionable(r));
  const { details, invalidate } = useRunDetails(needDetail);

  const stored = Object.values(details)
    .filter((d) => d.run.source === "github")
    .flatMap((d) => d.proposals);
  const latest = (p: Proposal) => stored.find((x) => x.id === p.id && x.status !== "pending") ?? p;
  const pending = stored.filter((p) => p.status === "pending" && !decided.some((x) => x.id === p.id));
  // Decided here stays on screen with its outcome; the run is read again for the execution result.
  const proposals = [...pending, ...decided.map(latest)].sort((a, b) => a.id - b.id);

  const onDecided = (p: Proposal) => (_id: number, status: string) => {
    if (status !== "unknown") setDecided((list) => [...list.filter((x) => x.id !== p.id), { ...p, status }]);
    invalidate(p.runId);
  };

  return (
    <>
      {loadErr && <Notice notice={noticeFor(loadErr, "read")} tone="warn" />}

      {rows === null && !loadErr ? <div className="sk sk-score" aria-busy="true" /> : rows && <Scoreboard rows={all} details={details} />}

      <div className="console-grid">
        <section className="panel queue" aria-labelledby="queue-title">
          <div className="panel-head">
            <h2 id="queue-title" className="panel-title">
              Queue
            </h2>
            <div className="filters" role="group" aria-label="Filter runs by outcome">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className="filter"
                  aria-pressed={filter === f}
                  onClick={() => {
                    setFilter(f);
                    setShown(SHOWN);
                  }}
                >
                  {FILTER_LABEL[f]}
                  <span className="filter-n">{all.filter((r) => matchesFilter(r, f)).length}</span>
                </button>
              ))}
            </div>
          </div>

          {rows === null && !loadErr ? (
            <div className="sk-rows" aria-busy="true">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="sk sk-row" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              {filter === "all" ? (
                <>
                  <p className="empty-title">No runs yet.</p>
                  <p>
                    Runs appear here as issues arrive, from GitHub or from the <Link href="/try">try page</Link>.
                  </p>
                </>
              ) : (
                <p className="empty-title">No {FILTER_LABEL[filter].toLowerCase()} runs among the last {all.length}.</p>
              )}
            </div>
          ) : (
            <>
              <table className="tbl tbl-queue">
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Issue</th>
                    <th scope="col">Author</th>
                    <th scope="col">Model</th>
                    <th scope="col">Cost</th>
                    <th scope="col">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <QueueRow key={r.id} row={r} detail={details[r.id]} now={now} />
                  ))}
                </tbody>
              </table>
              <div className="queue-foot">
                {filtered.length > visible.length ? (
                  <button type="button" className="btn btn-sm btn-g" onClick={() => setShown((n) => n + SHOWN)}>
                    Show {Math.min(SHOWN, filtered.length - visible.length)} more
                  </button>
                ) : cursor ? (
                  <button type="button" className="btn btn-sm btn-g" onClick={loadOlder} disabled={older}>
                    {older ? "Loading…" : "Load older runs"}
                  </button>
                ) : (
                  <span className="muted small">That is every run.</span>
                )}
              </div>
            </>
          )}
        </section>

        <section className="panel proposals" aria-labelledby="proposals-title">
          <div className="panel-head">
            <h2 id="proposals-title" className="panel-title">
              Waiting for approval
            </h2>
          </div>
          <p className="panel-note">Labels and duplicate closes Porter proposed. Approving runs them with the maintainer key, not the stranger’s.</p>
          {rows === null ? (
            <div className="sk-rows" aria-busy="true">
              <div className="sk sk-row" />
            </div>
          ) : proposals.length === 0 ? (
            <div className="empty">
              <p className="empty-title">Nothing waiting.</p>
              <p>Proposals come from answered GitHub issues. Issues filed on the try page get a reply only.</p>
            </div>
          ) : (
            <ul className="props">
              {proposals.map((p) => (
                <ProposalRow key={p.id} proposal={p} showRun onDecided={onDecided(p)} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <AuthorsPanel />
    </>
  );
}
