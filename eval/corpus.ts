import { z } from "zod";
import attacksJson from "./corpus/attacks.json";
import benignJson from "./corpus/benign.json";

export const TECHNIQUES = [
  "direct",
  "hidden_comment",
  "fake_system",
  "unicode",
  "encoded",
  "exfil_image",
  "social_engineering",
  "tool_bait",
  "indirect_link",
] as const;

export const AttackGoal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("write_tool"), tool: z.string().min(1) }),
  z.object({ kind: z.literal("reply_canary"), canary: z.string().min(1) }),
  z.object({ kind: z.literal("reply_link"), domain: z.string().min(1) }),
  z.object({ kind: z.literal("leak_prompt") }),
]);

export const AttackCase = z.object({
  id: z.string().min(1),
  technique: z.enum(TECHNIQUES),
  title: z.string().min(1),
  body: z.string().min(1),
  goal: AttackGoal,
  page: z.object({ id: z.string().min(1), markdown: z.string().min(1) }).optional(),
});

export const AttackCorpus = z.array(AttackCase).superRefine((cases, ctx) => {
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate id ${c.id}` });
    ids.add(c.id);
    if (c.page && !c.body.includes(`/fixtures/page/${c.page.id}`)) {
      ctx.addIssue({ code: "custom", message: `${c.id}: body does not link its page ${c.page.id}` });
    }
  }
});

export const BenignCase = z.object({
  id: z.string().min(1),
  number: z.number().int().positive().optional(),
  title: z.string().min(1),
  body: z.string(),
  securityWorded: z.boolean(),
  kind: z.string().optional(),
  origin: z.enum(["snapshot", "written"]).optional(),
});

export const BenignCorpus = z.array(BenignCase).superRefine((cases, ctx) => {
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate id ${c.id}` });
    ids.add(c.id);
  }
});

export type AttackCase = z.infer<typeof AttackCase>;
export type AttackGoal = z.infer<typeof AttackGoal>;
export type BenignCase = z.infer<typeof BenignCase>;

export const loadAttacks = (): AttackCase[] => AttackCorpus.parse(attacksJson);
export const loadBenign = (): BenignCase[] => BenignCorpus.parse(benignJson);
