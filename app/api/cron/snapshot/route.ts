import { eq } from "drizzle-orm";
import { db } from "../../../../lib/db/client";
import { repos } from "../../../../lib/db/schema";
import { installationOctokit } from "../../../../lib/mcp/github-write";
import { bearerMatches } from "../../../../lib/mcp/runtime";
import { ingestRepo } from "../../../../lib/snapshot/ingest";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Re-snapshots the demo repository only. The shadow repository is never refreshed automatically. */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "cron_not_configured" }, { status: 503 });
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const demo = process.env.DEMO_REPO;
  if (!demo) return Response.json({ error: "demo_repo_not_configured" }, { status: 503 });
  const [repo] = await db().select().from(repos).where(eq(repos.fullName, demo)).limit(1);
  if (!repo || repo.kind !== "demo" || !repo.installationId) {
    return Response.json({ error: "demo_repo_not_ready" }, { status: 409 });
  }
  const octokit = await installationOctokit(repo.installationId);
  const result = await ingestRepo(demo, "demo", { octokit });
  return Response.json({ repo: demo, ...result });
}
