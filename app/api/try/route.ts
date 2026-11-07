import { after } from "next/server";
import { guarded } from "../../../lib/api/common";
import { productionApi } from "../../../lib/api/services";
import { handleTry } from "../../../lib/try/handler";

export const maxDuration = 300;

export function POST(req: Request): Promise<Response> {
  return guarded(() => handleTry(req, productionApi.try((work) => after(work))));
}
