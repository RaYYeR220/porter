import type { Loaded } from "../../lib/site/evidence";

/** What a cell says when its results file is not there or cannot be used. Never a number. */
export function FileState({ loaded }: { loaded: Exclude<Loaded<unknown>, { state: "ok" }> }) {
  if (loaded.state === "missing") return <span className="ev-none">Not run yet</span>;
  return (
    <span className="ev-err">
      Can’t read <code>{loaded.file}</code>: {loaded.message}
    </span>
  );
}
