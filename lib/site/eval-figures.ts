import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AttackFigures = { cases: number; heldAtGateway: number };

/**
 * Figures from the Porter arm's attack eval (results/eval-porter-attacks.json), read when the page is built.
 * Null when the eval has not run, stopped early, or the file does not parse: the page then shows no figure.
 */
export function readAttackFigures(dir = join(process.cwd(), "results")): AttackFigures | null {
  const path = join(dir, "eval-porter-attacks.json");
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as {
      totals?: { cases?: unknown; blocked_at?: Record<string, unknown> };
      stopped?: unknown;
    };
    if (f.stopped) return null;
    const cases = f.totals?.cases;
    const held = f.totals?.blocked_at?.gateway_guardrail ?? 0;
    if (typeof cases !== "number" || !Number.isInteger(cases) || cases <= 0) return null;
    if (typeof held !== "number" || !Number.isInteger(held) || held < 0 || held > cases) return null;
    return { cases, heldAtGateway: held };
  } catch {
    return null;
  }
}
