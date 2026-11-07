/** Fixed, model-free replies. They never quote the issue, a model or a guard verdict. */

const INTRO = "Thanks for opening this issue.";
const ASSISTANT = "Porter, this repository's automated assistant,";

/** Seconds → "1 h 30 min", rounded up to the next minute (never "0 min"). */
export function formatWait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Plain-language reason per held profile; unknown profiles get none. */
const HELD_REASONS: Record<string, string> = {
  "prompt-injection":
    "Part of the text reads like instructions addressed to an automated assistant (legitimate security reports can look like this too), so Porter did not act on it.",
  secrets:
    "The text may contain a credential such as an access token or a private key. If it does, revoke it now and edit it out of the issue; Porter will not repeat it.",
  harm: "Porter does not handle this kind of content automatically.",
};

/**
 * `profile` picks the held wording ("output" = our own output check stopped the draft; nothing is
 * queued for posting then). `step` is the call a budget refusal hit: only "triage" (or unknown)
 * means Porter never looked at the issue.
 */
export type FixedReplyCtx = {
  retryAfterSec?: number;
  profile?: string;
  scope?: string;
  step?: "triage" | "repro" | "review";
};

export function fixedReply(kind: "held_guardrail" | "refused_budget", ctx: FixedReplyCtx = {}): string {
  if (kind === "held_guardrail") {
    const first =
      ctx.profile === "output"
        ? `${INTRO} ${ASSISTANT} couldn't send an automatic reply this time, so it has passed the issue to a maintainer.`
        : `${INTRO} ${ASSISTANT} has passed it to a maintainer instead of answering it automatically.`;
    const reason = ctx.profile ? HELD_REASONS[ctx.profile] : undefined;
    return [
      `${first}${reason ? ` ${reason}` : ""}`,
      "",
      "A maintainer will read it and follow up here. Nothing has been labelled or closed.",
    ].join("\n");
  }

  const wait =
    typeof ctx.retryAfterSec === "number" && Number.isFinite(ctx.retryAfterSec)
      ? `The limit resets in about ${formatWait(ctx.retryAfterSec)}.`
      : "The limit resets with the next daily reset.";
  const effect =
    ctx.step === undefined || ctx.step === "triage"
      ? "so it has not looked at this issue"
      : "so it stopped before it could finish an answer to this issue";
  // Scope "user" is the reporter's own allowance; any other scope is Porter's pooled wallet.
  const who =
    ctx.scope === undefined || ctx.scope === "user"
      ? `You have reached the limit of automated answers that Porter, this repository's assistant, gives one person, ${effect}.`
      : `${ASSISTANT} has reached its own spending limit, ${effect}.`;
  return [`${INTRO} ${who} ${wait}`, "", "Maintainers can still read and answer it."].join("\n");
}

/** Appended when a repro was attempted but no sandbox run was recorded. */
export const UNVERIFIED_NOTE =
  "_Note: the snippet could not be verified: Porter has no record of it running in a sandbox._";
