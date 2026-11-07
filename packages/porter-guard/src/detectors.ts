import type { Signal, SignalId } from "./protocol.ts";

/** Hard cap on scanned characters so pathological inputs cannot burn CPU. */
const MAX_SCAN = 200_000;

const RUN_MARKER = /\[porter-run [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\]/gi;
export function stripRunMarker(text: string): string {
  return text.replace(RUN_MARKER, "");
}

/**
 * Removes closed fenced code blocks in one linear pass. A fence opens at a line start (<=3 spaces
 * indent, run of 3+ backticks or tildes) and closes at a later line with the same char, a run at
 * least as long, and nothing after it. An opener with no closer exempts nothing: scanning resumes
 * on the next line. Closer lookup uses per-char suffix maxima so the pass never goes quadratic.
 */
function stripFences(text: string): string {
  const lines = text.split("\n");
  const OPEN = /^ {0,3}(`{3,}|~{3,})/;
  const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/;
  const closers: Record<string, { line: number; run: number }[]> = { "`": [], "~": [] };
  for (let i = 0; i < lines.length; i++) {
    const m = CLOSE.exec(lines[i]);
    if (m) closers[m[1][0]].push({ line: i, run: m[1].length });
  }
  const sufMax: Record<string, number[]> = { "`": [], "~": [] };
  for (const c of ["`", "~"]) {
    const list = closers[c];
    const s = new Array<number>(list.length + 1).fill(0);
    for (let k = list.length - 1; k >= 0; k--) s[k] = Math.max(s[k + 1], list[k].run);
    sufMax[c] = s;
  }
  const ptr: Record<string, number> = { "`": 0, "~": 0 };
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = OPEN.exec(lines[i]);
    if (m) {
      const c = m[1][0];
      const n = m[1].length;
      const list = closers[c];
      while (ptr[c] < list.length && list[ptr[c]].line <= i) ptr[c]++;
      if (sufMax[c][ptr[c]] >= n) {
        let k = ptr[c];
        while (list[k].run < n) k++;
        i = list[k].line + 1;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

/** Locator only. Raw input text never goes into a signal, so logs and responses cannot echo it. */
function locate(index: number | undefined, len: number): string {
  return `offset=${index ?? 0} len=${len}`;
}

const IGNORE_PREVIOUS =
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|every\s+)?(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules?|context|messages?|guidelines?)|\byou\s+are\s+now\s+(?:a|an|in)\b|\bnew\s+instructions?\s*:/i;

const ROLE_BLOCK = /^[ \t]{0,3}#{1,6}[ \t]*(?:system|assistant|developer)[ \t]*:|<\|(?:im_start|im_end|system|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|^[ \t]*<\/?(?:system|assistant)>[ \t]*$/im;

const TOOL_BAIT =
  /\b(?:you\s+(?:must|should|need\s+to|will|have\s+to)|please|now)\b[^\n.]{0,50}\b(?:call|invoke|run|execute|use)\b[^\n.]{0,40}\b(?:tool|function|mcp|shell|bash|terminal|command|fetch|search)\b|\btool_calls?\b\s*[:=]/i;

/**
 * Hidden comments are judged in two tiers.
 * STRONG (blocks alone): explicit bot-address prefixes, tool names and call syntax, role markers,
 * long-form "ignore previous instructions", "do not mention this", reply/render/append directives
 * aimed at the answer, markdown images with http URLs.
 * WEAK (`hidden_comment_suspect`, never blocks alone): phrasings that human template authors also
 * use ("Print the contents of config.yaml", "Ignore the above if you already filled this in").
 * The ensemble combines weak with a classifier flag or another deterministic signal.
 */
const STRONG_COMMENT = [
  /(?:^|[.!?\n])\s*(?:assistant|llm|ai(?:[ -](?:agent|assistant|bot))?|(?:llm|triage|automated)[ -](?:agent|bot|assistant))\s*[:,]/i,
  /^\s*(?:ai|llm|bot|agent)[ -]?instructions?\b/i,
  /\b(?:note|message|instructions?|attention|reminder)s?\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llm|bot|assistant|agent|triage|language model|automated)/i,
  /\bif\s+you\s+(?:are|'re)\s+(?:an?\s+|the\s+)?(?:ai|llm|bot|assistant|agent|language model|automated)/i,
  /\bai[- ]?instructions?\s*:/i,
  /\b(?:do\s+not|don'?t|never)\s+(?:mention|tell|reveal|disclose|show|say)\s+(?:this|that|these|it)\b/i,
  /\b(?:when|while|before|after)\s+(?:you\s+are\s+)?(?:replying|responding|answering|commenting|triaging)\b/i,
  /\b(?:reply|respond|answer)\s+(?:with|using)\b/i,
  /\b(?:in|at the (?:end|start) of|into)\s+(?:your|the)\s+(?:reply|answer|response|comment|output)\b/i,
  /\b(?:render|include|embed|append|prepend)\s+(?:this|the following|the token|the string|a link|an image)\b/i,
  /\btell\s+(?:the\s+)?(?:user|reporter|author)\b/i,
  /\b(?:add|remove|close|post|read|write|create|delete|update|fetch|run|exec|execute|send|set|assign|merge|approve|search|list)_[a-z][a-z_]*\b/,
  /\b[a-z]+_[a-z_]+\s*\(/,
  /!\[[^\]\n]*\]\(\s*https?:/i,
];

const WEAK_COMMENT = [
  /(?:^|[.!?\n])\s*(?:agent|bot)\s*[:,]/i,
  /\b(?:ignore|disregard|forget)\s+(?:the\s+)?(?:previous|above|prior|all\s+(?:of\s+)?that)\b/i,
  /\b(?:reveal|print|show|repeat|leak|output)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions)\b/i,
  /\b(?:the\s+)?(?:assistant|ai|bot|agent)\s+(?:should|must|will|needs?\s+to)\b/i,
  /\byou\s+are\s+(?:a|an|the)\s+\w*\s*(?:assistant|bot|agent)\b/i,
  /\b(?:output|print|dump|send|echo|reveal|leak)\s+(?:me\s+)?(?:the\s+)?(?:contents?\s+of\s+)?(?:your\s+|the\s+)?(?:env(?:ironment)?(?:\s+vars?|\s+variables)?|secrets?|credentials|config)\b/i,
  /^\s*@\w[\w-]*[\s,:]+(?:please\s+)?(?:close|label|approve|merge|assign|reopen|delete|comment|reply|respond|add|remove|mark|tag|run|post|ignore|apply|set|escalate|lock)\b/i,
  /(?:^|[.!?\n])\s*(?:triage note|maintainers?(?:'s)? note|maintainers?|system note|admin note)\s*:[^\n]{0,200}?\b(?:approve|auto-approve|merge|close|label|assign|respond|reply)\b/i,
  /\b(?:you\s+(?:must|should|will|need\s+to|are\s+to)|please)\s+(?:now\s+)?(?:call|close|label|approve|merge|assign|post|run|execute|fetch|reply|respond|append|tell|ignore|disregard|send|open|delete)\b/i,
];

type Tier = "strong" | "weak" | null;

function commentTier(body: string): Tier {
  if (IGNORE_PREVIOUS.test(body) || ROLE_BLOCK.test(body) || TOOL_BAIT.test(body) || STRONG_COMMENT.some((re) => re.test(body))) {
    return "strong";
  }
  return WEAK_COMMENT.some((re) => re.test(body)) ? "weak" : null;
}

/** Linear scan for closed HTML comments; an unclosed "<!--" ends the search. */
function* htmlComments(text: string): Generator<{ index: number; length: number; body: string }> {
  let pos = 0;
  for (;;) {
    const start = text.indexOf("<!--", pos);
    if (start === -1) return;
    const end = text.indexOf("-->", start + 4);
    if (end === -1) return;
    yield { index: start, length: end + 3 - start, body: text.slice(start + 4, Math.min(end, start + 4 + 4000)) };
    pos = end + 3;
  }
}

function find(re: RegExp, text: string): RegExpMatchArray | null {
  return text.match(re);
}

function looksLikeAscii(b64: string): boolean {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(b64, "base64");
  } catch {
    return false;
  }
  if (decoded.length < 60) return false;
  let printable = 0;
  for (const byte of decoded) {
    if ((byte >= 32 && byte < 127) || byte === 9 || byte === 10 || byte === 13) printable++;
  }
  return printable / decoded.length >= 0.95;
}

export function detectInjectionSignals(input: string): Signal[] {
  const full = stripRunMarker(input.slice(0, MAX_SCAN));
  const unfenced = stripFences(full);
  const out: Signal[] = [];
  const add = (id: SignalId, at: number | undefined, len: number) => out.push({ id, excerpt: locate(at, len) });

  let strongHit = false;
  let weakAt: { index: number; length: number } | null = null;
  let firstComment: { index: number; length: number } | null = null;
  let combined = "";
  for (const c of htmlComments(unfenced)) {
    firstComment ??= c;
    const tier = commentTier(c.body);
    if (tier === "strong") {
      add("hidden_html_comment", c.index, c.length);
      strongHit = true;
      break;
    }
    if (tier === "weak") weakAt ??= c;
    if (combined.length < 8000) combined += c.body.slice(0, 8000 - combined.length) + " ";
  }
  // Instructions split across adjacent comments are only visible when the bodies are joined.
  if (!strongHit && firstComment) {
    const tier = commentTier(combined);
    if (tier === "strong") {
      add("hidden_html_comment", firstComment.index, firstComment.length);
      strongHit = true;
    } else if (tier === "weak") weakAt ??= firstComment;
  }
  if (!strongHit && weakAt) add("hidden_comment_suspect", weakAt.index, weakAt.length);

  const zw = find(/[​‌‍⁠﻿]{3,}/, full);
  if (zw) add("zero_width", zw.index, zw[0].length);

  const bidi = find(/[‪-‮⁦-⁩]/, full);
  if (bidi) add("bidi_override", bidi.index, bidi[0].length);

  for (const m of full.matchAll(/[A-Za-z0-9+/]{200,}={0,2}/g)) {
    if (looksLikeAscii(m[0])) {
      add("base64_blob", m.index, m[0].length);
      break;
    }
  }

  const role = find(ROLE_BLOCK, unfenced);
  if (role) add("role_block", role.index, role[0].length);

  const ign = find(IGNORE_PREVIOUS, full);
  if (ign) add("ignore_previous", ign.index, ign[0].length);

  const bait = find(TOOL_BAIT, full);
  if (bait) add("tool_bait", bait.index, bait[0].length);

  for (const m of full.matchAll(/!?\[[^\]\n]{0,200}\]\((https?:\/\/[^)\s]{1,2000})\)/gi)) {
    const url = m[1];
    if (/\{\{|\$\{|%7B%7B|<[a-z_ ]*(?:secret|token|key|env)/i.test(url) || /[?&#][^=&]*=[^&]*(?:secret|token|api[_-]?key|password|env)/i.test(url)) {
      add("exfil_link", m.index, m[0].length);
      break;
    }
  }

  return out;
}

const SECRET_PATTERNS: Array<{ id: SignalId; re: RegExp }> = [
  { id: "secret_github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { id: "secret_aws_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "secret_private_key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  {
    id: "secret_api_key",
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|otk_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{36})\b/,
  },
];

export function detectSecrets(input: string): Signal[] {
  const text = stripRunMarker(input.slice(0, MAX_SCAN));
  const out: Signal[] = [];
  for (const { id, re } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) out.push({ id, excerpt: locate(m.index, m[0].length) });
  }
  return out;
}
