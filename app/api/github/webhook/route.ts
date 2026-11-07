import { after } from "next/server";
import { productionServices, routeDeps } from "../../../../lib/github/app";
import { processJob, routeEvent, verifySignature } from "../../../../lib/github/webhook";
import { getGithubEnv } from "../../../../lib/env";

export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  // The signature covers the exact bytes: read the body once, as text.
  const raw = await req.text();
  let secret: string;
  try {
    secret = getGithubEnv().webhookSecret;
  } catch {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  if (!(await verifySignature(raw, req.headers.get("x-hub-signature-256"), secret))) {
    return Response.json({ error: "bad_signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  const deliveryId = req.headers.get("x-github-delivery") ?? "";
  if (event === "ping") return Response.json({ ok: true, pong: true });
  if (!deliveryId) return Response.json({ error: "missing_delivery_id" }, { status: 400 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  // Acknowledge now (GitHub gives 10 s); routing and the run continue after the response.
  after(async () => {
    try {
      const route = await routeEvent(event, deliveryId, payload, routeDeps());
      await processJob(route, deliveryId, productionServices());
    } catch (e) {
      console.warn(`porter webhook failed: ${e instanceof Error ? e.name : "error"}`);
    }
  });
  return Response.json({ accepted: true }, { status: 202 });
}
