export const REPO_URL = "https://github.com/RaYYeR220/porter";
/** The branch the eval files and results are committed on. */
export const REPO_BRANCH = "devs-wilding";
/** A file in the repository on GitHub, e.g. repoFile("eval/PREREGISTRATION.md"). */
export const repoFile = (path: string) => `${REPO_URL}/blob/${REPO_BRANCH}/${path.replace(/^\/+/, "")}`;

/** The production origin, for absolute links in metadata. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://porter-frontdesk.vercel.app";

export const NAV_LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/eval", label: "Eval" },
  { href: "/report/otari", label: "Otari report" },
  { href: "/try", label: "Try it" },
  { href: "/console", label: "Console" },
] as const;

const REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Where "Open a test issue" goes: a new issue on the demo repo when one is configured,
 * otherwise the in-browser try page.
 */
export function openIssueHref(demoRepo: string | undefined = process.env.NEXT_PUBLIC_DEMO_REPO): string {
  const repo = demoRepo?.trim();
  return repo && REPO_NAME.test(repo) ? `https://github.com/${repo}/issues/new` : "/try";
}
