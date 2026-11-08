/**
 * Puts the General Sans webfonts in public/fonts/ before dev and build.
 *   pnpm fonts
 *
 * General Sans is licensed by the Indian Type Foundry under the Fontshare Free Font License, which allows
 * self-hosting for our own site but not redistributing the files, so they are fetched from Fontshare at
 * build time and never committed. Files already on disk are kept. This never fails the build: if Fontshare
 * cannot be reached, it warns and the site sets in its metric-matched fallback face.
 */
import { join } from "node:path";
import { ensureFonts } from "./fonts-core";

ensureFonts(join(process.cwd(), "public", "fonts"))
  .then((r) => {
    for (const f of r.fetched) console.log(`fonts: fetched ${f}`);
    for (const f of r.failed) console.warn(`fonts: could not fetch ${f.file} (${f.reason}); the fallback face will be used`);
  })
  .catch((e) => console.warn(`fonts: skipped (${e instanceof Error ? e.message : e}); the fallback face will be used`))
  .finally(() => {
    process.exitCode = 0;
  });
