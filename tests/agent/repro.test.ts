import { describe, expect, it } from "vitest";
import { reproSystem } from "../../lib/agent/prompts";
import { extractRepro, ranSnippet, type ReproResult } from "../../lib/agent/repro";

const verified = (r: ReproResult) => r.attempted && r.verified;

describe("reproSystem", () => {
  it("tells the runner to install the repository itself from GitHub, not PyPI", () => {
    const s = reproSystem("RaYYeR220/porter-demo");
    expect(s).toContain('pip install -q "git+https://github.com/RaYYeR220/porter-demo"');
    expect(s).toContain("at most two code runs");
  });
});

const SNIPPET = 'from tidetime import parse_duration\n\nprint(parse_duration("P2W"))  # ValueError';
const exec = (code: string, exit_code: number | undefined = 0) => ({ type: "code_execution", code, stdout: "", stderr: "", exit_code });
const resp = (calls: unknown[]) => ({ choices: [{ message: { content: "ran it" } }], otari_tool_calls: calls }) as never;

describe("ranSnippet", () => {
  it("accepts code that runs the reporter's imports", () => {
    expect(ranSnippet(['!pip install -q "git+https://github.com/o/r"', SNIPPET], SNIPPET)).toBe(true);
  });
  it("accepts the imports and the calls split across two runs, with spacing changes", () => {
    expect(ranSnippet(["from   tidetime import parse_duration", 'print(parse_duration("P2W"))'], SNIPPET)).toBe(true);
  });
  it("rejects a run that re-implements the library instead of importing it", () => {
    const sim = 'def parse_duration(s):\n    raise ValueError(s)\nprint(parse_duration("P2W"))';
    expect(ranSnippet([sim], SNIPPET)).toBe(false);
  });
  it("uses the first statements when the snippet has no imports", () => {
    const s = "# setup\nx = [1, 2]\nprint(x[5])";
    expect(ranSnippet(["x = [1, 2]\nprint(x[5])"], s)).toBe(true);
    expect(ranSnippet(["print('hello')"], s)).toBe(false);
  });
});

describe("extractRepro", () => {
  it("is verified only when a run with an exit code executed the snippet", () => {
    expect(verified(extractRepro(resp([exec(SNIPPET, 1)]), SNIPPET))).toBe(true);
    const sim = 'def parse_duration(s):\n    raise ValueError(s)\nprint(parse_duration("P2W"))';
    expect(verified(extractRepro(resp([exec(sim, 0)]), SNIPPET))).toBe(false);
    expect(verified(extractRepro(resp([{ type: "code_execution", code: SNIPPET, status: "failed" }]), SNIPPET))).toBe(false);
  });
});
