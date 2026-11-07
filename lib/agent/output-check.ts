import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { compile, parse, postprocess, preprocess } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { detectInjectionSignals, detectSecrets } from "porter-guard";

/**
 * Output check on the final reply, in-process and model-free (Otari enforces input guardrails only).
 * Uses porter-guard's deterministic detectors, a run-marker canary and a link allowlist. Links are
 * found two ways and both must pass: a regex scan over the raw and the normalised text (entities
 * decoded, backslash escapes removed), and the hrefs/srcs of the reply rendered as GitHub Markdown.
 * Two things are held outright because renderers disagree on them: raw HTML and invisible characters.
 */

/**
 * Longer replies are held unchecked. A GitHub comment via post_comment is at most 6,000 chars and the
 * pipeline caps replies near 5,100; the cap also bounds micromark's superlinear cases ("*a" or "~a"
 * repeated: 6-7 s for 20,000 chars). Worst case measured at 6,000 chars: about 0.2-0.3 s here, about
 * 1 s on the reviewer's machine.
 */
export const MAX_CHECKED_CHARS = 6_000;

/** tool_bait targets text addressed to agents; in a reply to a human ("please run this command") it is noise. */
const IGNORED_SIGNALS = new Set(["tool_bait"]);

const BASE_LINK_HOSTS = ["pypi.org", "npmjs.com", "www.npmjs.com", "docs.python.org"];

export function allowedLinkHosts(docsHosts: string[] = []): string[] {
  return [...new Set([...BASE_LINK_HOSTS, ...docsHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)])];
}

export type OutputCheck = { valid: boolean; reasons: string[] };

function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\uFFFD";
}

function decodeOnce(s: string): string {
  return s
    .replace(/&#[xX]0*([0-9a-fA-F]{1,6});?/g, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#0*([0-9]{1,7});?/g, (_, d: string) => codePoint(parseInt(d, 10)))
    .replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (m, name: string) => {
      const v = decodeNamedCharacterReference(name);
      return v === false ? m : v;
    });
}

/** HTML numeric (any number of leading zeros) and named references, decoded twice so "&amp;#58;" cannot hide a colon. */
export function decodeEntities(s: string): string {
  return decodeOnce(decodeOnce(s));
}

/** Text as a Markdown renderer or a browser would read it: references decoded, backslash escapes removed. */
export function normaliseForScan(s: string): string {
  return decodeEntities(s).replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/**
 * Invisible or ignorable characters: U+00AD, U+034F, U+061C, U+115F, U+1160, U+17B4, U+17B5,
 * U+180B–U+180F, U+200B–U+200F, U+202A–U+202E, U+2060–U+206F, U+3164, U+FE00–U+FE0F, U+FEFF,
 * U+FFA0, U+E0000–U+E007F, and the rest of Unicode's Default_Ignorable_Code_Point set. GitHub's
 * autolinker runs straight through them while JS and micromark may stop, and URL parsers drop
 * several of them from hosts ("pypi.org\uFEFF.evil.example" renders as host pypi.org.evil.example).
 */
const INVISIBLE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\p{Default_Ignorable_Code_Point}]/u;

/**
 * Joiners that real text needs: ZWNJ/ZWJ inside Persian, Arabic-script and Indic words, ZWJ and
 * VS16 inside emoji. They pass only between non-ASCII, visible characters (at most two in a row,
 * VS16 may end a sequence). A joiner next to ASCII, which is what a link splice needs, is held.
 * Splices between non-ASCII characters cannot reach an allowlisted host (all of them are ASCII), and
 * the link scans read through these characters anyway. Empty this set to hold every invisible character.
 */
export const IN_SCRIPT_JOINERS: ReadonlySet<number> = new Set([0x200c, 0x200d, 0xfe0f]);

function isScriptChar(cp: number | undefined): boolean {
  if (cp === undefined || cp <= 0x7f) return false;
  const ch = String.fromCodePoint(cp);
  return !/\s/u.test(ch) && !INVISIBLE.test(ch);
}

export function hasInvisibleChars(text: string): boolean {
  if (!INVISIBLE.test(text)) return false;
  const cps = Array.from(text, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < cps.length; i++) {
    if (!INVISIBLE.test(String.fromCodePoint(cps[i]))) continue;
    if (!IN_SCRIPT_JOINERS.has(cps[i])) return true;
    let j = i;
    while (j < cps.length && IN_SCRIPT_JOINERS.has(cps[j])) j++;
    if (j - i > 2 || !isScriptChar(cps[i - 1])) return true;
    const needsNext = cps.slice(i, j).some((c) => c !== 0xfe0f);
    if (needsNext && !isScriptChar(cps[j])) return true;
    i = j - 1;
  }
  return false;
}

const TRAILING = /[.,;:!?*_~'"]+$/;

/** Anything a browser would resolve as http(s), incl. "https:host" and backslash forms; "_" or a digit before it still counts. */
const SCHEME_URL = /(?<![a-z])https?:[^\s<>"'`()[\]{}]+/gi;
/** www. hosts, whatever precedes them (GitHub autolinks them after "_", "*", "(" and more). */
const WWW_URL = /www\.[^\s<>"'`()[\]{}]+/gi;
/**
 * GitHub's cmark-gfm runs a literal autolink to the first ASCII space, tab, LF, FF, CR or "<". JS `\s`
 * and micromark also stop at VT and Unicode spaces (U+00A0, U+202F, U+2028, U+3000, ...), so
 * "https://pypi.org<U+00A0>@evil.example" reads as two harmless pieces there but is one link with
 * host evil.example on GitHub. A second scan therefore runs over a copy where those spaces become
 * "_" (a URL character that GFM trims at the end); links found in either copy must pass. The
 * spaces themselves are fine in text (French and CJK typography use them).
 */
export function cmarkExtent(text: string): string {
  return text.replace(/[^\S \t\n\f\r]/g, "_");
}
const EXTENT_SCHEME_URL = /(?<![a-z])https?:[^ \t\n\f\r<]+/gi;
const EXTENT_WWW_URL = /www\.[^ \t\n\f\r<]+/gi;

/**
 * GFM's end-of-autolink rules: trailing ?!.,:*_~ (plus ; quotes and backticks) are dropped, an
 * unbalanced trailing ")" is dropped, and so is an entity-like "&name;". Dropping trailing characters
 * is safe: whatever GitHub keeps there only appends junk to the host, never swaps it.
 */
function gfmTrim(url: string): string {
  let s = url;
  for (let i = 0; i < 50; i++) {
    const before = s;
    s = s.replace(/[?!.,:;*_~'"`]+$/, "").replace(/&[A-Za-z0-9]+;$/, "");
    if (s.endsWith(")") && s.split(")").length > s.split("(").length) s = s.slice(0, -1);
    if (s === before) break;
  }
  return s;
}

/** Email autolinks: the domain is checked like a link host. The last label needs a letter (not "pkg@2.1.0"). Bounded parts keep it linear. */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z][A-Za-z0-9-]{0,62})/g;
/** Protocol-relative targets in markdown links, reference definitions and HTML attributes. */
const PROTOCOL_RELATIVE = /(?:\]\(\s*<?|^\s*\[[^\]\n]+\]:\s*<?|=\s*["']?)\s*(\/\/[^\s)>"']+)/gim;
/** Any scheme in a markdown link or reference target. */
const LINK_SCHEME = /(?:\]\(\s*<?|^\s*\[[^\]\n]+\]:\s*<?)\s*([a-z][a-z0-9+.-]*):/gim;
/**
 * URL-bearing attributes. HTML starts a new attribute after whitespace, "/" or a closing quote
 * (`<a/href=…>`, `<a title="x"href=…>`), so all of those count as a separator here.
 */
const ATTR_NAMES = "href|src|srcset|action|formaction|style|background|poster|cite|data|on[a-z]+";
const HTML_ATTR = new RegExp(`<[a-z][^>]{0,2000}?[\\s/"'](?:${ATTR_NAMES})\\s*=`, "i");
const RENDERED_ATTR = new RegExp(`[\\s/"'](?:${ATTR_NAMES})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, "gi");
/** Tag-like text left over (escaped) in the safe render, outside code: `&lt;a/href=…`, `&lt;/div&gt;`. */
const ESCAPED_TAG = /&lt;\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/]|&gt;|$)|&lt;[!?]/;

function linkAllowed(u: URL, repo: string, hosts: Set<string>): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "github.com" || host === "www.github.com") {
    const prefix = `/${repo.toLowerCase()}`;
    const path = u.pathname.toLowerCase();
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return hosts.has(host);
}

/** An email domain passes only if allowlisted; a numeric last label is no resolvable host and is ignored. */
function emailAllowed(domain: string, hosts: Set<string>): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");
  return hosts.has(d) || !/[a-z]/.test(d.split(".").pop() ?? "");
}

/**
 * One GFM parse, compiled twice: with raw HTML passed through (every href/src it produces is
 * checked) and with it escaped (leftover tag-like text). micromark's emphasis and strikethrough
 * resolution is superlinear, so the text is parsed once and the length guard stays tight.
 */
function renderGfm(reply: string): { rawHtml: boolean; html: string; safe: string } {
  const events = postprocess(parse({ extensions: [gfm()] }).document().write(preprocess()(reply, undefined, true)));
  const rawHtml = events.some(([kind, token]) => kind === "enter" && (token.type === "htmlFlow" || token.type === "htmlText"));
  const out = (allowDangerousHtml: boolean) =>
    compile({ allowDangerousHtml, allowDangerousProtocol: true, htmlExtensions: [gfmHtml()] })(events);
  return { rawHtml, html: out(true), safe: out(false) };
}

class Findings {
  readonly reasons = new Set<string>();
  constructor(
    private readonly repo: string,
    private readonly hosts: Set<string>,
    private readonly onHost?: (host: string) => void,
  ) {}

  /** `base` resolves relative hrefs the way GitHub would for a comment on an issue page. */
  url(raw: string, base?: string): void {
    const trimmed = raw.trim();
    if (/^mailto:/i.test(trimmed)) {
      const domain = trimmed.slice(7).split(/[?#]/)[0].split("@").pop() ?? "";
      if (!emailAllowed(domain, this.hosts)) this.reasons.add("email_not_allowed");
      return;
    }
    let u: URL;
    try {
      u = new URL(trimmed.replace(TRAILING, "").replace(/\\/g, "/"), base);
    } catch {
      this.reasons.add("link_unparseable");
      return;
    }
    if (u.protocol === "https:" || u.protocol === "http:") this.onHost?.(u.hostname.toLowerCase().replace(/\.$/, ""));
    if (!linkAllowed(u, this.repo, this.hosts)) this.reasons.add("link_not_allowed");
  }

  scanText(text: string): void {
    for (const m of text.matchAll(SCHEME_URL)) this.url(m[0]);
    for (const m of text.replace(SCHEME_URL, " ").matchAll(WWW_URL)) this.url(`https://${m[0]}`);
    for (const m of text.matchAll(PROTOCOL_RELATIVE)) this.url(`https:${m[1]}`);
    for (const m of text.matchAll(LINK_SCHEME)) {
      const scheme = m[1].toLowerCase();
      if (scheme !== "http" && scheme !== "https") this.reasons.add("link_scheme");
    }
    for (const m of text.matchAll(EMAIL)) if (!emailAllowed(m[1], this.hosts)) this.reasons.add("email_not_allowed");
    if (HTML_ATTR.test(text)) this.reasons.add("html_attribute");
  }

  /** Literal autolinks at GitHub's extent (see cmarkExtent). */
  scanExtent(text: string): void {
    const t = cmarkExtent(text);
    for (const m of t.matchAll(EXTENT_SCHEME_URL)) this.url(gfmTrim(m[0]));
    for (const m of t.replace(EXTENT_SCHEME_URL, " ").matchAll(EXTENT_WWW_URL)) this.url(`https://${gfmTrim(m[0])}`);
    for (const m of t.matchAll(EMAIL)) if (!emailAllowed(m[1], this.hosts)) this.reasons.add("email_not_allowed");
  }

  scanRendered(reply: string): void {
    let r: ReturnType<typeof renderGfm>;
    try {
      r = renderGfm(reply);
    } catch {
      this.reasons.add("render_failed");
      return;
    }
    const { html, safe } = r;
    // Raw HTML (an HTML block or inline tag) is held outright: inside HTML blocks the renderer passes
    // tags through untouched and browsers parse attributes more loosely than any regex here.
    if (r.rawHtml || html !== safe) this.reasons.add("raw_html");
    const outsideCode = safe.replace(/<pre>[\s\S]*?<\/pre>/g, "").replace(/<code>[\s\S]*?<\/code>/g, "");
    if (ESCAPED_TAG.test(outsideCode)) this.reasons.add("raw_html");
    const base = `https://github.com/${this.repo}/issues/0`;
    for (const m of html.matchAll(RENDERED_ATTR)) this.url(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ""), base);
  }
}

/**
 * Hosts of every http(s) link the output check would examine in a reply: literal URLs at GitHub's
 * extent, protocol-relative targets, entity-decoded text, and hrefs/srcs of the rendered Markdown.
 * Pure; the eval scorer uses it so "linked" means the same thing in both places.
 */
export function extractLinkHosts(reply: string): string[] {
  const hosts = new Set<string>();
  const f = new Findings("x/x", new Set(), (h) => hosts.add(h));
  for (const text of new Set([reply, normaliseForScan(reply)])) {
    f.scanText(text);
    f.scanExtent(text);
  }
  f.scanRendered(reply);
  return [...hosts];
}

export function checkOutput(reply: string, ctx: { repo: string; runId: string; docsHosts?: string[] }): OutputCheck {
  if (reply.length > MAX_CHECKED_CHARS) return { valid: false, reasons: ["too_long"] };
  const f = new Findings(ctx.repo, new Set(allowedLinkHosts(ctx.docsHosts)));
  for (const text of new Set([reply, normaliseForScan(reply)])) {
    // On the normalised copy too: "&#xFEFF;" becomes the real character in the browser.
    if (hasInvisibleChars(text)) f.reasons.add("invisible_char");
    for (const s of detectInjectionSignals(text)) if (!IGNORED_SIGNALS.has(s.id)) f.reasons.add(s.id);
    for (const s of detectSecrets(text)) f.reasons.add(s.id);
    // detectInjectionSignals strips our marker before scanning, so the canary is checked on the text itself.
    if (/porter[-_]run/i.test(text) || text.toLowerCase().includes(ctx.runId.toLowerCase())) f.reasons.add("run_marker");
    if (text.includes("<!--")) f.reasons.add("html_comment");
    f.scanText(text);
    f.scanExtent(text);
  }
  f.scanRendered(reply);
  // Reasons are ids only: nothing from the draft (hosts, text) is stored.
  return { valid: f.reasons.size === 0, reasons: [...f.reasons] };
}
