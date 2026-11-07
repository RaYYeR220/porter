export interface GitHubWriter {
  addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  postComment(repo: string, issue: number, body: string): Promise<void>;
  closeAsDuplicate(repo: string, issue: number, duplicateOf: number): Promise<void>;
}

export type InstallationLookup = (repo: string) => Promise<string | null>;

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`invalid repo name: ${repo}`);
  return { owner, repo: name };
}

/**
 * GitHub App implementation. Credentials (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY) and the
 * installation id are read lazily, so importing this module never needs them.
 */
export function githubAppWriter(installationIdFor: InstallationLookup): GitHubWriter {
  async function octokitFor(repo: string) {
    const installationId = await installationIdFor(repo);
    if (!installationId) throw new Error("no installation for repo");
    return installationOctokit(installationId);
  }
  return {
    async addLabels(repo, issue, labels) {
      const o = await octokitFor(repo);
      await o.rest.issues.addLabels({ ...splitRepo(repo), issue_number: issue, labels });
    },
    async postComment(repo, issue, body) {
      const o = await octokitFor(repo);
      await o.rest.issues.createComment({ ...splitRepo(repo), issue_number: issue, body });
    },
    async closeAsDuplicate(repo, issue, duplicateOf) {
      const o = await octokitFor(repo);
      const target = splitRepo(repo);
      await o.rest.issues.createComment({ ...target, issue_number: issue, body: `Closing as a duplicate of #${duplicateOf}.` });
      await o.rest.issues.update({ ...target, issue_number: issue, state: "closed", state_reason: "duplicate" });
    },
  };
}

/** Installation-scoped Octokit for the Porter GitHub App. */
export async function installationOctokit(installationId: string) {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) throw new Error("GitHub App is not configured");
  const { App } = await import("octokit");
  const app = new App({ appId, privateKey: privateKey.replace(/\\n/g, "\n") });
  return app.getInstallationOctokit(Number(installationId));
}
