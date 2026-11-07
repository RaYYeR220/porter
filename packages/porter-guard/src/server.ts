import { createServer } from "node:http";
import { createGuardHandler } from "./handler.ts";
import type { ChatFn } from "./protocol.ts";

const MAX_BODY = 1_000_000;

/** Minimal chat client for any OpenAI-compatible endpoint (Otari, or anything else). */
export function createFetchChat(baseUrl: string, apiKey: string): ChatFn {
  const base = baseUrl.replace(/\/+$/, "");
  return async (body) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    return { content: data.choices?.[0]?.message?.content ?? "" };
  };
}

const token = process.env.GUARD_TOKEN ?? "";
const apiKey = process.env.OTARI_API_KEY ?? "";
if (!token || !apiKey) {
  console.error("GUARD_TOKEN and OTARI_API_KEY are required");
  process.exit(1);
}

const handler = createGuardHandler({
  token,
  chat: createFetchChat(process.env.OTARI_BASE_URL ?? "https://api.otari.ai/api/v1", apiKey),
});

const port = Number(process.env.PORT ?? 8080);

createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of incoming) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) {
        outgoing.writeHead(413).end();
        return;
      }
      chunks.push(c as Buffer);
    }
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const req = new Request(url, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });

    let res: Response;
    if (url.pathname === "/health") res = Response.json({ ok: true });
    else if (url.pathname === "/validate" && incoming.method === "POST") res = await handler.validate(req);
    else if (url.pathname === "/profiles" && incoming.method === "GET") res = await handler.profiles(req);
    else res = Response.json({ error: "not_found" }, { status: 404 });

    outgoing.writeHead(res.status, { "content-type": res.headers.get("content-type") ?? "application/json" });
    outgoing.end(await res.text());
  } catch {
    outgoing.writeHead(500).end();
  }
}).listen(port, () => console.log(`porter-guard listening on :${port}`));
