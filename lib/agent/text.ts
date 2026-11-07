/** Cuts at `max` UTF-16 units without leaving half a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Postgres text and jsonb reject NUL and lone surrogates; tool output and form input can carry both. */
export function pgText(s: string): string {
  return s.toWellFormed().replaceAll("\u0000", "");
}

export function pgJson(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return pgText(v);
  if (v === null || typeof v !== "object" || depth > 20) return v;
  if (Array.isArray(v)) return v.map((x) => pgJson(x, depth + 1));
  if (v instanceof Date) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [pgText(k), pgJson(x, depth + 1)]));
}
