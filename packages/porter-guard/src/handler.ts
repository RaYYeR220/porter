import { createHash, timingSafeEqual } from "node:crypto";
import { classifyHarm, classifyInjection } from "./classifiers.ts";
import { decide } from "./ensemble.ts";
import { detectInjectionSignals, detectSecrets, stripRunMarker } from "./detectors.ts";
import { PROFILES } from "./protocol.ts";
import type { ChatFn, Decision, GuardLog, ModelVerdict, ProfileName, Signal, ValidateResponse } from "./protocol.ts";

export type GuardConfig = {
  token: string;
  chat: ChatFn;
  deadlineMs?: number;
  onVerdict?: (v: GuardLog) => Promise<void>;
};

const LOG_CAP_MS = 500;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function authorized(req: Request, token: string): boolean {
  if (!token) return false;
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

function isProfile(p: unknown): p is ProfileName {
  return PROFILES.some((x) => x.name === p);
}

export function createGuardHandler(cfg: GuardConfig) {
  const deadlineMs = cfg.deadlineMs ?? 20_000;

  async function evaluate(profile: ProfileName, text: string): Promise<{ decision: Decision; signals: Signal[]; verdicts: ModelVerdict[] }> {
    if (profile === "secrets") {
      const signals = detectSecrets(text);
      return { decision: decide(profile, signals, []), signals, verdicts: [] };
    }
    if (profile === "harm") {
      const verdicts = await classifyHarm(text, cfg.chat, deadlineMs);
      return { decision: decide(profile, [], verdicts), signals: [], verdicts };
    }
    const signals = detectInjectionSignals(text);
    const verdicts = await classifyInjection(text, cfg.chat, deadlineMs);
    return { decision: decide(profile, signals, verdicts), signals, verdicts };
  }

  return {
    async validate(req: Request): Promise<Response> {
      if (!authorized(req, cfg.token)) return json({ error: "unauthorized" }, 401);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const b = body as { profile?: unknown; input_text?: unknown } | null;
      if (!b || typeof b !== "object" || typeof b.input_text !== "string") return json({ error: "input_text_required" }, 400);
      if (!isProfile(b.profile)) return json({ error: "unknown_profile" }, 400);
      const profile = b.profile;

      const t0 = Date.now();
      const text = stripRunMarker(b.input_text);
      let out: { decision: Decision; signals: Signal[]; verdicts: ModelVerdict[] };
      try {
        out = await evaluate(profile, text);
      } catch {
        const fail: Decision =
          profile === "harm"
            ? { valid: true, score: 0, explanation: "classifier_unavailable (harm profile fails open)" }
            : { valid: false, score: 0.5, explanation: "classifier_unavailable" };
        out = { decision: fail, signals: [], verdicts: [] };
      }

      if (cfg.onVerdict) {
        const log: GuardLog = {
          inputSha256: createHash("sha256").update(b.input_text).digest("hex"),
          profile,
          valid: out.decision.valid,
          score: out.decision.score,
          explanation: out.decision.explanation,
          signals: out.signals,
          modelVerdicts: out.verdicts,
          latencyMs: Date.now() - t0,
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([cfg.onVerdict(log), new Promise((r) => (timer = setTimeout(r, LOG_CAP_MS)))]);
        } catch {
          // logging must never change the verdict
        } finally {
          clearTimeout(timer);
        }
      }

      const res: ValidateResponse = {
        profile,
        result: { valid: out.decision.valid === true, explanation: out.decision.explanation, score: out.decision.score },
      };
      return json(res);
    },

    async profiles(req: Request): Promise<Response> {
      if (!authorized(req, cfg.token)) return json({ error: "unauthorized" }, 401);
      return json({ profiles: PROFILES });
    },
  };
}
