import { guardHandler } from "../../../../lib/guard";

export const runtime = "nodejs";
export const maxDuration = 60;

export function POST(req: Request): Promise<Response> {
  return guardHandler().validate(req);
}
