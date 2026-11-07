import { guardHandler } from "../../../../lib/guard";

export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  return guardHandler().profiles(req);
}
