import { applyProposal, rejectProposal, type ApplyDeps } from "../github/commands";
import { errorJson, internalError, requestHash, type Limiter, rateLimited } from "./common";

export const APPROVALS_PER_HOUR = 5;

export type ProposalDecisionDeps = ApplyDeps & {
  limit: Limiter;
  salt: () => string;
  demoRepo: string | null;
};

/** POST /api/proposals/:id {decision}. Demo-repo proposals only; shadow-repo ones are off limits. */
export async function handleProposalDecision(req: Request, rawId: string, d: ProposalDecisionDeps): Promise<Response> {
  if (!/^\d{1,9}$/.test(rawId)) return errorJson(400, "invalid_request", "bad proposal id");
  const id = Number(rawId);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "invalid_request", "invalid JSON");
  }
  const decision = (body as { decision?: unknown } | null)?.decision;
  if (decision !== "approve" && decision !== "reject") return errorJson(400, "invalid_request", "decision must be approve or reject");
  if (!d.demoRepo) return errorJson(503, "unavailable", "The demo repository is not configured yet.");

  const hash = requestHash(req, d.salt);
  if (hash instanceof Response) return hash;
  if (!(await d.limit(`rl:approve:${hash.slice(0, 16)}`, APPROVALS_PER_HOUR, 3600))) return rateLimited();

  try {
    const p = await d.store.load(id);
    if (!p) return errorJson(404, "not_found");
    if (p.repo.toLowerCase() !== d.demoRepo.toLowerCase()) return errorJson(403, "forbidden", "not a demo-repository proposal");
    if (p.status !== "pending") return errorJson(409, "not_pending");
    const decidedBy = `console:${hash.slice(0, 8)}`;

    if (decision === "reject") {
      const r = await rejectProposal(id, decidedBy, d.store);
      return r === "rejected" ? Response.json({ ok: true, status: "rejected" }) : errorJson(409, "not_pending");
    }
    const r = await applyProposal(id, decidedBy, d);
    switch (r.status) {
      case "executed":
        return Response.json({ ok: true, status: "executed" });
      case "failed":
        return errorJson(502, "apply_failed", "The tool call failed; the error is recorded on the run.");
      case "pending":
        return errorJson(503, "unavailable", "The tool server is not available right now; the proposal stays pending.");
      case "not_found":
        return errorJson(404, "not_found");
      default:
        return errorJson(409, "not_pending");
    }
  } catch (e) {
    console.warn(`porter proposal decision failed: ${e instanceof Error ? e.name : "error"}`);
    return internalError();
  }
}
