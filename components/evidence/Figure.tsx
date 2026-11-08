import type { ReactNode } from "react";

/** A headline count, "7/25": the numeral large, the denominator quiet. Read aloud as "7 of 25". */
export function Count({ n, of }: { n: number; of: number }) {
  return (
    <span className="fig">
      <span className="fig-n" aria-hidden="true">
        {n}
      </span>
      <span className="fig-of" aria-hidden="true">
        /{of}
      </span>
      <span className="sr-only">
        {n} of {of}
      </span>
    </span>
  );
}

/** A headline amount or any other figure set at the same size. */
export function Figure({ children }: { children: ReactNode }) {
  return (
    <span className="fig">
      <span className="fig-n">{children}</span>
    </span>
  );
}
