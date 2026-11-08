import { formatWait } from "../../lib/agent/replies";

export const DASH = "—";

/** Dollars with up to four decimals, never fewer than two: $0.0004, $0.05, $1.20. */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  if (n === 0) return "$0";
  if (n > 0 && n < 0.0001) return "<$0.0001";
  const fixed = n.toFixed(4).replace(/(\.\d\d\d?)0+$/, "$1").replace(/(\.\d\d)0$/, "$1");
  return `$${fixed}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

const time = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  const t = time(iso);
  if (t === null) return DASH;
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "08 Nov, 14:02 UTC" for titles and headers. */
export function stamp(iso: string | null | undefined): string {
  const t = time(iso);
  if (t === null) return DASH;
  const d = new Date(t);
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${String(d.getUTCDate()).padStart(2, "0")} ${month}, ${hh}:${mm} UTC`;
}

/** When an end user's budget comes back: "resets in 3 h 12 min", or a dash when the gateway gave no time. */
export function resetText(iso: string | null | undefined, now: number = Date.now()): string {
  const t = time(iso);
  if (t === null) return DASH;
  const s = (t - now) / 1000;
  if (s <= 0) return "resets now";
  return `resets in ${formatWait(s)}`;
}

/** Mirrors the server's display names: `gh:octocat` → `octocat`, `web:ab12…` → `visitor ab12…`. */
export function authorName(externalId: string | null | undefined): string {
  if (!externalId) return DASH;
  if (externalId.startsWith("gh:")) return externalId.slice(3);
  if (externalId.startsWith("web:")) return `visitor ${externalId.slice(4, 8)}…`;
  return externalId;
}

export const shortId = (id: string) => id.slice(0, 8);
