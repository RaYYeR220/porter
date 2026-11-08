"use client";

import { DASH, resetText, usd } from "./format";
import { TIER_DOWN_AT_PCT, TIER_DOWN_MODEL } from "./runs";
import { useNow } from "./useNow";

export type BudgetState = "ok" | "tier" | "capped" | "unknown";

/** Spend against the end user's cap. No cap known → no percentage, never a guess. */
export function budgetMath(spendUsd: number, limitUsd: number | null): { pct: number | null; fill: number; state: BudgetState } {
  if (limitUsd === null || !Number.isFinite(limitUsd) || limitUsd <= 0 || !Number.isFinite(spendUsd)) {
    return { pct: null, fill: 0, state: "unknown" };
  }
  const pct = (Math.max(0, spendUsd) / limitUsd) * 100;
  const state: BudgetState = pct >= 100 ? "capped" : pct >= TIER_DOWN_AT_PCT ? "tier" : "ok";
  return { pct, fill: Math.min(100, pct), state };
}

const STATE_TEXT: Record<BudgetState, string> = {
  ok: "Under the tier-down line",
  tier: `Past ${TIER_DOWN_AT_PCT}%: triage moves to ${TIER_DOWN_MODEL}`,
  capped: "At the cap: the gateway refuses until the reset",
  unknown: "No cap reported for this budget",
};

export function BudgetMeter({
  spendUsd,
  limitUsd,
  nextResetAt,
  now,
  compact = false,
  label,
}: {
  spendUsd: number;
  limitUsd: number | null;
  nextResetAt: string | null;
  now?: number;
  compact?: boolean;
  label?: string;
}) {
  const clock = useNow();
  const t = now ?? clock;
  const m = budgetMath(spendUsd, limitUsd);
  const pctText = m.pct === null ? DASH : `${m.pct < 10 && m.pct > 0 ? m.pct.toFixed(1) : Math.round(m.pct)}%`;
  const reset = t ? resetText(nextResetAt, t) : DASH;
  const valueText =
    m.pct === null ? `${usd(spendUsd)} spent, no cap reported` : `${usd(spendUsd)} of ${usd(limitUsd)} spent, ${pctText}, ${reset}`;

  return (
    <div className={`meter meter-${m.state}${compact ? " meter-compact" : ""}`}>
      <div className="meter-row">
        <span className="meter-fig">
          <code>{usd(spendUsd)}</code>
          <span className="meter-of"> of </span>
          <code>{usd(limitUsd)}</code>
        </span>
        <code className="meter-pct">{pctText}</code>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label ?? "Budget used"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={m.pct === null ? undefined : Math.round(Math.min(m.pct, 100))}
        aria-valuetext={valueText}
      >
        <span className="meter-fill" style={{ width: `${m.fill}%` }} />
        <span className="meter-tick" style={{ left: `${TIER_DOWN_AT_PCT}%` }} aria-hidden="true" />
      </div>
      <div className="meter-row meter-foot">
        {!compact && <span className="meter-state">{STATE_TEXT[m.state]}</span>}
        <span className="meter-reset">{reset}</span>
      </div>
    </div>
  );
}
