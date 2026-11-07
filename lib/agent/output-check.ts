import { detectInjectionSignals, detectSecrets } from "porter-guard";

/**
 * Output check on the final reply, in-process and model-free (Otari enforces input guardrails only).
 * Uses porter-guard's deterministic detectors, a run-marker canary and a link allowlist.
 */

/** tool_bait targets text addressed to agents; in a reply to a human ("please run this command") it is noise. */
const IGNORED_SIGNALS = new Set(["tool_bait"]);

const BASE_LINK_HOSTS = ["pypi.org", "npmjs.com", "www.npmjs.com", "docs.python.org"];

export function allowedLinkHosts(docsHosts: string[] = []): string[] {
  return [...new Set([...BASE_LINK_HOSTS, ...docsHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)])];
}

export type OutputCheck = { valid: boolean; reasons: string[] };

const TRAILING = /[.,;:!?*_~'"]+$/;

/** Anything a browser would resolve as http(s), incl. "https:host" and backslash forms. */
const SCHEME_URL = /\bhttps?:[^\s<>"'`()[\]{}]+/gi;
/** GitHub autolinks bare www. hosts. */
const WWW_URL = /(?<![\w@./-])www\.[^\s<>"'`()[\]{}]+/gi;
/** Protocol-relative targets in markdown links, reference definitions and HTML attributes. */
const PROTOCOL_RELATIVE = /(?:\]\(\s*<?|^\s*\[[^\]\n]+\]:\s*<?|=\s*["']?)\s*(\/\/[^\s)>"']+)/gim;
/** Any scheme in a markdown link or reference target. */
const LINK_SCHEME = /(?:\]\(\s*<?|^\s*\[[^\]\n]+\]:\s*<?)\s*([a-z][a-z0-9+.-]*):/gim;
/** Raw HTML that can carry a URL or behaviour. */
const HTML_ATTR = /<[a-z][^>]*\s(?:href|src|srcset|action|formaction|style|background|on[a-z]+)\s*=/i;

function parse(raw: string): URL | null {
  try {
    return new URL(raw.replace(TRAILING, "").replace(/\\/g, "/"));
  } catch {
    return null;
  }
}

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

function linkViolations(reply: string, repo: string, hosts: Set<string>): string[] {
  const out = new Set<string>();
  const checkUrl = (raw: string) => {
    const u = parse(raw);
    if (!u) out.add("link_unparseable");
    else if (!linkAllowed(u, repo, hosts)) out.add(`link_not_allowed:${u.hostname.toLowerCase() || "?"}`);
  };
  for (const m of reply.matchAll(SCHEME_URL)) checkUrl(m[0]);
  for (const m of reply.matchAll(WWW_URL)) checkUrl(`https://${m[0]}`);
  for (const m of reply.matchAll(PROTOCOL_RELATIVE)) checkUrl(`https:${m[1]}`);
  for (const m of reply.matchAll(LINK_SCHEME)) {
    const scheme = m[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") out.add(`link_scheme:${scheme}`);
  }
  if (HTML_ATTR.test(reply)) out.add("html_attribute");
  return [...out];
}

export function checkOutput(reply: string, ctx: { repo: string; runId: string; docsHosts?: string[] }): OutputCheck {
  const reasons = new Set<string>();
  for (const s of detectInjectionSignals(reply)) if (!IGNORED_SIGNALS.has(s.id)) reasons.add(s.id);
  for (const s of detectSecrets(reply)) reasons.add(s.id);
  // detectInjectionSignals strips our marker before scanning, so the canary is checked on the raw text.
  if (/porter[-_]run/i.test(reply) || reply.toLowerCase().includes(ctx.runId.toLowerCase())) reasons.add("run_marker");
  if (reply.includes("<!--")) reasons.add("html_comment");
  for (const r of linkViolations(reply, ctx.repo, new Set(allowedLinkHosts(ctx.docsHosts)))) reasons.add(r);
  return { valid: reasons.size === 0, reasons: [...reasons] };
}
