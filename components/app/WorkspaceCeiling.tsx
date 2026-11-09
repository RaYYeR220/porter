"use client";

import { useCallback, useState } from "react";
import { fetchCeiling } from "./api";
import { DASH, resetText, stamp, usd } from "./format";
import type { Ceiling } from "./types";
import { useNow } from "./useNow";
import { usePoll } from "./usePoll";

/** The server caches the gateway's answer for a minute, so reading more often shows nothing new. */
export const CEILING_REFRESH_MS = 60_000;

/** The desk's daily ceiling at the gateway: what every stranger's calls can still spend today, together. */
export function WorkspaceCeiling() {
  const now = useNow();
  // undefined: not read yet; null: the gateway did not say.
  const [ceiling, setCeiling] = useState<Ceiling | null | undefined>(undefined);

  const load = useCallback(async () => {
    const r = await fetchCeiling();
    setCeiling(r.ok && r.data?.ceiling ? r.data.ceiling : null);
  }, []);
  usePoll(load, CEILING_REFRESH_MS);

  return (
    <section className="panel ceiling" aria-labelledby="ceiling-title">
      <div className="panel-head">
        <h2 id="ceiling-title" className="panel-title">
          Workspace ceiling
        </h2>
      </div>
      <p className="panel-note">What the desk can still spend today across every author, as Otari reports it for the strangers key.</p>
      {ceiling === undefined ? (
        <div className="sk sk-line" aria-busy="true" />
      ) : ceiling === null ? (
        <p className="muted small">Unavailable right now. The gateway enforces the ceiling either way.</p>
      ) : (
        <>
          <dl className="ceiling-facts">
            <div className="ceiling-left">
              <dt>Left today</dt>
              <dd>
                <code>{usd(ceiling.remainingUsd)}</code>
                {ceiling.limitUsd !== null && (
                  <span className="ceiling-of">
                    {" "}
                    of <code>{usd(ceiling.limitUsd)}</code>
                  </span>
                )}
              </dd>
            </div>
            {ceiling.usedUsd !== null && (
              <div>
                <dt>Spent today</dt>
                <dd>
                  <code>{usd(ceiling.usedUsd)}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>Resets</dt>
              <dd>
                {ceiling.resetsAt ? (
                  <>
                    {stamp(ceiling.resetsAt)}
                    {now ? <span className="ceiling-in">{resetText(ceiling.resetsAt, now).replace(/^resets /, "")}</span> : null}
                  </>
                ) : (
                  DASH
                )}
              </dd>
            </div>
          </dl>
          {!ceiling.enforced && <p className="muted small ceiling-note">Budgets are not enforced on this key right now.</p>}
        </>
      )}
    </section>
  );
}
