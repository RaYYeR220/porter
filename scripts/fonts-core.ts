import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CSS_URL = "https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap";
export const FILES: Record<string, string> = {
  "400": "GeneralSans-Regular.woff2",
  "500": "GeneralSans-Medium.woff2",
  "600": "GeneralSans-Semibold.woff2",
};

export const isWoff2 = (buf: Uint8Array) => buf.length > 1024 && Buffer.from(buf.subarray(0, 4)).toString("latin1") === "wOF2";

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Pick<Response, "ok" | "status" | "text" | "arrayBuffer">>;

async function get(fetchImpl: Fetch, url: string, tries: number, timeoutMs: number) {
  let last: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
      last = new Error(`${url} answered ${res.status}`);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export type FontsResult = { kept: string[]; fetched: string[]; failed: Array<{ file: string; reason: string }> };

/**
 * Makes sure the General Sans woff2 files are in `dir`. Valid files already there are kept. Never throws: whatever
 * cannot be fetched is reported in `failed`, and the site then sets in its metric-matched fallback.
 */
export async function ensureFonts(
  dir: string,
  opts: { fetch?: Fetch; tries?: number; timeoutMs?: number } = {},
): Promise<FontsResult> {
  const fetchImpl = opts.fetch ?? (fetch as unknown as Fetch);
  const tries = opts.tries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const result: FontsResult = { kept: [], fetched: [], failed: [] };
  const valid = (name: string) => {
    try {
      return existsSync(join(dir, name)) && isWoff2(readFileSync(join(dir, name)));
    } catch {
      return false;
    }
  };
  const missing = Object.entries(FILES).filter(([, name]) => {
    if (!valid(name)) return true;
    result.kept.push(name);
    return false;
  });
  if (!missing.length) return result;

  let css: string;
  try {
    mkdirSync(dir, { recursive: true });
    css = await (await get(fetchImpl, CSS_URL, tries, timeoutMs)).text();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    for (const [, file] of missing) result.failed.push({ file, reason });
    return result;
  }
  for (const [weight, file] of missing) {
    try {
      const block = css.split("@font-face").find((b) => new RegExp(`font-weight:\\s*${weight}\\b`).test(b));
      const src = block && /url\('([^']+\.woff2)'\)/.exec(block)?.[1];
      if (!src) throw new Error(`no woff2 for weight ${weight} in the Fontshare stylesheet`);
      const res = await get(fetchImpl, src.startsWith("//") ? `https:${src}` : src, tries, timeoutMs);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!isWoff2(buf)) throw new Error("the download is not a woff2 file");
      writeFileSync(join(dir, file), buf);
      result.fetched.push(file);
    } catch (e) {
      result.failed.push({ file, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
