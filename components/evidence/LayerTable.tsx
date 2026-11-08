import type { EvalFile } from "../../eval/harness";
import { ARMS, ARM_LABEL, LAYERS, LAYER_COPY, layerCounts } from "../../lib/site/evidence";
import type { Layer, Loaded, PerArm } from "../../lib/site/evidence";
import { FileState } from "./FileState";

const TONE: Record<Layer, string> = {
  gateway_guardrail: "stop",
  output_check: "stop",
  acl: "stop",
  server_refused: "stop",
  model_refused: "model",
  not_stopped: "through",
  no_verdict: "open",
};

/** One small square per case: the count, drawn. */
function Units({ n, layer }: { n: number; layer: Layer }) {
  if (n === 0) return null;
  return (
    <span className={`units units-${TONE[layer]}`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

function ArmHead({ loaded, arm }: { loaded: Loaded<EvalFile>; arm: (typeof ARMS)[number] }) {
  return (
    <th scope="col">
      {ARM_LABEL[arm]}
      {loaded.state !== "ok" && (
        <span className="lay-state">
          <FileState loaded={loaded} />
        </span>
      )}
    </th>
  );
}

/** Where each attack stopped, per arm, in the order the layers are listed in the pre-registration. */
export function LayerTable({ attacks }: { attacks: PerArm<EvalFile> }) {
  const counts = Object.fromEntries(ARMS.map((a) => [a, attacks[a].state === "ok" ? layerCounts(attacks[a].data.cases) : null]));
  return (
    <table className="tbl lay">
      <caption className="sr-only">Attack cases per layer that stopped them, for each arm</caption>
      <thead>
        <tr>
          <th scope="col">Stopped at</th>
          {ARMS.map((arm) => (
            <ArmHead key={arm} arm={arm} loaded={attacks[arm]} />
          ))}
        </tr>
      </thead>
      <tbody>
        {LAYERS.map((layer) => (
          <tr key={layer} data-layer={layer}>
            <th scope="row" data-label="Stopped at">
              <span className="lay-name">{LAYER_COPY[layer].name}</span>
              <span className="lay-what">{LAYER_COPY[layer].what}</span>
            </th>
            {ARMS.map((arm) => {
              const cell = counts[arm]?.[layer];
              return (
                <td key={arm} data-arm={arm} data-label={ARM_LABEL[arm]}>
                  {cell ? (
                    <span className="lay-cell">
                      <span className="lay-n">{cell.count}</span>
                      <Units n={cell.count} layer={layer} />
                      {(layer === "acl" || layer === "server_refused") && cell.hijacked > 0 && (
                        <span className="lay-note">{cell.hijacked} counted as hijacked: the model tried the write</span>
                      )}
                    </span>
                  ) : (
                    <span className="ev-none">—</span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" data-label="Stopped at">
            Cases scored
          </th>
          {ARMS.map((arm) => {
            const a = attacks[arm];
            return (
              <td key={arm} data-arm={arm} data-label={ARM_LABEL[arm]}>
                {a.state === "ok" ? a.data.cases.length : "—"}
              </td>
            );
          })}
        </tr>
      </tfoot>
    </table>
  );
}
