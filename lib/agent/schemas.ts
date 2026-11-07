import { z } from "zod";

export const KINDS = ["bug", "feature", "question", "docs", "other"] as const;

/** Lenient on purpose: missing arrays default, numeric strings coerce, unknown keys are dropped. */
export const TriageResult = z.object({
  summary: z.string(),
  kind: z.enum(KINDS),
  duplicates: z
    .array(z.object({ number: z.coerce.number().int().positive(), title: z.string(), why: z.string() }))
    .default([]),
  fixed_in: z.object({ version: z.string(), evidence_url: z.string() }).nullable().default(null),
  missing_info: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  repro: z
    .object({ snippet: z.string().nullable(), language: z.enum(["python", "other", "none"]) })
    .default({ snippet: null, language: "none" }),
});

export type TriageResult = z.infer<typeof TriageResult>;

/** Sent as response_format; strict mode wants every property required and no extra keys. */
export const TRIAGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "kind", "duplicates", "fixed_in", "missing_info", "labels", "repro"],
  properties: {
    summary: { type: "string" },
    kind: { type: "string", enum: [...KINDS] },
    duplicates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "title", "why"],
        properties: { number: { type: "integer" }, title: { type: "string" }, why: { type: "string" } },
      },
    },
    fixed_in: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["version", "evidence_url"],
          properties: { version: { type: "string" }, evidence_url: { type: "string" } },
        },
        { type: "null" },
      ],
    },
    missing_info: { type: "array", items: { type: "string" } },
    labels: { type: "array", items: { type: "string" } },
    repro: {
      type: "object",
      additionalProperties: false,
      required: ["snippet", "language"],
      properties: {
        snippet: { type: ["string", "null"] },
        language: { type: "string", enum: ["python", "other", "none"] },
      },
    },
  },
} as const;

export const ReviewResult = z.object({
  reply: z.string(),
  struck_claims: z.array(z.string()).default([]),
});

export type ReviewResult = z.infer<typeof ReviewResult>;

export const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "struck_claims"],
  properties: {
    reply: { type: "string" },
    struck_claims: { type: "array", items: { type: "string" } },
  },
} as const;

export function jsonSchemaFormat(name: string, schema: object) {
  return { type: "json_schema", json_schema: { name, schema, strict: true } };
}

const MAX_OBJECT_STARTS = 20;

/** End index (exclusive) of the balanced {...} starting at `start`, string-aware; -1 if unbalanced. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** The whole text as JSON, else the first balanced {...} that parses and passes `schema`. */
export function parseLenient<T>(schema: z.ZodType<T>, text: string): T | null {
  const whole = tryParse(schema, text.trim());
  if (whole !== null) return whole;
  let from = 0;
  for (let n = 0; n < MAX_OBJECT_STARTS; n++) {
    const start = text.indexOf("{", from);
    if (start === -1) return null;
    const end = objectEnd(text, start);
    if (end !== -1) {
      const hit = tryParse(schema, text.slice(start, end));
      if (hit !== null) return hit;
    }
    from = start + 1;
  }
  return null;
}

function tryParse<T>(schema: z.ZodType<T>, text: string): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
}
