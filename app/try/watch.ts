export type Watch = { kind: "run"; id: string } | { kind: "wave"; ids: string[] } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** ?run=<id> or ?wave=<id,id,…> reopens what this tab was watching. Anything malformed is ignored. */
export function watchFrom(q: { [k: string]: string | string[] | undefined }): Watch {
  const run = one(q.run);
  if (run && UUID_RE.test(run)) return { kind: "run", id: run.toLowerCase() };
  const wave = one(q.wave)
    ?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID_RE.test(s));
  if (wave && wave.length > 0 && wave.length <= 12) return { kind: "wave", ids: [...new Set(wave)] };
  return null;
}
