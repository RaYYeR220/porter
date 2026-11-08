"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRun } from "./api";
import type { RunDetail, RunRow } from "./types";

const PARALLEL = 4;

/**
 * Details for the given list rows, read from GET /api/runs/:id a few at a time. A final run is read
 * once; a row whose status changed since its last read is read again.
 */
export function useRunDetails(rows: ReadonlyArray<Pick<RunRow, "id" | "status">>) {
  const [details, setDetails] = useState<Record<string, RunDetail>>({});
  const cache = useRef(new Map<string, RunDetail>());
  const inFlight = useRef(new Set<string>());
  const [nonce, setNonce] = useState(0);
  const wanted = rows.map((r) => `${r.id}:${r.status}`).join(",");

  useEffect(() => {
    let alive = true;
    const queue = wanted
      .split(",")
      .filter(Boolean)
      .map((pair) => {
        const [id, status] = pair.split(":");
        return { id, status };
      })
      .filter(({ id, status }) => {
        const have = cache.current.get(id);
        return !inFlight.current.has(id) && (!have || have.run.status !== status);
      });

    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next || !alive) return;
        inFlight.current.add(next.id);
        const r = await fetchRun(next.id);
        inFlight.current.delete(next.id);
        if (r.ok && r.data?.run) {
          cache.current.set(next.id, r.data);
          // Published even after a re-run of this effect: the next run skips ids that were in flight.
          setDetails(Object.fromEntries(cache.current));
        }
      }
    };
    for (let i = 0; i < Math.min(PARALLEL, queue.length); i++) void worker();
    return () => {
      alive = false;
    };
  }, [wanted, nonce]);

  /** Forget a run so it is read again (after an approve, say). */
  const invalidate = useCallback((id: string) => {
    cache.current.delete(id);
    setNonce((n) => n + 1);
  }, []);

  return { details, invalidate };
}
