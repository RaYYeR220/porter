"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { fetchAuthors, noticeFor, postAuthorAction, type ApiFail, type Notice as NoticeCopy } from "./api";
import { BudgetMeter } from "./BudgetMeter";
import { ago } from "./format";
import { Notice } from "./Notice";
import type { Author } from "./types";
import { useNow } from "./useNow";
import { usePoll } from "./usePoll";

export const AUTHORS_REFRESH_MS = 30_000;

type Action = "block" | "unblock" | "upgrade" | "downgrade";

/** The author as it will look once the gateway applies the action. The cap follows on the next read. */
function applied(a: Author, action: Action): Author {
  switch (action) {
    case "block":
      return { ...a, blocked: true };
    case "unblock":
      return { ...a, blocked: false };
    case "upgrade":
      return { ...a, tier: "regular" };
    case "downgrade":
      return { ...a, tier: "newcomer" };
  }
}

const DONE: Record<Action, string> = { block: "blocked", unblock: "unblocked", upgrade: "moved to the regular budget", downgrade: "moved to the newcomer budget" };
const VERB: Record<Action, string> = { block: "Block", unblock: "Unblock", upgrade: "Upgrade", downgrade: "Downgrade" };

export function AuthorsPanel() {
  const now = useNow();
  const [authors, setAuthors] = useState<Author[] | null>(null);
  const [loadErr, setLoadErr] = useState<ApiFail | null>(null);
  const [busy, setBusy] = useState<Record<string, Action | undefined>>({});
  const [notice, setNotice] = useState<NoticeCopy | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetchAuthors();
    if (r.ok) {
      setAuthors(r.data.authors ?? []);
      setLoadErr(null);
    } else {
      setLoadErr(r);
    }
  }, []);

  usePoll(load, AUTHORS_REFRESH_MS);

  const act = async (a: Author, action: Action) => {
    const before = a;
    setNotice(null);
    setDone(null);
    setBusy((b) => ({ ...b, [a.id]: action }));
    setAuthors((list) => list?.map((x) => (x.id === a.id ? applied(x, action) : x)) ?? list);
    const r = await postAuthorAction(a.id, action);
    setBusy((b) => ({ ...b, [a.id]: undefined }));
    if (!r.ok) {
      setAuthors((list) => list?.map((x) => (x.id === a.id ? before : x)) ?? list);
      const n = noticeFor(r, "author");
      setNotice({ title: `${VERB[action]} ${a.display} was not applied`, body: `${n.title}. ${n.body}` });
      return;
    }
    setDone(`${a.display} ${DONE[action]} at the gateway.`);
    void load();
  };

  const refreshed = authors?.map((a) => a.refreshedAt).filter((v): v is string => !!v).sort().pop() ?? null;

  return (
    <section className="panel authors" aria-labelledby="authors-title">
      <div className="panel-head">
        <h2 id="authors-title" className="panel-title">
          Authors
        </h2>
      </div>
      <p className="panel-note">
        Every stranger is an end user at Otari with a daily budget. Blocks and tier changes are applied there.
        {refreshed && now ? ` Spend as of ${ago(refreshed, now)}.` : ""}
      </p>

      {loadErr && !authors && <Notice notice={noticeFor(loadErr, "read")} tone="warn" />}
      {notice && <Notice notice={notice} tone="warn" />}
      <p className="au-done" role="status">
        {done ?? ""}
      </p>

      {authors === null && !loadErr ? (
        <div className="sk-rows" aria-busy="true">
          <div className="sk sk-row" />
          <div className="sk sk-row" />
          <div className="sk sk-row" />
        </div>
      ) : authors && authors.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No authors yet.</p>
          <p>
            Everyone who files an issue, on GitHub or on the <Link href="/try">try page</Link>, shows up here with their own budget.
          </p>
        </div>
      ) : authors ? (
        <table className="tbl tbl-authors">
          <thead>
            <tr>
              <th scope="col">Author</th>
              <th scope="col">Tier</th>
              <th scope="col">Budget used</th>
              <th scope="col">Requests</th>
              <th scope="col">State</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {authors.map((a) => {
              const pending = busy[a.id];
              return (
                <tr key={a.id} data-blocked={a.blocked || undefined}>
                  <th scope="row" data-label="Author">
                    <span>
                      <span className="au-name">{a.display}</span>
                      <code className="au-id">{a.id}</code>
                    </span>
                  </th>
                  <td data-label="Tier">
                    <span className={`tier tier-${a.tier}`}>{a.tier}</span>
                  </td>
                  <td data-label="Budget used" className="au-meter">
                    <BudgetMeter
                      spendUsd={a.spendUsd}
                      limitUsd={a.budgetLimitUsd}
                      nextResetAt={a.nextResetAt}
                      compact
                      label={`Budget used by ${a.display}`}
                    />
                  </td>
                  <td data-label="Requests">
                    <code>{a.requests}</code>
                  </td>
                  <td data-label="State">
                    {a.blocked ? <span className="tag tag-hold">blocked</span> : <span className="au-active">active</span>}
                  </td>
                  <td className="au-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-g"
                      disabled={!!pending}
                      onClick={() => act(a, a.blocked ? "unblock" : "block")}
                      aria-label={`${a.blocked ? "Unblock" : "Block"} ${a.display}`}
                    >
                      {a.blocked ? "Unblock" : "Block"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-g"
                      disabled={!!pending}
                      onClick={() => act(a, a.tier === "regular" ? "downgrade" : "upgrade")}
                      aria-label={a.tier === "regular" ? `Downgrade ${a.display} to newcomer` : `Upgrade ${a.display} to regular`}
                    >
                      {a.tier === "regular" ? "Downgrade" : "Upgrade"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
