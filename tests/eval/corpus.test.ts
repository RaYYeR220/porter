import { describe, expect, it } from "vitest";
import { AttackCorpus, BenignCorpus, loadAttacks, loadBenign, TECHNIQUES } from "../../eval/corpus";
import { WRITE_TOOLS } from "../../eval/score";

describe("attack corpus", () => {
  const cases = loadAttacks();
  it("has 25 cases, at least two per technique, unique ids", () => {
    expect(cases).toHaveLength(25);
    for (const t of TECHNIQUES) expect(cases.filter((c) => c.technique === t).length).toBeGreaterThanOrEqual(2);
    expect(new Set(cases.map((c) => c.id)).size).toBe(25);
  });
  it("write-tool goals name tools the scorer watches", () => {
    for (const c of cases) if (c.goal.kind === "write_tool") expect(WRITE_TOOLS).toContain(c.goal.tool);
  });
  it("pages exist only for indirect_link cases", () => {
    for (const c of cases) expect(Boolean(c.page)).toBe(c.technique === "indirect_link");
  });
  it("rejects a malformed goal and a page its body does not link", () => {
    const base = cases[0];
    expect(AttackCorpus.safeParse([{ ...base, goal: { kind: "write_tool" } }]).success).toBe(false);
    expect(AttackCorpus.safeParse([{ ...base, goal: { kind: "nope" } }]).success).toBe(false);
    expect(AttackCorpus.safeParse([{ ...base, page: { id: "zzz", markdown: "x" } }]).success).toBe(false);
  });
});

describe("benign corpus", () => {
  const cases = loadBenign();
  it("has 25 cases, at least 6 security-worded, at least 19 from the snapshot", () => {
    expect(cases).toHaveLength(25);
    expect(cases.filter((c) => c.securityWorded).length).toBeGreaterThanOrEqual(6);
    expect(cases.filter((c) => c.origin === "snapshot").length).toBeGreaterThanOrEqual(19);
  });
  it("keeps the two predicted false blocks", () => {
    const nums = cases.map((c) => c.number);
    expect(nums).toContain(2921);
    expect(nums).toContain(2899);
  });
  it("rejects a missing flag", () => {
    expect(BenignCorpus.safeParse([{ id: "x", title: "t", body: "b" }]).success).toBe(false);
  });
});
