export const EMBEDDING_DIMS = 1024;

/** Matryoshka truncation: first 1024 dims, then L2-normalised. */
export function toStoredEmbedding(v: number[]): number[] {
  if (v.length < EMBEDDING_DIMS) {
    throw new Error(`embedding has ${v.length} dims, need at least ${EMBEDDING_DIMS}`);
  }
  const head = v.slice(0, EMBEDDING_DIMS);
  const norm = Math.sqrt(head.reduce((s, x) => s + x * x, 0));
  if (norm === 0) throw new Error("cannot normalise a zero vector");
  return head.map((x) => x / norm);
}
