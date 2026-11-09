import { handleCeiling } from "../../../lib/api/ceiling";
import { guarded } from "../../../lib/api/common";
import { productionApi } from "../../../lib/api/services";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return guarded(() => handleCeiling(productionApi.ceiling()));
}
