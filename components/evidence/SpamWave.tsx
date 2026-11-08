import Link from "next/link";
import type { SpamResult } from "../../eval/spam-core";
import { usd } from "../app/format";
import { statusMeta } from "../app/runs";
import { ARMS, ARM_LABEL, SPAM_TONE_COPY, runHref, spamOnlyCost, spamTone } from "../../lib/site/evidence";
import type { PerArm, SpamTone } from "../../lib/site/evidence";
import { FileState } from "./FileState";

const LEGEND: SpamTone[] = ["served", "refused", "held", "failed"];

function Cell({ index, status, cost, cumulative, runId, first }: { index: number; status: string; cost: number; cumulative: number; runId: string; first: boolean }) {
  const tone = spamTone(status);
  const what = `Issue ${index}: ${statusMeta(status).label.toLowerCase()}, ${usd(cost)}, ${usd(cumulative)} so far`;
  const href = runHref(runId);
  const cls = `sw-c sw-${tone}${first ? " sw-first" : ""}`;
  return href ? (
    <Link className={cls} href={href} title={what} aria-label={`${what}. Open the run trace`} data-tone={tone}>
      {index}
    </Link>
  ) : (
    <span className={cls} title={what} aria-label={what} data-tone={tone} role="img">
      {index}
    </span>
  );
}

function Wave({ s }: { s: SpamResult }) {
  const answered = s.issues.filter((i) => i.status === "answered").length;
  const unfiled = Math.max(0, s.n - s.issues.length);
  const legitHref = runHref(s.legit?.run_id);
  return (
    <>
      <ol className="sw-cells" aria-label={`${s.issues.length} spam issues from one author, in the order filed`}>
        {s.issues.map((i) => (
          <li key={i.index}>
            <Cell index={i.index} status={i.status} cost={i.cost_usd} cumulative={i.cumulative_usd} runId={i.run_id} first={i.index === s.first_refusal_index} />
          </li>
        ))}
        {Array.from({ length: unfiled }, (_, k) => (
          <li key={`u${k}`}>
            <span className="sw-c sw-unfiled" title="Not filed" aria-label={`Issue ${s.issues.length + k + 1}: not filed`} role="img">
              {s.issues.length + k + 1}
            </span>
          </li>
        ))}
      </ol>

      <dl className="sw-facts">
        <div>
          <dt>Answered</dt>
          <dd>
            {answered} of {s.issues.length}
          </dd>
        </div>
        <div>
          <dt>First budget refusal</dt>
          <dd>{s.first_refusal_index === null ? "None" : `Issue ${s.first_refusal_index}`}</dd>
        </div>
        <div>
          <dt>Spam cost, cumulative</dt>
          <dd>
            <code>{usd(spamOnlyCost(s))}</code>
          </dd>
        </div>
        <div>
          <dt>Legit author after the wave</dt>
          <dd data-legit={s.legit ? (s.legit.served ? "served" : "not-served") : "none"}>
            {s.legit === null ? (
              "Not filed"
            ) : (
              <>
                {s.legit.served ? "Served" : `Not served: ${statusMeta(s.legit.status).label.toLowerCase()}`}
                {legitHref && (
                  <>
                    {" "}
                    <Link className="ev-link" href={legitHref}>
                      Trace
                    </Link>
                  </>
                )}
              </>
            )}
          </dd>
        </div>
      </dl>

      {s.stopped && <p className="sw-stopped">Stopped early: {s.stopped}</p>}

      {s.modeled && (
        <div className="sw-model" data-modeled>
          <p>
            <span className="tag tag-model">modeled</span> At {s.modeled.n} issues: <code>{usd(s.modeled.cost_usd)}</code>. Not a measurement.
          </p>
          <p className="sw-formula">{s.modeled.formula}</p>
        </div>
      )}
    </>
  );
}

export function SpamLegend() {
  return (
    <ul className="sw-legend" aria-label="What each cell means">
      {LEGEND.map((t) => (
        <li key={t}>
          <span className={`sw-c sw-${t} sw-key`} aria-hidden="true" />
          {SPAM_TONE_COPY[t]}
        </li>
      ))}
    </ul>
  );
}

/** Per arm: the wave as a row of cells, what it cost, and whether the real question after it got an answer. */
export function SpamWave({ spam }: { spam: PerArm<SpamResult> }) {
  return (
    <div className="sw-grid">
      {ARMS.map((arm) => {
        const l = spam[arm];
        return (
          <section key={arm} className={`sw sw-arm-${arm}`} aria-labelledby={`sw-${arm}`} data-arm={arm}>
            <h3 id={`sw-${arm}`} className="sw-title">
              {ARM_LABEL[arm]}
            </h3>
            {l.state === "ok" ? (
              <Wave s={l.data} />
            ) : (
              <p className="sw-empty">
                <FileState loaded={l} />
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
