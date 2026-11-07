import type { Signal, SignalId } from "./protocol.ts";

/** Hard cap on scanned characters so pathological inputs cannot burn CPU. */
const MAX_SCAN = 200_000;

const RUN_MARKER = /\[porter-run [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\]/gi;
const FENCE = /(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|$)/g;

export function stripRunMarker(text: string): string {
  return text.replace(RUN_MARKER, "");
}

function stripFences(text: string): string {
  return text.replace(FENCE, "");
}

function excerpt(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "..." : flat;
}

function redact(s: string): string {
  return s.slice(0, 6) + "...[redacted]";
}

const IGNORE_PREVIOUS =
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|every\s+)?(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules?|context|messages?|guidelines?)|\byou\s+are\s+now\s+(?:a|an|in)\b|\bnew\s+instructions?\s*:/i;

/** An HTML comment only counts when its body reads like it is talking to an agent. */
const COMMENT_BAIT =
  /\b(?:ignore|disregard|forget|override|instructions?|system prompt|assistant|agent|ai|llm|model|bot|porter|you\s+(?:must|should|will|are)|do not tell|don'?t tell|secret|token|api[_ -]?key|exfiltrat\w*|send\s+\w+\s+to)\b/i;

const ROLE_BLOCK = /^[ \t]{0,3}#{1,6}[ \t]*(?:system|assistant|developer)[ \t]*:|<\|(?:im_start|im_end|system|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|^[ \t]*<\/?(?:system|assistant)>[ \t]*$/im;

const TOOL_BAIT =
  /\b(?:you\s+(?:must|should|need\s+to|will|have\s+to)|please|now)\b[^\n.]{0,50}\b(?:call|invoke|run|execute|use)\b[^\n.]{0,40}\b(?:tool|function|mcp|shell|bash|terminal|command|fetch|search)\b|\btool_calls?\b\s*[:=]/i;

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
  const add = (id: SignalId, ex: string) => out.push({ id, excerpt: excerpt(ex) });

  for (const m of unfenced.matchAll(/<!--([\s\S]{0,4000}?)-->/g)) {
    if (IGNORE_PREVIOUS.test(m[1]) || COMMENT_BAIT.test(m[1]) || ROLE_BLOCK.test(m[1]) || TOOL_BAIT.test(m[1])) {
      add("hidden_html_comment", m[0]);
      break;
    }
  }

  const zw = find(/[​‌‍⁠﻿]{3,}/, full);
  if (zw) add("zero_width", `${zw[0].length} zero-width characters`);

  const bidi = find(/[‪-‮⁦-⁩]/, full);
  if (bidi) add("bidi_override", `U+${bidi[0].codePointAt(0)!.toString(16).toUpperCase()}`);

  for (const m of full.matchAll(/[A-Za-z0-9+/]{200,}={0,2}/g)) {
    if (looksLikeAscii(m[0])) {
      add("base64_blob", m[0].slice(0, 40));
      break;
    }
  }

  const role = find(ROLE_BLOCK, unfenced);
  if (role) add("role_block", role[0]);

  const ign = find(IGNORE_PREVIOUS, unfenced);
  if (ign) add("ignore_previous", ign[0]);

  const bait = find(TOOL_BAIT, unfenced);
  if (bait) add("tool_bait", bait[0]);

  for (const m of full.matchAll(/!?\[[^\]\n]{0,200}\]\((https?:\/\/[^)\s]{1,2000})\)/gi)) {
    const url = m[1];
    if (/\{\{|\$\{|%7B%7B|<[a-z_ ]*(?:secret|token|key|env)/i.test(url) || /[?&#][^=&]*=[^&]*(?:secret|token|api[_-]?key|password|env)/i.test(url)) {
      add("exfil_link", m[0]);
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
    if (m) out.push({ id, excerpt: redact(m[0]) });
  }
  return out;
}
