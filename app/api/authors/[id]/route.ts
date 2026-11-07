import { handleAuthorAction } from "../../../../lib/api/author-actions";
import { guarded } from "../../../../lib/api/common";
import { productionApi } from "../../../../lib/api/services";

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return guarded(async () => handleAuthorAction(req, (await ctx.params).id, productionApi.authorActions()));
}
