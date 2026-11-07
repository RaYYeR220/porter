import { createHash } from "node:crypto";

export type Limiter = (key: string, limit: number, windowSec: number) => Promise<boolean>;

export function errorJson(status: number, error: string, reason?: string, headers?: Record<string, string>): Response {
  return Response.json(reason ? { error, reason } : { error }, { status, headers });
}

export const rateLimited = () => errorJson(429, "rate_limited", undefined, { "Retry-After": "3600" });
export const internalError = () => errorJson(500, "internal");

const lastHop = (v: string | null) => v?.split(",").map((x) => x.trim()).filter(Boolean).pop() ?? null;

/**
 * Client address as our platform saw it: x-vercel-forwarded-for, then x-real-ip, then the LAST hop
 * of x-forwarded-for (the one the platform appended; earlier hops are client-controlled). With none
 * of them: null in production, a shared "dev" bucket locally. Never stored; only hashed.
 */
export function clientIp(req: Request, env: Record<string, string | undefined> = process.env): string | null {
  const ip =
    req.headers.get("x-vercel-forwarded-for")?.trim() || req.headers.get("x-real-ip")?.trim() || lastHop(req.headers.get("x-forwarded-for"));
  if (ip) return ip;
  return env.NODE_ENV === "production" || env.VERCEL === "1" ? null : "dev";
}

/** ip + daily salt → hash, or the error response to return (no address: 400; no secret: 503). */
export function requestHash(req: Request, salt: () => string): string | Response {
  const ip = clientIp(req);
  if (!ip) return errorJson(400, "no_client_ip");
  try {
    return ipHash(ip, salt());
  } catch {
    return errorJson(503, "unavailable", "not configured");
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Salt that rotates every UTC day: IP_SALT when set, else CRON_SECRET, plus the date.
 * Throws when neither exists: there is no constant fallback.
 */
export function dailySalt(env: Record<string, string | undefined> = process.env, now = new Date()): string {
  const secret = env.IP_SALT?.trim() || env.CRON_SECRET?.trim();
  if (!secret) throw new Error("Missing or invalid environment variables: IP_SALT or CRON_SECRET");
  return `${secret}:${now.toISOString().slice(0, 10)}`;
}

/** Hex digest of ip + daily salt. The raw address is never kept. */
export function ipHash(ip: string, salt: string): string {
  return sha256(`${ip}|${salt}`);
}

export const webUserId = (hash: string) => `web:${hash.slice(0, 16)}`;

/** Replaces any gateway key shape (and bearer tokens) left in the serialised body. */
export function redactSecrets<T>(value: T): T {
  const text = JSON.stringify(value)
    .replace(/otk_[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  return JSON.parse(text) as T;
}

/** Anchored on purpose: `tokens_in` and `keyword` are data, `access_token` and `apiKey` are not. */
const SECRET_KEY_RE = /^(authorization|cookie|set-cookie|password|passwd|.*api[_-]?key|.*secret|.*token)$/i;

/** Drops fields whose name looks credential-like, at any depth. */
export function stripSecretFields(v: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (Array.isArray(v)) return v.map((x) => stripSecretFields(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!SECRET_KEY_RE.test(k)) out[k] = stripSecretFields(val, depth + 1);
    }
    return out;
  }
  return v;
}

/** A safe JSON response: credential-named fields are dropped at any depth and key-shaped values redacted. */
export function safeJson(body: unknown, status = 200): Response {
  const plain = JSON.parse(JSON.stringify(body)) as unknown;
  return Response.json(redactSecrets(stripSecretFields(plain)), { status, headers: { "Cache-Control": "no-store" } });
}

/** Runs a route body; any thrown error becomes a plain JSON 500 (no message, no stack). */
export async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`porter api failed: ${e instanceof Error ? e.name : "error"}`);
    return errorJson(500, "internal");
  }
}
