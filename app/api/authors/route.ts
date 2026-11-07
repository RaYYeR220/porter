import { guarded, safeJson } from "../../../lib/api/common";
import { productionApi } from "../../../lib/api/services";
import { getAuthors } from "../../../lib/authors";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return guarded(async () => safeJson({ authors: await getAuthors(productionApi.authors()) }));
}
