// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../../components/app/api";
import type { RunDetail } from "../../../components/app/types";
import { POLL_MS, useRunPolling } from "../../../components/app/useRunPolling";
import { detail, RUN_ID, triageOk } from "./fixtures";

let visibility: DocumentVisibilityState = "visible";

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

const ok = (d: RunDetail): ApiResult<RunDetail> => ({ ok: true, status: 200, data: d });

/** Answers each read with the next status in `script`, repeating the last one. */
function scripted(script: string[]) {
  let i = 0;
  return vi.fn(async (id: string) => {
    const status = script[Math.min(i++, script.length - 1)];
    return ok({ ...detail(status, [triageOk()]), run: { ...detail(status).run, id } });
  });
}

const tick = async (ms = POLL_MS) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("useRunPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls every 1.5 s and stops once the run is final", async () => {
    const fetcher = scripted(["running", "running", "answered"]);
    const { result } = renderHook(() => useRunPolling([RUN_ID], { fetcher }));
    await tick(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.runs[RUN_ID]?.run.status).toBe("running");
    expect(result.current.done).toBe(false);

    await tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.runs[RUN_ID]?.run.status).toBe("answered");
    expect(result.current.done).toBe(true);

    await tick(POLL_MS * 10);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops while the tab is hidden and resumes when it is shown", async () => {
    const fetcher = scripted(["running"]);
    const { result } = renderHook(() => useRunPolling([RUN_ID], { fetcher }));
    await tick(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    await tick();
    expect(result.current.paused).toBe(true);
    const calls = fetcher.mock.calls.length;
    await tick(POLL_MS * 20);
    expect(fetcher).toHaveBeenCalledTimes(calls);

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(calls + 1);
    expect(result.current.paused).toBe(false);
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(calls + 2);
  });

  it("gives up on a run that does not exist", async () => {
    const fetcher = vi.fn(async (): Promise<ApiResult<RunDetail>> => ({ ok: false, status: 404, error: "not_found", reason: null }));
    const { result } = renderHook(() => useRunPolling([RUN_ID], { fetcher }));
    await tick(0);
    expect(result.current.errors[RUN_ID]?.status).toBe(404);
    expect(result.current.done).toBe(true);
    await tick(POLL_MS * 5);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads a batch head first, a few runs per tick, until every run is final", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `${RUN_ID.slice(0, -2)}${String(i).padStart(2, "0")}`);
    const fetcher = vi.fn(async (id: string) => ok({ ...detail("answered"), run: { ...detail("answered").run, id } }));
    const { result } = renderHook(() => useRunPolling(ids, { fetcher, perTick: 3 }));
    await tick(0);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(ids.slice(0, 3));
    for (let i = 0; i < 3; i++) await tick();
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(result.current.done).toBe(true);
    await tick(POLL_MS * 4);
    expect(fetcher).toHaveBeenCalledTimes(12);
  });
});
