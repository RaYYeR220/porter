"use client";

import { useEffect, useRef } from "react";

/** Calls `fn` now and then every `ms` while the tab is visible. */
export function usePoll(fn: () => unknown, ms: number) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    let first = true;
    let t: ReturnType<typeof setTimeout>;
    const run = () => {
      if (first || document.visibilityState === "visible") void ref.current();
      first = false;
      t = setTimeout(run, ms);
    };
    t = setTimeout(run, 0);
    return () => clearTimeout(t);
  }, [ms]);
}
