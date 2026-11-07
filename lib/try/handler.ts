import type { IssueInput } from "../agent/pipeline";
import { fundsGate, type FundsDeps } from "../balance";
import { clientIp, errorJson, internalError, ipHash, Limiter, rateLimited, webUserId } from "../api/common";
import { isPreset, presetIssues, type PresetIssue } from "./presets";

export const TRY_PER_HOUR = 6;
export const MAX_TITLE = 200;
export const MAX_BODY = 20_000;
const MAX_RAW = 64 * 1024;

export type TryDeps = {
  demoRepo: string | null;
  /** The salt for today; throws when no secret is configured. */
  salt: () => string;
  limit: Limiter;
  funds: FundsDeps;
  /** Creates the run row and returns its id. */
  startRun: (input: IssueInput) => Promise<string>;
  /** The actual pipeline run for an already-started row. */
  runIssue: (input: IssueInput, runId: string) => Promise<unknown>;
  /** Runs work after the response (next/server `after`). */
  defer: (work: () => Promise<void>) => void;
};

/** Collapses all whitespace runs so a title is a single line. */
export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

type Parsed = { ok: true; issues: PresetIssue[] } | { ok: false; reason: string };

function parseBody(raw: unknown): Parsed {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "body must be a JSON object" };
  const o = raw as Record<string, unknown>;
  if (o.preset !== undefined && !isPreset(o.preset)) return { ok: false, reason: "unknown preset" };
  if (isPreset(o.preset)) return { ok: true, issues: presetIssues(o.preset) };
  if (typeof o.title !== "string") return { ok: false, reason: "title is required" };
  const title = collapse(o.title);
  if (title.length < 1 || title.length > MAX_TITLE) return { ok: false, reason: `title must be 1-${MAX_TITLE} characters` };
  if (o.body !== undefined && typeof o.body !== "string") return { ok: false, reason: "body must be a string" };
  const body = (o.body as string | undefined) ?? "";
  if (body.length > MAX_BODY) return { ok: false, reason: `body must be at most ${MAX_BODY} characters` };
  return { ok: true, issues: [{ title, body }] };
}

/** POST /api/try: a judge files a test issue with no credentials. Returns ids at once; work follows. */
export async function handleTry(req: Request, d: TryDeps): Promise<Response> {
  if (!d.demoRepo) return errorJson(503, "unavailable", "The demo repository is not configured yet.");

  let text: string;
  try {
    text = await req.text();
  } catch {
    return errorJson(400, "invalid_request", "unreadable body");
  }
  if (text.length > MAX_RAW) return errorJson(413, "payload_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return errorJson(400, "invalid_request", "invalid JSON");
  }
  const parsed = parseBody(raw);
  if (!parsed.ok) return errorJson(400, "invalid_request", parsed.reason);

  let hash: string;
  try {
    hash = ipHash(clientIp(req), d.salt());
  } catch {
    return errorJson(503, "unavailable", "not configured");
  }

  const gate = await fundsGate(d.funds);
  if (gate.paused) return errorJson(503, "paused", gate.reason);
  if (!(await d.limit(`rl:try:${hash.slice(0, 16)}`, TRY_PER_HOUR, 3600))) return rateLimited();

  const authorExternalId = webUserId(hash);
  const inputs: IssueInput[] = parsed.issues.map((i) => ({
    source: "web",
    arm: "porter",
    repo: d.demoRepo as string,
    number: null,
    title: i.title,
    body: i.body,
    authorExternalId,
  }));

  const runIds: string[] = [];
  try {
    for (const input of inputs) runIds.push(await d.startRun(input));
  } catch {
    return internalError();
  }

  // Sequential on purpose: for the spam wave, per-user budget refusals show up mid-wave.
  d.defer(async () => {
    for (let i = 0; i < inputs.length; i++) {
      try {
        await d.runIssue(inputs[i], runIds[i]);
      } catch (e) {
        console.warn(`porter try run failed: ${e instanceof Error ? e.name : "error"}`);
      }
    }
  });

  return Response.json(inputs.length > 1 ? { runIds } : { runId: runIds[0] }, { status: 202 });
}
