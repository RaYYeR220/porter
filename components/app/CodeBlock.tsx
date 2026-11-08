/** A labelled, scrollable block of real output. Long text is cut with a visible note, never silently. */
export function CodeBlock({ label, code, max = 4000, tone }: { label: string; code: string; max?: number; tone?: "err" }) {
  const cut = code.length > max;
  const shown = cut ? code.slice(0, max) : code;
  return (
    <figure className={`code${tone === "err" ? " code-err" : ""}`}>
      <figcaption>{label}</figcaption>
      {/* Scrollable regions must be reachable from the keyboard. */}
      <pre tabIndex={0} aria-label={label}>
        <code>{shown === "" ? "(empty)" : shown}</code>
      </pre>
      {cut && <p className="code-cut">Showing the first {max.toLocaleString("en-US")} of {code.length.toLocaleString("en-US")} characters.</p>}
    </figure>
  );
}
