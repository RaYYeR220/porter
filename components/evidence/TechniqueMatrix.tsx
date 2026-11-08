import Link from "next/link";
import type { EvalFile, EvalRow } from "../../eval/harness";
import { ARMS, ARM_LABEL, TONE_COPY, caseTone, runHref, shortCase } from "../../lib/site/evidence";
import type { CaseTone, PerArm } from "../../lib/site/evidence";
import type { CorpusSummary } from "../../lib/site/results";
import { FileState } from "./FileState";

export const TECHNIQUE_LABEL: Record<string, string> = {
  direct: "Direct instruction",
  hidden_comment: "Hidden HTML comment",
  fake_system: "Fake system message",
  unicode: "Unicode tricks",
  encoded: "Encoded payload",
  exfil_image: "Image link exfiltration",
  social_engineering: "Social engineering",
  tool_bait: "Tool bait",
  indirect_link: "Instructions on a linked page",
};

const LEGEND: CaseTone[] = ["stopped", "declined", "steered", "through", "open"];

function CaseMark({ id, row }: { id: string; row: EvalRow | undefined }) {
  const tone = caseTone(row);
  const href = runHref(row?.run_id);
  const what = `${id}: ${TONE_COPY[tone].toLowerCase()}${row?.reason ? `. ${row.reason}` : ""}`;
  const body = (
    <>
      <i aria-hidden="true" />
      {shortCase(id)}
    </>
  );
  return href ? (
    <Link className={`cm cm-${tone}`} href={href} title={what} aria-label={`${what}. Open the run trace`} data-tone={tone}>
      {body}
    </Link>
  ) : (
    <span className={`cm cm-${tone}`} title={what} aria-label={what} data-tone={tone} role="img">
      {body}
    </span>
  );
}

export function CaseLegend() {
  return (
    <ul className="cm-legend" aria-label="What each mark means">
      {LEGEND.map((t) => (
        <li key={t}>
          <span className={`cm cm-${t} cm-key`} aria-hidden="true">
            <i />
          </span>
          {TONE_COPY[t]}
        </li>
      ))}
    </ul>
  );
}

/** Nine techniques by two arms; each case links to the run it produced. */
export function TechniqueMatrix({ attacks, corpus }: { attacks: PerArm<EvalFile>; corpus: CorpusSummary }) {
  const byId = Object.fromEntries(
    ARMS.map((a) => {
      const l = attacks[a];
      return [a, l.state === "ok" ? new Map(l.data.cases.map((c) => [c.id, c])) : null];
    }),
  );
  return (
    <table className="tbl mx">
      <caption className="sr-only">Each attack case by technique, and how it ended in each arm</caption>
      <thead>
        <tr>
          <th scope="col">Technique</th>
          <th scope="col">Cases</th>
          {ARMS.map((arm) => {
            const l = attacks[arm];
            return (
              <th key={arm} scope="col">
                {ARM_LABEL[arm]}
                {l.state !== "ok" && (
                  <span className="lay-state">
                    <FileState loaded={l} />
                  </span>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {corpus.techniques.map(({ technique, ids }) => (
          <tr key={technique} data-technique={technique}>
            <th scope="row" data-label="Technique">
              {TECHNIQUE_LABEL[technique] ?? technique}
            </th>
            <td data-label="Cases" className="mx-n">
              {ids.length}
            </td>
            {ARMS.map((arm) => {
              const rows = byId[arm];
              return (
                <td key={arm} data-arm={arm} data-label={ARM_LABEL[arm]}>
                  {rows ? (
                    <ul className="cm-row">
                      {ids.map((id) => (
                        <li key={id}>
                          <CaseMark id={id} row={rows.get(id)} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="ev-none">—</span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
