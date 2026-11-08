"use client";

import Link from "next/link";
import { Fragment } from "react";
import { DASH, resetText, usd } from "./format";
import { isTierDown, modelName, TIER_DOWN_MODEL, triageModel } from "./runs";
import { StatusBadge } from "./StatusBadge";
import type { Author, RunDetail } from "./types";
import { useNow } from "./useNow";

/**
 * The spam wave: one author's twelve issues, run one after another. The rows show the moment the
 * routing policy moves the author to the smaller model, and the moment the gateway starts refusing.
 */
export function WaveColumn({
  ids,
  runs,
  author,
  now,
}: {
  ids: readonly string[];
  runs: Record<string, RunDetail | undefined>;
  author: Author | null | undefined;
  now?: number;
}) {
  const clock = useNow();
  const t = now ?? clock;
  const models = ids.map((id) => {
    const d = runs[id];
    return d ? triageModel(d.steps) : null;
  });
  const firstTier = models.findIndex((m) => isTierDown(m));
  const firstRefusal = ids.findIndex((id) => runs[id]?.run.status === "refused_budget");

  const counts = { answered: 0, held: 0, refused: 0, other: 0 };
  let cost = 0;
  for (const id of ids) {
    const d = runs[id];
    if (!d) continue;
    cost += d.run.totalCostUsd ?? 0;
    const s = d.run.status;
    if (s === "answered") counts.answered++;
    else if (s === "held_guardrail") counts.held++;
    else if (s === "refused_budget" || s === "blocked_author") counts.refused++;
    else if (s !== "running") counts.other++;
  }

  return (
    <div className="wave">
      <p className="wave-sum">
        <span>
          <b>{counts.answered}</b> answered
        </span>
        <span>
          <b>{counts.refused}</b> refused by budget
        </span>
        {counts.held > 0 && (
          <span>
            <b>{counts.held}</b> held
          </span>
        )}
        {counts.other > 0 && (
          <span>
            <b>{counts.other}</b> other
          </span>
        )}
        <span>
          <code>{usd(cost)}</code> spent on this wave
        </span>
      </p>
      <ol className="wave-rows">
        {ids.map((id, i) => {
          const d = runs[id];
          const status = d?.run.status ?? "running";
          const waiting = !d || (status === "running" && d.steps.length === 0);
          return (
            <Fragment key={id}>
              {i === firstTier && i > 0 && (
                <li className="wave-mark wave-mark-tier" aria-label="Tier-down">
                  <span className="wm-rule" aria-hidden="true" />
                  <span>
                    Tier-down: from issue {i + 1}, Otari serves <code>{TIER_DOWN_MODEL}</code> to this author
                  </span>
                </li>
              )}
              {i === firstRefusal && (
                <li className="wave-mark wave-mark-cap" aria-label="Budget spent">
                  <span className="wm-rule" aria-hidden="true" />
                  <span>Budget spent: the gateway refuses this author from issue {i + 1}</span>
                </li>
              )}
              <li className={`wave-row wr-${waiting ? "waiting" : status}`}>
                <span className="wr-n">{String(i + 1).padStart(2, "0")}</span>
                <Link className="wr-title" href={`/console/runs/${id}`}>
                  {d?.run.title ?? DASH}
                </Link>
                <StatusBadge status={status} waiting={waiting} />
                <code className={`wr-model${isTierDown(models[i]) ? " is-tier" : ""}`} title={models[i] ?? undefined}>
                  {modelName(models[i]) ?? DASH}
                </code>
                <span className="wr-tail">
                  {status === "refused_budget" ? (
                    <span className="wr-reset">{t && author ? resetText(author.nextResetAt, t) : DASH}</span>
                  ) : (
                    <code>{d && status !== "running" ? usd(d.run.totalCostUsd) : DASH}</code>
                  )}
                </span>
              </li>
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}
