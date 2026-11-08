"use client";

import { useEffect, useRef } from "react";

/** Calls `fn` now, every `ms` while the tab is visible, and at once when the tab comes back into view. */
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
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(t);
      run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms]);
}
