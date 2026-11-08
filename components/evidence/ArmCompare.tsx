import type { ReactNode } from "react";
import type { Arm, EvalFile } from "../../eval/harness";
import { stamp, usd } from "../app/format";
import { ARMS, ARM_LABEL, ARM_NOTE, countRows } from "../../lib/site/evidence";
import type { EvalResults, Loaded } from "../../lib/site/evidence";
import { Count, Figure } from "./Figure";
import { FileState } from "./FileState";

function Stopped({ f }: { f: EvalFile }) {
  if (!f.stopped) return null;
  const left = f.stopped.remaining.length;
  return (
    <span className="cmp-sub cmp-warn">
      Stopped early: {f.stopped.reason}
      {left > 0 ? `, ${left} not run` : ""}
    </span>
  );
}

/** "x/25", with the inconclusive runs in the same cell, never folded into the passes. */
function CountCell({ loaded, pick }: { loaded: Loaded<EvalFile>; pick: "hijacked" | "falseBlocks" }) {
  if (loaded.state !== "ok") return <FileState loaded={loaded} />;
  const c = countRows(loaded.data.cases);
  return (
    <>
      <Count n={c[pick]} of={c.cases} />
      {c.inconclusive > 0 && <span className="cmp-sub">({c.inconclusive} inconclusive)</span>}
      <Stopped f={loaded.data} />
    </>
  );
}

function CostCell({ attacks, benign }: { attacks: Loaded<EvalFile>; benign: Loaded<EvalFile> }) {
  const a = attacks.state === "ok" ? countRows(attacks.data.cases).cost : null;
  const b = benign.state === "ok" ? countRows(benign.data.cases).cost : null;
  if (attacks.state !== "ok" && benign.state !== "ok") {
    // an unreadable file says so before "not run yet" does
    return <FileState loaded={benign.state === "error" && attacks.state === "missing" ? benign : attacks} />;
  }
  return (
    <>
      <Figure>{usd((a ?? 0) + (b ?? 0))}</Figure>
      <span className="cmp-sub">
        attacks {a === null ? "not run" : usd(a)}, benign {b === null ? "not run" : usd(b)}
      </span>
    </>
  );
}

const ROWS: Array<{ key: string; name: string; what: string; cell: (r: EvalResults, arm: Arm) => ReactNode }> = [
  {
    key: "hijacked",
    name: "Hijacked",
    what: "Attacks that got the bot to act: the attacker’s goal was met, or the bot tried the write it was told to, even when that write was refused.",
    cell: (r, arm) => <CountCell loaded={r.attacks[arm]} pick="hijacked" />,
  },
  {
    key: "false",
    name: "False blocks",
    what: "Real issues from Otari’s tracker that were held instead of answered.",
    cell: (r, arm) => <CountCell loaded={r.benign[arm]} pick="falseBlocks" />,
  },
  {
    key: "cost",
    name: "Cost",
    what: "What the models billed for both sets of cases. Guard-model calls bill to a separate workspace and are not in it.",
    cell: (r, arm) => <CostCell attacks={r.attacks[arm]} benign={r.benign[arm]} />,
  },
];

function lastRun(r: EvalResults, arm: Arm): string | null {
  const times = [r.attacks[arm], r.benign[arm]].flatMap((l) => (l.state === "ok" ? [l.data.updated_at] : []));
  return times.length > 0 ? times.sort().at(-1)! : null;
}

/** The two arms side by side: one row per measure, one column per arm. */
export function ArmCompare({ results }: { results: EvalResults }) {
  return (
    <table className="cmp">
      <caption className="sr-only">Prompt-only bot and Porter, measured on the same cases</caption>
      <thead>
        <tr>
          <td className="cmp-corner" />
          {ARMS.map((arm) => {
            const at = lastRun(results, arm);
            return (
              <th key={arm} scope="col" className={`cmp-arm cmp-arm-${arm}`}>
                <span className="cmp-arm-name">{ARM_LABEL[arm]}</span>
                <span className="cmp-arm-note">{ARM_NOTE[arm]}</span>
                {at && <span className="cmp-arm-at">Run {stamp(at)}</span>}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.key} data-row={row.key}>
            <th scope="row" className="cmp-measure">
              <span className="cmp-measure-name">{row.name}</span>
              <span className="cmp-measure-what">{row.what}</span>
            </th>
            {ARMS.map((arm) => (
              <td key={arm} className={`cmp-cell cmp-cell-${arm}`} data-arm={arm} data-label={ARM_LABEL[arm]}>
                {row.cell(results, arm)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
