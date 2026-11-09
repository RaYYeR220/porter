// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIELD_LABEL, GlyphGate } from "../../components/hero/GlyphGate";
import { stubCanvas, stubReducedMotion } from "./canvas-stub";

let observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];

function mountBand() {
  const utils = render(
    <div className="band">
      <GlyphGate />
    </div>,
  );
  const band = utils.container.querySelector(".band") as HTMLElement;
  band.getBoundingClientRect = () => ({ width: 1440, height: 306, top: 0, left: 0, right: 1440, bottom: 306, x: 0, y: 0, toJSON() {} });
  return { ...utils, canvas: utils.container.querySelector("canvas") as HTMLCanvasElement };
}

describe("GlyphGate", () => {
  let canvas: ReturnType<typeof stubCanvas>;
  const raf = vi.fn(() => 7);
  const caf = vi.fn();

  beforeEach(() => {
    canvas = stubCanvas();
    observers = [];
    raf.mockClear();
    caf.mockClear();
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", caf);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          observers.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    canvas.restore();
    vi.unstubAllGlobals();
  });

  it("is an image with a text alternative", () => {
    stubReducedMotion(false);
    const { canvas: el } = mountBand();
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe(FIELD_LABEL);
  });

  it("draws one still frame under reduced motion: a held column and an answered issue, no animation loop", async () => {
    stubReducedMotion(true);
    const { canvas: el } = mountBand();
    await waitFor(() => expect(el.dataset.motion).toBe("static"));
    expect(raf).not.toHaveBeenCalled();
    expect(canvas.images.count).toBeGreaterThan(0);
    // single characters are the glyph atlas; longer strings are label text
    const drawn = canvas.texts.filter((t) => [...t].length > 1).join("\n");
    expect(drawn).toContain("gateway");
    expect(drawn).toMatch(/^held$/m);
    expect(drawn).toMatch(/ · [a-z_]+ · 0 answer tokens/);
    expect(drawn).toContain(" · answered · deepseek-v4.1-flash");
    expect(drawn).not.toContain("$");
  });

  it("runs the loop when motion is allowed, and stops it off screen and in a hidden tab", async () => {
    stubReducedMotion(false);
    const { canvas: el } = mountBand();
    await waitFor(() => expect(el.dataset.motion).toBe("live"));
    expect(raf).toHaveBeenCalledTimes(1);

    observers.forEach((cb) => cb([{ isIntersecting: false }]));
    expect(caf).toHaveBeenCalled();
    raf.mockClear();
    observers.forEach((cb) => cb([{ isIntersecting: true }]));
    expect(raf).toHaveBeenCalledTimes(1);

    caf.mockClear();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(caf).toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("stops everything on unmount", async () => {
    stubReducedMotion(false);
    const { canvas: el, unmount } = mountBand();
    await waitFor(() => expect(el.dataset.motion).toBe("live"));
    caf.mockClear();
    unmount();
    expect(caf).toHaveBeenCalled();
  });

  it("stays out of the way without a 2D canvas", async () => {
    canvas.restore();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    stubReducedMotion(false);
    const { canvas: el } = mountBand();
    expect(el.dataset.motion).toBe("off");
    expect(raf).not.toHaveBeenCalled();
  });
});
