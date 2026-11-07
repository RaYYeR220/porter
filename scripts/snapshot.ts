// Usage: pnpm snapshot <owner/repo> <demo|shadow>
// GitHub budget: GraphQL (open + recently closed + releases, usually 1-3 calls) plus one tarball download.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { collectSnapshot } from "../lib/snapshot/github-source";
import { ingestRepo } from "../lib/snapshot/ingest";

const run = promisify(execFile);
const MAX_GH_CALLS = 6;
let ghCalls = 0;

async function gh(args: string[]): Promise<Buffer> {
  if (++ghCalls > MAX_GH_CALLS) throw new Error(`gh call budget (${MAX_GH_CALLS}) exhausted`);
  const { stdout } = await run("gh", args, { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
  return stdout;
}

async function main() {
  const [fullName, kind] = process.argv.slice(2);
  if (!fullName?.includes("/") || (kind !== "demo" && kind !== "shadow")) {
    console.error("usage: snapshot <owner/repo> <demo|shadow>");
    process.exit(2);
  }
  const [owner, name] = fullName.split("/");
  const dir = mkdtempSync(join(tmpdir(), "porter-snapshot-"));

  const graphql = async (query: string, vars: Record<string, unknown>) => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(vars)) {
      if (v === null || v === undefined) continue;
      args.push(typeof v === "string" ? "-f" : "-F", `${k}=${String(v)}`);
    }
    const out = await gh(args);
    const parsed = JSON.parse(out.toString("utf8")) as { data: unknown };
    return parsed.data;
  };

  const { issues, releases, calls } = await collectSnapshot(graphql, owner, name, { maxCalls: 4 });
  const tarballPath = join(dir, "repo.tgz");
  // without a ref GitHub serves the default branch
  writeFileSync(tarballPath, await gh(["api", `repos/${fullName}/tarball`]));
  const issuesJsonPath = join(dir, "issues.json");
  const releasesJsonPath = join(dir, "releases.json");
  writeFileSync(issuesJsonPath, JSON.stringify(issues));
  writeFileSync(releasesJsonPath, JSON.stringify(releases));

  const result = await ingestRepo(fullName, kind, { tarballPath, issuesJsonPath, releasesJsonPath });
  console.log(JSON.stringify({ repo: fullName, kind, ...result, graphqlCalls: calls, ghCalls }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
