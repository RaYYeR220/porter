/** Minimal GitHub webhook payloads (only the fields Porter reads). */

export const REPO = "RaYYeR220/porter-demo";
export const SLUG = "porter-front-desk";

type User = { login: string; type: "User" | "Bot" };

const user = (login: string, type: User["type"] = "User"): User => ({ login, type });

export function issuesOpened(over: { number?: number; title?: string; body?: string | null; author?: User; repo?: string } = {}) {
  return {
    action: "opened",
    issue: {
      number: over.number ?? 12,
      title: over.title ?? "Crash when config is empty",
      body: over.body === undefined ? "Running with an empty file raises KeyError." : over.body,
      user: over.author ?? user("alice"),
      author_association: "NONE",
    },
    repository: { full_name: over.repo ?? REPO },
  };
}

export function issueComment(over: {
  body: string;
  commenter?: User;
  association?: string;
  number?: number;
  title?: string;
  repo?: string;
  pullRequest?: boolean;
}) {
  return {
    action: "created",
    issue: {
      number: over.number ?? 12,
      title: over.title ?? "Crash when config is empty",
      body: "original body",
      user: user("alice"),
      ...(over.pullRequest ? { pull_request: { url: "https://api.github.com/x" } } : {}),
    },
    comment: {
      body: over.body,
      user: over.commenter ?? user("bob"),
      author_association: over.association ?? "NONE",
    },
    repository: { full_name: over.repo ?? REPO },
  };
}

export const botUser = (login = `${SLUG}[bot]`) => user(login, "Bot");
export { user };
