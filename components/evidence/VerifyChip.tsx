import { CLAIM_COPY } from "../../lib/site/evidence";
import type { ClaimState } from "../../lib/site/evidence";

/** Whether a person has checked one of Porter's claims. Anything not checked says so. */
export function VerifyChip({ state }: { state: ClaimState }) {
  const c = CLAIM_COPY[state];
  return (
    <span className={`vchip vchip-${state}`} data-claim={state} title={c.spoken}>
      <span aria-hidden="true">{c.chip}</span>
      <span className="sr-only">{c.spoken}</span>
    </span>
  );
}
