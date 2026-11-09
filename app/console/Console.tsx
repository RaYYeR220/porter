"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { fetchProposals, fetchRun, fetchRuns, noticeFor, type ApiFail } from "../../components/app/api";
import { AuthorsPanel } from "../../components/app/AuthorsPanel";
import { ago, authorName, DASH, stamp, usd } from "../../components/app/format";
import { Notice } from "../../components/app/Notice";
import { ProposalRow } from "../../components/app/ProposalRow";
import { FILTERS, isTierDown, matchesFilter, modelName, type Filter } from "../../components/app/runs";
import { StatusBadge } from "../../components/app/StatusBadge";
import type { Proposal, RunRow } from "../../components/app/types";
import { useNow } from "../../components/app/useNow";
import { usePoll } from "../../components/app/usePoll";
import { WorkspaceCeiling } from "../../components/app/WorkspaceCeiling";

const PAGE = 50;
const SHOWN = 20;
const REFRESH_MS = 15_000;
/** The desk's own work: issues on the demo repository and the try page. Shadow and eval runs are opt-in. */
const DESK_SOURCES = ["github", "web"] as const;
const sourcesFor = (everything: boolean) => (everything ? undefined : DESK_SOURCES);

const FILTER_LABEL: Record<Filter, string> = { all: "All", answered: "Answered", held: "Held", refused: "Refused", failed: "Failed" };

/** Counts over the runs loaded, straight from the list: the API says how each hold happened. */
function Scoreboard({ rows }: { rows: RunRow[] }) {
  const count = (pick: (r: RunRow) => boolean) => rows.filter(pick).length;
  const cells = [
    { n: count((r) => r.heldBy === "gateway"), label: "held at the gateway", tone: "hold" },
    { n: count((r) => r.heldBy === "output"), label: "held by the output check", tone: "hold" },
    { n: count((r) => r.status === "refused_budget"), label: "refused by budget", tone: "hold" },
    { n: count((r) => r.status === "answered"), label: "answered", tone: "ok" },
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
            <dd>{c.n}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function QueueRow({ row, now }: { row: RunRow; now: number }) {
  // The triage model is the one an author's budget tier decides, so a tier-down shows here.
  const model = row.servedModel ?? null;
  const waiting = row.pendingProposals ?? 0;
  return (
    <tr>
      <td data-label="Status">
        <StatusBadge status={row.status} />
        {waiting > 0 && <span className="q-review">{waiting} waiting for approval</span>}
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
        <code className={isTierDown(model) ? "is-tier" : undefined} title={model ?? undefined}>
          {modelName(model) ?? DASH}
        </code>
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

/**
 * The maintainer's desk. A cold load is four reads: the runs list (GitHub and try-page runs unless
 * shadow and eval runs are asked for), the workspace ceiling, the demo repository's pending proposals
 * and the authors. A run's details are read only when someone opens it, or once after a decision
 * here, to show what the maintainer key's tool call returned.
 */
export function Console() {
  const now = useNow();
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<ApiFail | null>(null);
  const [older, setOlder] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(SHOWN);
  const [pending, setPending] = useState<Proposal[] | null>(null);
  const [propErr, setPropErr] = useState<ApiFail | null>(null);
  const [decided, setDecided] = useState<Proposal[]>([]);
  const [everything, setEverything] = useState(false);
  // What the queue shows right now, for answers that land after the scope was switched.
  const scope = useRef(false);

  const loadFirst = useCallback(async () => {
    const want = scope.current;
    const r = await fetchRuns({ limit: PAGE, sources: sourcesFor(want) });
    if (scope.current !== want) return;
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

  const loadProposals = useCallback(async () => {
    const r = await fetchProposals();
    if (r.ok) {
      setPending(r.data.proposals ?? []);
      setPropErr(null);
    } else {
      setPropErr(r);
    }
  }, []);

  const loadAll = useCallback(() => Promise.all([loadFirst(), loadProposals()]), [loadFirst, loadProposals]);
  usePoll(loadAll, REFRESH_MS);

  const loadOlder = async () => {
    if (!cursor) return;
    const want = scope.current;
    setOlder(true);
    const r = await fetchRuns({ limit: PAGE, cursor, sources: sourcesFor(want) });
    setOlder(false);
    if (scope.current !== want) return;
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

  const switchScope = (next: boolean) => {
    scope.current = next;
    setEverything(next);
    setRows(null);
    setCursor(null);
    setShown(SHOWN);
    setLoadErr(null);
    void loadFirst();
  };

  const all = useMemo(() => rows ?? [], [rows]);
  const filtered = all.filter((r) => matchesFilter(r, filter));
  const visible = filtered.slice(0, shown);

  // Decided here stays on screen with its outcome, newest first, above what is still waiting.
  const proposals = [...decided, ...(pending ?? []).filter((p) => !decided.some((x) => x.id === p.id))];

  const onDecided = (p: Proposal) => async (_id: number, status: string) => {
    if (status === "unknown") {
      // Someone else decided first: the next read of the list drops it.
      void loadProposals();
      return;
    }
    setDecided((list) => [{ ...p, status }, ...list.filter((x) => x.id !== p.id)]);
    const r = await fetchRun(p.runId);
    const stored = r.ok ? r.data.proposals.find((x) => x.id === p.id) : undefined;
    if (stored) setDecided((list) => list.map((x) => (x.id === p.id ? { ...x, ...stored, title: p.title } : x)));
  };

  return (
    <>
      {loadErr && <Notice notice={noticeFor(loadErr, "read")} tone="warn" />}

      {rows === null && !loadErr ? <div className="sk sk-score" aria-busy="true" /> : rows && <Scoreboard rows={all} />}

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
          <p className="panel-note queue-scope">
            <span>{everything ? "Every run, shadow runs and eval cases included." : "Issues on the demo repository and from the try page."}</span>
            <label className="scope-toggle">
              <input type="checkbox" checked={everything} onChange={(e) => switchScope(e.target.checked)} />
              Include shadow and eval runs
            </label>
          </p>

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
                    <QueueRow key={r.id} row={r} now={now} />
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

        <div className="console-side">
          <WorkspaceCeiling />

          <section className="panel proposals" aria-labelledby="proposals-title">
            <div className="panel-head">
              <h2 id="proposals-title" className="panel-title">
                Waiting for approval
              </h2>
            </div>
            <p className="panel-note">Labels and duplicate closes Porter proposed. Approving runs them with the maintainer key, not the stranger’s.</p>
            {propErr && pending === null ? (
              <Notice notice={noticeFor(propErr, "read")} />
            ) : pending === null ? (
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
      </div>

      <AuthorsPanel />
    </>
  );
}
