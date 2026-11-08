import { GlyphField, SCHEDULE } from "./field";
import { FieldRenderer, readPalette } from "./render";
import type { Pointer } from "./render";
import type { HeroData } from "./data";

const FALLBACK_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const FONT_WAIT_MS = 1500;

/**
 * Runs the field on a canvas: sizes it to its parent, plays it while it is on screen and the tab is visible,
 * draws one still frame under reduced motion, and wires the lens and the click. Returns the teardown.
 *
 * canvas.dataset.motion reports the state: "live", "static" (reduced motion) or "off" (no 2D canvas).
 */
export function mountField(canvas: HTMLCanvasElement, data: HeroData): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx || !data.issues.length) {
    canvas.dataset.motion = "off";
    return () => {};
  }
  const band = canvas.parentElement ?? canvas;
  const root = document.documentElement;
  const mono = getComputedStyle(root).getPropertyValue("--mono").trim() || FALLBACK_MONO;
  const renderer = new FieldRenderer(canvas, ctx, readPalette(root), mono);
  const field = new GlyphField(data, renderer.measure);
  const ptr: Pointer = { on: false, x: 0, y: 0 };
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  let reduced = !!mq?.matches;
  let onScreen = true;
  let ready = false;
  let disposed = false;
  let raf = 0;
  let last = 0;
  let size = { w: 0, h: 0 };

  const running = () => ready && !reduced && onScreen && !document.hidden && !disposed;
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  };
  const frame = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    field.step(dt);
    renderer.draw(field, ptr);
    sync();
  };
  const sync = () => {
    if (running()) {
      if (!raf) raf = requestAnimationFrame(frame);
    } else stop();
  };

  const start = () => {
    if (disposed) return;
    stop();
    const r = band.getBoundingClientRect();
    size = { w: r.width, h: r.height };
    if (r.width < 1 || r.height < 1) return;
    renderer.resize(r.width, r.height, Math.min(2, window.devicePixelRatio || 1));
    field.layout(r.width, r.height);
    renderer.buildAtlas(field);
    field.reset();
    field.prewarm(SCHEDULE.prewarm);
    field.settleOpening();
    ready = true;
    if (reduced) {
      field.settleStatic();
      canvas.dataset.motion = "static";
    } else canvas.dataset.motion = "live";
    renderer.draw(field, ptr);
    sync();
  };

  const local = (e: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onMove = (e: PointerEvent) => {
    const p = local(e);
    ptr.x = p.x;
    ptr.y = p.y;
    ptr.on = ready && field.inField(p.y) && e.pointerType !== "touch";
    if (ready && !running()) renderer.draw(field, ptr);
  };
  const onLeave = () => {
    ptr.on = false;
    if (ready && !running()) renderer.draw(field, ptr);
  };
  const onClick = (e: MouseEvent) => {
    if (!ready || reduced) return;
    const p = local(e);
    if (field.click(p.x, p.y) && !running()) renderer.draw(field, ptr);
  };
  const onVisibility = () => sync();
  const onMotion = () => {
    reduced = !!mq?.matches;
    start();
  };

  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);
  document.addEventListener("visibilitychange", onVisibility);
  mq?.addEventListener?.("change", onMotion);

  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const e of entries) onScreen = e.isIntersecting;
          sync();
        })
      : null;
  io?.observe(canvas);

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const ro =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            const r = band.getBoundingClientRect();
            if (Math.abs(r.width - size.w) > 0.5 || Math.abs(r.height - size.h) > 0.5) start();
          }, 160);
        })
      : null;
  ro?.observe(band);

  // the glyph atlas needs the mono face; start once it is in, or after a short wait with the fallback
  const fonts = document.fonts;
  if (fonts?.load) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => (timer = setTimeout(resolve, FONT_WAIT_MS)));
    Promise.race([Promise.all([fonts.load(`500 13px ${mono}`), fonts.load(`400 10px ${mono}`)]).then(() => undefined), wait])
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        start();
        // a late font: redraw the same frame with it
        fonts.ready.then(() => {
          if (disposed || !ready) return;
          renderer.buildAtlas(field);
          renderer.draw(field, ptr);
        });
      });
  } else queueMicrotask(start);

  return () => {
    disposed = true;
    stop();
    clearTimeout(resizeTimer);
    io?.disconnect();
    ro?.disconnect();
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("click", onClick);
    document.removeEventListener("visibilitychange", onVisibility);
    mq?.removeEventListener?.("change", onMotion);
  };
}
