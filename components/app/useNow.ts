"use client";

import { useSyncExternalStore } from "react";

/** One shared clock for relative times ("4 min ago", "resets in 3 h"), ticking every 15 s. */
const TICK_MS = 15_000;
let current = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => (current === 0 ? (current = Date.now()) : current);

export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 0);
}
