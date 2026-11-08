import { vi } from "vitest";

/** A 2D context that draws nothing and remembers the text it was asked to write. */
export function stubCanvas() {
  const texts: string[] = [];
  const images = { count: 0 };
  const gradient = { addColorStop() {} };
  const make = (canvas: HTMLCanvasElement) => {
    const target: Record<string | symbol, unknown> = {
      canvas,
      fillText: (t: string) => texts.push(t),
      drawImage: () => images.count++,
      measureText: (t: string) => ({ width: [...t].length * 6.6 }),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
    };
    return new Proxy(target, {
      get: (o, k) => (k in o ? o[k] : () => undefined),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      return make(this) as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement["getContext"]);
  return { texts, images, restore: () => spy.mockRestore() };
}

export function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })),
  );
}
