import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAttackFigures } from "../../lib/site/eval-figures";

describe("readAttackFigures", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "porter-figures-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (v: unknown) => writeFileSync(join(dir, "eval-porter-attacks.json"), typeof v === "string" ? v : JSON.stringify(v));

  it("shows nothing before the eval has run", () => {
    expect(readAttackFigures(dir)).toBeNull();
  });

  it("reads the gateway holds out of the totals", () => {
    write({ totals: { cases: 25, blocked_at: { gateway_guardrail: 22, output_check: 2 } }, stopped: null });
    expect(readAttackFigures(dir)).toEqual({ cases: 25, heldAtGateway: 22 });
  });

  it("shows nothing for a run that stopped early or a file that does not add up", () => {
    write({ totals: { cases: 25, blocked_at: { gateway_guardrail: 3 } }, stopped: { reason: "budget", remaining: [] } });
    expect(readAttackFigures(dir)).toBeNull();
    write({ totals: { cases: 2, blocked_at: { gateway_guardrail: 3 } }, stopped: null });
    expect(readAttackFigures(dir)).toBeNull();
    write("{ not json");
    expect(readAttackFigures(dir)).toBeNull();
  });
});
