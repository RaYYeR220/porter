"use client";

import { useEffect, useRef, useState } from "react";
import { fetchRun, type ApiFail, type ApiResult } from "./api";
import { isTerminal } from "./runs";
import type { RunDetail } from "./types";

export const POLL_MS = 1500;
/** A run whose reads keep failing stops being polled after this many tries in a row. */
export const MAX_FAILURES = 5;

export type Polled = {
  runs: Record<string, RunDetail | undefined>;
  errors: Record<string, ApiFail | undefined>;
  /** Every run is final, or was given up on. */
  done: boolean;
  /** Polling is waiting for the tab to be visible again. */
  paused: boolean;
};

type Opts = {
  intervalMs?: number;
  /** Runs read per tick, in order. Batches run one at a time, so the head of the list is what moves. */
  perTick?: number;
  fetcher?: (id: string) => Promise<ApiResult<RunDetail>>;
};

/**
 * Polls GET /api/runs/:id every 1.5 s until each run reaches a final status. Stops while the tab
 * is hidden and picks up again when it is shown.
 */
export function useRunPolling(ids: readonly string[], opts: Opts = {}): Polled {
  const { intervalMs = POLL_MS, perTick = 3, fetcher = fetchRun } = opts;
  const key = ids.join(",");
  const [state, setState] = useState<Polled & { key: string }>({ key, runs: {}, errors: {}, done: ids.length === 0, paused: false });
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    const list = key ? key.split(",") : [];
    const runs: Record<string, RunDetail | undefined> = {};
    const errors: Record<string, ApiFail | undefined> = {};
    const failures = new Map<string, number>();
    const finished = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let stopped = false;

    const publish = (paused: boolean) =>
      setState({ key, runs: { ...runs }, errors: { ...errors }, done: finished.size === list.length, paused });

    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    const schedule = (delay: number) => {
      if (stopped || finished.size === list.length) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, delay);
    };

    async function tick() {
      timer = null;
      if (stopped || inFlight) return;
      if (hidden()) {
        publish(true);
        return; // visibilitychange restarts it
      }
      const pending = list.filter((id) => !finished.has(id)).slice(0, perTick);
      if (pending.length === 0) return;
      inFlight = true;
      const results = await Promise.all(pending.map((id) => fetcherRef.current(id).then((r) => [id, r] as const)));
      inFlight = false;
      if (stopped) return;
      for (const [id, r] of results) {
        if (r.ok) {
          runs[id] = r.data;
          errors[id] = undefined;
          failures.delete(id);
          if (isTerminal(r.data?.run?.status)) finished.add(id);
        } else {
          errors[id] = r;
          const n = (failures.get(id) ?? 0) + 1;
          failures.set(id, n);
          if (r.status === 404 || r.status === 400 || n >= MAX_FAILURES) finished.add(id);
        }
      }
      publish(false);
      schedule(intervalMs);
    }

    const onVisibility = () => {
      if (!hidden() && !timer && !inFlight) schedule(0);
    };

    if (list.length > 0) {
      document.addEventListener("visibilitychange", onVisibility);
      schedule(0);
    }
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key, intervalMs, perTick]);

  // A new set of ids starts from nothing; the effect above fills it in.
  if (state.key !== key) return { runs: {}, errors: {}, done: ids.length === 0, paused: false };
  const { runs, errors, done, paused } = state;
  return { runs, errors, done, paused };
}
