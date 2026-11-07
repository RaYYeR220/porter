import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { detectInjectionSignals, detectSecrets } from "porter-guard";

/**
 * Output check on the final reply, in-process and model-free (Otari enforces input guardrails only).
 * Uses porter-guard's deterministic detectors, a run-marker canary and a link allowlist. Links are
 * found two ways and both must pass: a regex scan over the raw and the normalised text (entities
 * decoded, backslash escapes removed), and the hrefs/srcs of the reply rendered as GitHub Markdown.
 */

/** tool_bait targets text addressed to agents; in a reply to a human ("please run this command") it is noise. */
const IGNORED_SIGNALS = new Set(["tool_bait"]);

const BASE_LINK_HOSTS = ["pypi.org", "npmjs.com", "www.npmjs.com", "docs.python.org"];

export function allowedLinkHosts(docsHosts: string[] = []): string[] {
  return [...new Set([...BASE_LINK_HOSTS, ...docsHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)])];
}

export type OutputCheck = { valid: boolean; reasons: string[] };

function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "�";
}

function decodeOnce(s: string): string {
  return s
    .replace(/&#[xX]([0-9a-fA-F]{1,6});?/g, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});?/g, (_, d: string) => codePoint(parseInt(d, 10)))
    .replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (m, name: string) => {
      const v = decodeNamedCharacterReference(name);
      return v === false ? m : v;
    });
}

/** HTML numeric and named character references, decoded twice so "&amp;#58;" cannot hide a colon. */
export function decodeEntities(s: string): string {
  return decodeOnce(decodeOnce(s));
}

/** Text as a Markdown renderer or a browser would read it: references decoded, backslash escapes removed. */
export function normaliseForScan(s: string): string {
  return decodeEntities(s).replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

const TRAILING = /[.,;:!?*_~'"]+$/;

/** Anything a browser would resolve as http(s), incl. "https:host" and backslash forms; "_" or a digit before it still counts. */
const SCHEME_URL = /(?<![a-z])https?:[^\s<>"'`()[\]{}]+/gi;
/** www. hosts, whatever precedes them (GitHub autolinks them after "_", "*", "(" and more). */
const WWW_URL = /www\.[^\s<>"'`()[\]{}]+/gi;
/** Email autolinks: the domain is checked like a link host. The last label needs a letter (not "pkg@2.1.0"). */
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z][A-Za-z0-9-]*)/g;
/** Protocol-relative targets in markdown links, reference definitions and HTML attributes. */
const PROTOCOL_RELATIVE = /(?:\]\(\s*<?|^\s*\[[^\]\n]+\]:\s*<?|=\s*["']?)\s*(\/\/[^\s)>"']+)/gim;
/** Any scheme in a markdown link or reference target. */
const LINK_SCHEME = /(?:\]\(\s*<?|^\s*\[[^\]\n]+\]:\s*<?)\s*([a-z][a-z0-9+.-]*):/gim;
/** Raw HTML that can carry a URL or behaviour. */
const HTML_ATTR = /<[a-z][^>]*\s(?:href|src|srcset|action|formaction|style|background|on[a-z]+)\s*=/i;
/** URL-bearing attributes in rendered HTML (quoted by micromark; raw HTML passes through too). */
const RENDERED_ATTR = /\s(?:href|src|srcset|action|formaction|background|poster|cite|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

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

class Findings {
  readonly reasons = new Set<string>();
  constructor(
    private readonly repo: string,
    private readonly hosts: Set<string>,
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

  scanRendered(reply: string): void {
    let html: string;
    try {
      html = micromark(reply, {
        allowDangerousHtml: true,
        allowDangerousProtocol: true,
        extensions: [gfm()],
        htmlExtensions: [gfmHtml()],
      });
    } catch {
      this.reasons.add("render_failed");
      return;
    }
    const base = `https://github.com/${this.repo}/issues/0`;
    for (const m of html.matchAll(RENDERED_ATTR)) this.url(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ""), base);
  }
}

export function checkOutput(reply: string, ctx: { repo: string; runId: string; docsHosts?: string[] }): OutputCheck {
  const f = new Findings(ctx.repo, new Set(allowedLinkHosts(ctx.docsHosts)));
  for (const text of new Set([reply, normaliseForScan(reply)])) {
    for (const s of detectInjectionSignals(text)) if (!IGNORED_SIGNALS.has(s.id)) f.reasons.add(s.id);
    for (const s of detectSecrets(text)) f.reasons.add(s.id);
    // detectInjectionSignals strips our marker before scanning, so the canary is checked on the text itself.
    if (/porter[-_]run/i.test(text) || text.toLowerCase().includes(ctx.runId.toLowerCase())) f.reasons.add("run_marker");
    if (text.includes("<!--")) f.reasons.add("html_comment");
    f.scanText(text);
  }
  f.scanRendered(reply);
  // Reasons are ids only: nothing from the draft (hosts, text) is stored.
  return { valid: f.reasons.size === 0, reasons: [...f.reasons] };
}
