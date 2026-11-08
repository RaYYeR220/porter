/**
 * Puts the General Sans webfonts in public/fonts/ before dev and build.
 *   pnpm fonts
 *
 * General Sans is licensed by the Indian Type Foundry under the Fontshare Free Font License, which allows
 * self-hosting for our own site but not redistributing the files, so they are fetched from Fontshare at
 * build time and never committed. Files already on disk are kept.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CSS_URL = "https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap";
const OUT = join(process.cwd(), "public", "fonts");
const FILES: Record<string, string> = {
  "400": "GeneralSans-Regular.woff2",
  "500": "GeneralSans-Medium.woff2",
  "600": "GeneralSans-Semibold.woff2",
};

const isWoff2 = (buf: Uint8Array) => buf.length > 1024 && Buffer.from(buf.subarray(0, 4)).toString("latin1") === "wOF2";

async function get(url: string, tries = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return res;
      if (i >= tries) throw new Error(`${url} answered ${res.status}`);
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise((r) => setTimeout(r, 500 * i));
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const missing = Object.entries(FILES).filter(([, name]) => {
    const path = join(OUT, name);
    return !existsSync(path) || !isWoff2(readFileSync(path));
  });
  if (!missing.length) return;

  const css = await (await get(CSS_URL)).text();
  for (const [weight, name] of missing) {
    const block = css.split("@font-face").find((b) => new RegExp(`font-weight:\\s*${weight}\\b`).test(b));
    const src = block && /url\('([^']+\.woff2)'\)/.exec(block)?.[1];
    if (!src) throw new Error(`no woff2 for General Sans ${weight} in the Fontshare stylesheet`);
    const buf = new Uint8Array(await (await get(src.startsWith("//") ? `https:${src}` : src)).arrayBuffer());
    if (!isWoff2(buf)) throw new Error(`General Sans ${weight}: the download is not a woff2 file`);
    writeFileSync(join(OUT, name), buf);
    console.log(`fonts: ${name} (${buf.length} bytes)`);
  }
}

main().catch((e) => {
  console.error(`fonts: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
