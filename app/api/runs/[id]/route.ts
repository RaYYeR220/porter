import { guarded } from "../../../../lib/api/common";
import { handleRunGet } from "../../../../lib/api/runs";
import { productionApi } from "../../../../lib/api/services";

export const dynamic = "force-dynamic";

export function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return guarded(async () => handleRunGet((await ctx.params).id, productionApi.runs(), productionApi.kv()));
}
