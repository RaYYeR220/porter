import { guarded } from "../../../lib/api/common";
import { handleRunsList } from "../../../lib/api/runs";
import { productionApi } from "../../../lib/api/services";

export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return guarded(() => handleRunsList(req, productionApi.runs(), { demoRepo: productionApi.demoRepo() }));
}
