import { createOtariClient } from "../otari/client";
import { OtariError } from "../otari/errors";
import { toStoredEmbedding } from "../db/vector";

export const EMBEDDING_MODEL = "alibaba/qwen3-embedding-8b";
export const EMBED_BATCH = 32;

/** Turns texts into stored (1024-dim, normalised) vectors; null where embedding was not possible. */
export type Embedder = (texts: string[]) => Promise<Array<number[] | null>>;

type EmbedClient = { embed(input: string[], model: string): Promise<number[][]> };

/**
 * Batches requests (at most 32 inputs per call) and never throws: a failed batch yields nulls
 * so callers can store rows without a vector and backfill later. After an out-of-funds error
 * no further calls are made.
 */
export function batchEmbedder(client: EmbedClient, model: string = EMBEDDING_MODEL): Embedder {
  return async (texts) => {
    const out: Array<number[] | null> = texts.map(() => null);
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const slice = texts.slice(i, i + EMBED_BATCH);
      try {
        const vectors = await client.embed(slice, model);
        if (vectors.length !== slice.length) continue;
        vectors.forEach((v, j) => {
          out[i + j] = toStoredEmbedding(v);
        });
      } catch (e) {
        if (e instanceof OtariError && e.kind === "insufficient_funds") break;
      }
    }
    return out;
  };
}

/** Embedder backed by the Otari gateway using the ops key. Returns null when no key is configured. */
export function otariEmbedderFromEnv(): Embedder | null {
  const apiKey = process.env.OTARI_KEY_OPS;
  if (!apiKey) return null;
  const client = createOtariClient({ apiKey, baseUrl: process.env.OTARI_BASE_URL });
  return batchEmbedder({
    embed: (input, model) => client.embed(input, model, { tags: { app: "porter", role: "embed" } }),
  });
}

export function issueEmbeddingText(title: string, body: string | null): string {
  return `${title}\n\n${(body ?? "").slice(0, 6000)}`;
}
