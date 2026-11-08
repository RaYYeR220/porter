import { guarded } from "../../../lib/api/common";
import { handleProposalsList } from "../../../lib/api/proposals-list";
import { productionApi } from "../../../lib/api/services";

export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return guarded(() => handleProposalsList(req, productionApi.proposalsList()));
}
