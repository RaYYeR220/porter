import { decide, detectInjectionSignals } from "porter-guard";
import type { Signal, SignalId } from "porter-guard";
import type { AttackCase } from "../eval/corpus";
import type { HeroAttack, HeroData, PayloadRun } from "../components/hero/data";

/** How many open issues the hero cycles through, and the longest title it keeps. */
export const MAX_ISSUES = 60;
const MAX_TITLE = 60;
/** Glyphs per payload column: about what fits under the line in the hero band. */
const MAX_PAYLOAD = 22;
const MAX_LEAD = 16;

/** The signal shown on a held label, strongest first. */
const SIGNAL_ORDER: SignalId[] = [
  "hidden_html_comment",
  "bidi_override",
  "exfil_link",
  "tool_bait",
  "role_block",
  "zero_width",
  "ignore_previous",
  "base64_blob",
];

/** Invisible characters drawn as a visible token, so the raw lens can show them. */
const INVISIBLE: Record<string, string> = {
  "​": "⟨ZW⟩",
  "‌": "⟨ZW⟩",
  "‍": "⟨ZW⟩",
  "⁠": "⟨ZW⟩",
  "﻿": "⟨ZW⟩",
  "‪": "⟨LRE⟩",
  "‫": "⟨RLE⟩",
  "‬": "⟨PDF⟩",
  "‭": "⟨LRO⟩",
  "‮": "⟨RLO⟩",
  "⁦": "⟨LRI⟩",
  "⁧": "⟨RLI⟩",
  "⁨": "⟨FSI⟩",
  "⁩": "⟨PDI⟩",
};
const TAG_CHAR = /[\u{E0000}-\u{E007F}]/u;

export type SnapshotRow = { number: number; title: string; state: string };

/** Open issues, newest first, as number + title. Titles that could carry a handle (@…) are left out. */
export function issueRows(rows: SnapshotRow[], max = MAX_ISSUES): Array<[number, string]> {
  return rows
    .filter((r) => r.state.toLowerCase() === "open")
    .map((r) => [r.number, r.title.replace(/\s+/g, " ").trim()] as [number, string])
    .filter(([n, t]) => Number.isInteger(n) && n > 0 && t.length > 0 && !t.includes("@"))
    .sort((a, b) => b[0] - a[0])
    .slice(0, max)
    .map(([n, t]) => [n, t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t]);
}

const offsetOf = (s: Signal) => {
  const m = /offset=(\d+)/.exec(s.excerpt);
  return m ? Number(m[1]) : -1;
};

/** True when the detectors alone hold the text, with every classifier answering "clean". */
export function heldBySignals(signals: Signal[]): boolean {
  if (!signals.length) return false;
  return !decide("prompt-injection", signals, [{ model: "classifier", flagged: false, score: 0, latencyMs: 0 }]).valid;
}

/** The raw characters from the signal's offset, invisible ones as tokens, split into hidden and visible runs. */
export function payloadRuns(body: string, offset: number): PayloadRun[] {
  const raw = [...body.slice(offset, offset + 200)];
  const comment = body.startsWith("<!--", offset);
  const runs: PayloadRun[] = [];
  let count = 0;
  let cut = false;
  let cutAtSpace = false;
  const push = (text: string, hidden: boolean) => {
    const last = runs[runs.length - 1];
    if (last && last[1] === hidden) last[0] += text;
    else runs.push([text, hidden]);
  };
  for (const ch of raw) {
    if (TAG_CHAR.test(ch)) continue;
    const token = INVISIBLE[ch];
    const text = token ?? (/\s/.test(ch) ? " " : ch);
    const len = [...text].length;
    if (count + len > MAX_PAYLOAD) {
      cut = true;
      cutAtSpace = text === " ";
      break;
    }
    if (text === " " && runs.length && runs[runs.length - 1][0].endsWith(" ")) continue;
    push(text, comment || token !== undefined);
    count += len;
  }
  if (!runs.length) return runs;
  const last = runs[runs.length - 1];
  if (cut && !cutAtSpace) {
    // end on a whole word when one finishes close to the cut
    const space = last[0].lastIndexOf(" ");
    if (space > 0 && last[0].length - space <= 7) last[0] = last[0].slice(0, space);
  }
  last[0] = last[0].trimEnd();
  if (cut) last[0] += "…";
  return runs.filter((r) => r[0].length > 0);
}

/** The first words of a title, short enough to lead a column. */
export function leadOf(title: string): string {
  const words = title.replace(/[`*]/g, "").split(/\s+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    if ((out ? out.length + 1 : 0) + w.length > MAX_LEAD) break;
    out = out ? `${out} ${w}` : w;
  }
  // a long first word (an identifier) stays whole
  return `${out || words[0]?.slice(0, MAX_LEAD + 8) || "Issue"} `;
}

/** Corpus attacks the gateway detectors hold on their own, with the signal they report and where it sits. */
export function attackRows(cases: AttackCase[]): HeroAttack[] {
  const out: HeroAttack[] = [];
  for (const c of cases) {
    const signals = detectInjectionSignals(c.body);
    if (!heldBySignals(signals)) continue;
    const signal = SIGNAL_ORDER.map((id) => signals.find((s) => s.id === id)).find((s) => s && offsetOf(s) >= 0);
    if (!signal) continue;
    const payload = payloadRuns(c.body, offsetOf(signal));
    if (!payload.length) continue;
    out.push({ id: c.id, signal: signal.id, lead: leadOf(c.title), payload });
  }
  return out;
}

export function buildHeroData(input: {
  repo: string;
  snapshotAt: Date | null;
  issues: SnapshotRow[];
  attacks: AttackCase[];
  spam: string[];
}): HeroData {
  return {
    source: { repo: input.repo, snapshotAt: input.snapshotAt ? input.snapshotAt.toISOString().slice(0, 10) : null },
    issues: issueRows(input.issues),
    attacks: attackRows(input.attacks),
    spam: input.spam.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean),
  };
}
