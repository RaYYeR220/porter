import { describe, expect, it } from "vitest";
import { reproSystem } from "../../lib/agent/prompts";

describe("reproSystem", () => {
  it("tells the runner to install the repository itself from GitHub, not PyPI", () => {
    const s = reproSystem("RaYYeR220/porter-demo");
    expect(s).toContain('pip install -q "git+https://github.com/RaYYeR220/porter-demo"');
    expect(s).toContain("at most two code runs");
  });
});
