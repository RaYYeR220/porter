import type { Decision, ModelVerdict, ProfileName, Signal } from "./protocol.ts";

const STRONG = new Set(["hidden_html_comment", "bidi_override", "exfil_link", "tool_bait"]);

function ids(signals: Signal[]): string {
  return [...new Set(signals.map((s) => s.id))].join(", ");
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Always returns a hard boolean; never null. */
export function decide(profile: ProfileName, signals: Signal[], verdicts: ModelVerdict[]): Decision {
  if (profile === "secrets") {
    const secrets = signals.filter((s) => s.id.startsWith("secret_"));
    return secrets.length
      ? { valid: false, score: 1, explanation: `secret detected: ${ids(secrets)}` }
      : { valid: true, score: 0, explanation: "no secrets detected" };
  }

  const answered = verdicts.filter((v) => v.flagged !== null);
  const maxScore = answered.reduce((m, v) => Math.max(m, v.score ?? 0), 0);

  if (profile === "harm") {
    const hit = verdicts.find((v) => v.flagged === true);
    if (hit) return { valid: false, score: round(hit.score ?? 0.9), explanation: `harmful content flagged by ${hit.model}` };
    if (!answered.length) return { valid: true, score: 0, explanation: "classifier_unavailable (harm profile fails open)" };
    return { valid: true, score: round(maxScore), explanation: "no harm detected" };
  }

  // prompt-injection
  const flagged = verdicts.filter((v) => v.flagged === true && (v.score ?? 0) >= 0.5);
  if (flagged.length) {
    const top = Math.max(...flagged.map((v) => v.score ?? 0));
    const extra = signals.length ? `; signals: ${ids(signals)}` : "";
    return { valid: false, score: round(top), explanation: `prompt injection flagged by ${flagged.map((v) => v.model).join(", ")}${extra}` };
  }

  const strong = signals.some((s) => STRONG.has(s.id));
  const combo = signals.some((s) => s.id === "role_block") && signals.some((s) => s.id === "ignore_previous");
  const many = new Set(signals.map((s) => s.id)).size >= 2;
  if (strong || combo || many) {
    return { valid: false, score: strong || combo ? 0.9 : 0.7, explanation: `injection signals: ${ids(signals)}` };
  }

  if (!answered.length) {
    return signals.length
      ? { valid: false, score: 0.6, explanation: `injection signals: ${ids(signals)} (classifiers unavailable)` }
      : { valid: false, score: 0.5, explanation: "classifier_unavailable" };
  }

  return { valid: true, score: round(maxScore), explanation: signals.length ? `weak signals only (${ids(signals)}); classifiers clean` : "no injection detected" };
}
