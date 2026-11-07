import { guarded } from "../../../../lib/api/common";
import { handleProposalDecision } from "../../../../lib/api/proposal-decision";
import { productionApi } from "../../../../lib/api/services";

export const maxDuration = 60;

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return guarded(async () => handleProposalDecision(req, (await ctx.params).id, productionApi.proposals()));
}
