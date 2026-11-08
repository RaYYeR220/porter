import { createGuardHandler } from "porter-guard";
import type { ChatFn } from "porter-guard";
import { guardVerdictLogger } from "./agent/record";
import { db } from "./db/client";
import { createOtariClient } from "./otari/client";
import { getGuardEnv } from "./env";

type Handler = ReturnType<typeof createGuardHandler>;
let cached: Handler | undefined;

/** Adapts the Otari client (guard key) to the package's ChatFn. `fetchImpl` lets scripts/probe-shapes.ts record the raw responses. */
export function otariChat(apiKey: string, baseUrl?: string, fetchImpl?: typeof fetch): ChatFn {
  const client = createOtariClient({ apiKey, baseUrl, fetchImpl });
  return async (body) => {
    const { data } = await client.chat(body, { tags: { app: "porter", role: "guard" } });
    return { content: data.choices?.[0]?.message?.content ?? "" };
  };
}

/** Built lazily so env is read in the request path, not at import time. */
export function guardHandler(): Handler {
  if (!cached) {
    const env = getGuardEnv();
    const chat: ChatFn = env.OTARI_KEY_GUARD
      ? otariChat(env.OTARI_KEY_GUARD, env.OTARI_BASE_URL)
      : async () => {
          throw new Error("OTARI_KEY_GUARD not configured");
        };
    cached = createGuardHandler({
      token: env.GUARD_TOKEN,
      chat,
      // Inserted after the response is sent; a database failure never changes a verdict.
      onVerdict: guardVerdictLogger(db),
    });
  }
  return cached;
}
