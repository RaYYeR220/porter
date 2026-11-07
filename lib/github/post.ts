import type { GitHubWriter } from "../mcp/github-write";

export const RUN_PAGE_BASE = "https://porter-frontdesk.vercel.app/console/runs/";

/** Porter's reply plus a link to its run page. */
export function withRunFooter(body: string, runId: string): string {
  return `${body.trimEnd()}\n\n---\n<sub>Porter run: ${RUN_PAGE_BASE}${runId}</sub>`;
}

export type QueuedReply = {
  repo: string;
  issueNumber: number;
  body: string;
  runId?: string;
  reason: "queued_rate_limited" | "post_failed";
  /** Error class and HTTP status only, never the message. */
  error?: { name: string; status: number | null };
};

export type PostDeps = {
  writer: GitHubWriter;
  /** True while the repo is within its hourly write allowance. */
  withinLimit: (repo: string) => Promise<boolean>;
  /** Keeps a reply that could not be posted yet; it must not be lost. */
  queue: (item: QueuedReply) => Promise<void>;
};

/**
 * Posts one comment as the App. Over the rate limit, the reply is queued (stored with a
 * queued_rate_limited marker) instead of posted or dropped.
 */
export async function postReply(
  repo: string,
  issueNumber: number,
  body: string,
  deps: PostDeps,
  runId?: string,
  opts: { exempt?: boolean } = {},
): Promise<"posted" | "queued"> {
  const text = runId ? withRunFooter(body, runId) : body;
  if (!opts.exempt && !(await deps.withinLimit(repo))) {
    console.warn(`porter: write limit reached for ${repo}; reply queued`);
    await deps.queue({ repo, issueNumber, body: text, runId, reason: "queued_rate_limited" });
    return "queued";
  }
  try {
    await deps.writer.postComment(repo, issueNumber, text);
  } catch (e) {
    // The reply must not be lost: keep it like a rate-limited one.
    const status = (e as { status?: unknown } | null)?.status;
    console.warn(`porter: posting to ${repo} failed; reply queued`);
    await deps.queue({
      repo, issueNumber, body: text, runId, reason: "post_failed",
      error: { name: e instanceof Error ? e.name : "Error", status: typeof status === "number" ? status : null },
    });
    return "queued";
  }
  return "posted";
}
