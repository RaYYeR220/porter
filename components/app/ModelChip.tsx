import { DASH } from "./format";
import { isTierDown, TIER_DOWN_AT_PCT } from "./runs";

/** Routing policy (what Porter asked for) → model and provider (what Otari served). */
export function ModelChip({
  requested,
  served,
  provider,
  fallback = false,
  attempts = null,
  unserved = null,
}: {
  requested: string | null;
  served: string | null;
  provider?: string | null;
  fallback?: boolean;
  attempts?: number | null;
  /** Said in place of a model when the call never reached one. */
  unserved?: string | null;
}) {
  const tier = isTierDown(served);
  return (
    <span className="model">
      {requested && (
        <>
          <code className="m-req">{requested}</code>
          <span className="m-arrow" aria-hidden="true">
            →
          </span>
          <span className="sr-only">served as</span>
        </>
      )}
      {served || !unserved ? <code className="m-served">{served ?? DASH}</code> : <span className="m-none">{unserved}</span>}
      {provider && <span className="m-prov">{provider}</span>}
      {fallback && (
        <span className="tag tag-warn" title="The first provider failed and the routing policy handed the call to the next one">
          fallback{attempts ? ` · attempt ${attempts}` : ""}
        </span>
      )}
      {tier && (
        <span className="tag tag-hold" title={`The smaller model the routing policy serves once an author has used ${TIER_DOWN_AT_PCT}% of their budget`}>
          tier-down
        </span>
      )}
    </span>
  );
}
