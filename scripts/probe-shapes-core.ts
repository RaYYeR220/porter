/** Helpers for scripts/probe-shapes.ts, kept free of env and network so they can be tested. */

export type Exchange = { method: string; path: string; model: string | null; status: number; body: string };

/** A fetch that records each exchange (method, path, model, status, response text) and returns the response untouched. */
export function recordingFetch(log: Exchange[], base: typeof fetch = (i, init) => fetch(i, init)): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    let model: string | null = null;
    if (typeof init?.body === "string") {
      try {
        const parsed: unknown = JSON.parse(init.body);
        const m = parsed && typeof parsed === "object" ? (parsed as { model?: unknown }).model : undefined;
        model = typeof m === "string" ? m : null;
      } catch {
        model = null;
      }
    }
    const res = await base(input, init);
    const body = await res.clone().text();
    log.push({ method: init?.method ?? "GET", path: url.pathname.replace(/^\/api\/v1/, "") + url.search, model, status: res.status, body });
    return res;
  }) as typeof fetch;
}

/** Env values that must never be printed: keys, tokens, secrets, passwords, connection strings. */
export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => !!v && v.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|POSTGRES_URL|PRIVATE|SALT/i.test(k))
    .map(([, v]) => v as string);
}

/** Drops every secret value and anything shaped like a key or bearer token, flattens whitespace, cuts to `max`. */
export function redact(text: string, secrets: string[], max = 240): string {
  let s = text;
  for (const v of secrets) s = s.split(v).join("[redacted]");
  s = s
    .replace(/otk_[A-Za-z0-9_-]{6,}/g, "otk_[redacted]")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * What a status means on an org with a $0 balance. Otari validates the request shape before it checks
 * funds, so a model route that answers 402 accepted the shape and spent nothing.
 */
export function verdict(status: number, body: string, kind: "model" | "api"): string {
  const code = /"code"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] ?? null;
  if (status === 402) return "shape accepted (stopped at funds)";
  if (status >= 200 && status < 300) return kind === "model" ? "SERVED: the balance is not zero" : "ok";
  if (status === 400 || status === 422) return "SHAPE REJECTED";
  if (status === 403 && code === "guardrail_violation") return "shape accepted (stopped at guardrail)";
  if (status === 403 && code === "budget_exceeded") return "shape accepted (stopped at budget)";
  // Checked after the tool declarations are validated: the shape passed, the workspace has web fetch off.
  if (status === 403 && /web access is not enabled/i.test(body)) return "shape accepted; workspace web access is OFF (dashboard)";
  if (status === 404) return "not found";
  return code ?? `status ${status}`;
}

/** One markdown table row; pipes in cells are escaped. */
export function row(cells: Array<string | number | null>): string {
  return `| ${cells.map((c) => String(c ?? "–").replace(/\|/g, "\\|")).join(" | ")} |`;
}

/**
 * Whether the model probes may run, from the embedding canary's statuses (empty when the call threw
 * before any response). Fails closed: only an exact 402 proves the org cannot pay, so anything else
 * (2xx, 429, 5xx, a timeout) skips the model probes unless the caller passed --allow-spend.
 */
export function canaryDecision(statuses: number[], allowSpend: boolean): { runModels: boolean; note: string | null } {
  if (allowSpend) return { runModels: true, note: null };
  const last = statuses.at(-1);
  if (last === 402) return { runModels: true, note: null };
  if (last !== undefined && last >= 200 && last < 300) {
    return { runModels: false, note: "the org has funds: skipping model probes (re-run with --allow-spend to send them)" };
  }
  return { runModels: false, note: `canary inconclusive (status ${last ?? "none"}), skipping model probes` };
}

/** List routes print counts, not bodies (they hold other end users' ids and meters). */
export function listSummary(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) return `${parsed.length} item${parsed.length === 1 ? "" : "s"} (body omitted)`;
  } catch {
    // not JSON: fall through
  }
  return "body omitted";
}
