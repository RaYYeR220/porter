import type { Octokit } from "octokit";
import { collectSnapshot } from "./github-source";
import type { SnapshotIssue, SnapshotRelease } from "./ingest";

/** Fetches a snapshot through an installation Octokit: at most 4 GraphQL calls plus one tarball download. */
export async function fetchViaOctokit(
  octokit: Octokit,
  fullName: string,
): Promise<{ tarball: Buffer; issues: SnapshotIssue[]; releases: SnapshotRelease[] }> {
  const [owner, name] = fullName.split("/");
  const { issues, releases } = await collectSnapshot((q, v) => octokit.graphql(q, v), owner, name);
  const res = await octokit.request("GET /repos/{owner}/{repo}/tarball", { owner, repo: name });
  return { tarball: Buffer.from(res.data as ArrayBuffer), issues, releases };
}
