import { statusMeta } from "./runs";

/** A run status as a small labelled mark. Held and refused share the gateway's colour: that is enforcement working. */
export function StatusBadge({ status, waiting = false }: { status: string; waiting?: boolean }) {
  const meta = waiting ? { label: "Waiting", tone: "muted" as const } : statusMeta(status);
  return (
    <span className={`st st-${meta.tone}`} data-status={status}>
      <i aria-hidden="true" />
      {meta.label}
    </span>
  );
}
