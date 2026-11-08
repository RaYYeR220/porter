import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILES, ensureFonts } from "../../scripts/fonts-core";

const woff2 = () => {
  const b = new Uint8Array(4096);
  b.set([0x77, 0x4f, 0x46, 0x32]); // "wOF2"
  return b;
};
const CSS = Object.keys(FILES)
  .map((w) => `@font-face { src: url('//cdn.fontshare.com/wf/${w}.woff2') format('woff2'); font-weight: ${w}; }`)
  .join("\n");
const ok = (body: string | Uint8Array) => ({
  ok: true,
  status: 200,
  text: async () => String(body),
  arrayBuffer: async () => (body as Uint8Array).slice().buffer as ArrayBuffer,
});

describe("ensureFonts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "porter-fonts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("never throws when Fontshare cannot be reached, and reports every file", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.fontshare.com");
    });
    const r = await ensureFonts(dir, { fetch, tries: 1 });
    expect(r.fetched).toEqual([]);
    expect(r.failed.map((f) => f.file).sort()).toEqual(Object.values(FILES).sort());
  });

  it("keeps valid files on disk and fetches only what is missing", async () => {
    writeFileSync(join(dir, FILES["500"]), woff2());
    const fetch = vi.fn(async (url: string) => (url.includes("/css") ? ok(CSS) : ok(woff2())));
    const r = await ensureFonts(dir, { fetch });
    expect(r.kept).toEqual([FILES["500"]]);
    expect(r.fetched.sort()).toEqual([FILES["400"], FILES["600"]].sort());
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/500.woff2"), expect.anything());
  });

  it("does not write a download that is not a woff2 file", async () => {
    const fetch = vi.fn(async (url: string) => (url.includes("/css") ? ok(CSS) : ok(new Uint8Array(4096))));
    const r = await ensureFonts(dir, { fetch, tries: 1 });
    expect(r.failed).toHaveLength(3);
    for (const f of Object.values(FILES)) expect(existsSync(join(dir, f))).toBe(false);
  });

  it("makes no request when every file is already there", async () => {
    for (const f of Object.values(FILES)) writeFileSync(join(dir, f), woff2());
    const fetch = vi.fn();
    await ensureFonts(dir, { fetch });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("type faces", () => {
  const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf8");
  const layout = readFileSync(join(__dirname, "../../app/layout.tsx"), "utf8");

  it("declares General Sans from public/fonts with swap, over a metric-matched fallback", () => {
    for (const f of Object.values(FILES)) expect(css).toContain(`url("/fonts/${f}")`);
    expect(css.match(/font-display: swap/g)?.length).toBe(3);
    const fallback = /@font-face \{\s*font-family: "General Sans Fallback";([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(fallback).toMatch(/local\("Arial"\)/);
    expect(fallback).toMatch(/size-adjust: [\d.]+%/);
    expect(fallback).toMatch(/ascent-override: [\d.]+%/);
    expect(css).toMatch(/--sans: "General Sans", "General Sans Fallback"/);
  });

  it("does not make the build depend on a font download", () => {
    expect(layout).not.toMatch(/next\/font\/(local|google)/);
    expect(layout).toMatch(/from "geist\/font\/mono"/);
  });
});
