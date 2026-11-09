import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyBlock, END, loadResults, renderBlock, START } from "../../scripts/render-results";
import { POST_HOC_TITLE } from "../../lib/site/post-hoc";
import { buildEvalFile } from "../../eval/harness";
import type { EvalRow } from "../../eval/harness";

const row = (id: string, over: Partial<EvalRow> = {}): EvalRow => ({
  id, set: "attacks", arm: "porter", status: "answered", hijacked: false, falseBlock: false, blocked_at: "model_refused",
  inconclusive: false, reason: "", cost_usd: 0.01, latency_ms: 10, run_id: "r", ...over,
});

describe("applyBlock", () => {
  it("replaces only what is between the markers", () => {
    const readme = `# Porter\n\nintro\n\n## Results\n\n${START}\nold\n${END}\n\n## Other\n\ntext\n`;
    const out = applyBlock(readme, "NEW");
    expect(out).toBe(`# Porter\n\nintro\n\n## Results\n\n${START}\nNEW\n${END}\n\n## Other\n\ntext\n`);
    expect(applyBlock(out, "NEW")).toBe(out);
  });
  it("adds a minimal Results section when the markers are missing, leaving the rest alone", () => {
    const readme = "# Porter\n\nOne line.\n";
    const out = applyBlock(readme, "B");
    expect(out.startsWith("# Porter\n\nOne line.\n")).toBe(true);
    expect(out).toContain(`## Results\n\n${START}\nB\n${END}`);
  });
  it("puts the markers under an existing Results heading", () => {
    const out = applyBlock("# P\n\n## Results\n\nhand-written\n", "B");
    expect(out).toBe(`# P\n\n## Results\n\n${START}\nB\n${END}\n\nhand-written\n`);
  });
  it("keeps CRLF line endings", () => {
    const out = applyBlock(`a\r\n${START}\r\nold\r\n${END}\r\nb\r\n`, "x\ny");
    expect(out).toBe(`a\r\n${START}\r\nx\r\ny\r\n${END}\r\nb\r\n`);
  });
});

describe("renderBlock", () => {
  it("says Not run yet. when no results exist, and invents nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "porter-res-"));
    const block = renderBlock(loadResults(dir));
    // six cells in the pre-registered tables; the post-hoc block below has its own
    expect(block.slice(0, block.indexOf(`### ${POST_HOC_TITLE}`)).match(/Not run yet\./g)).toHaveLength(6);
    expect(block).not.toMatch(/\d+\/\d+/);
    expect(block).toContain("`results/eval-porter-attacks.json`");
    expect(block).toContain("`results/spam-baseline.json`");
  });

  it("shows inconclusive runs in the same cell as the headline count", () => {
    const dir = mkdtempSync(join(tmpdir(), "porter-res-"));
    const rows = [row("a", { hijacked: true, blocked_at: null }), row("b", { status: "refused_budget", inconclusive: true, blocked_at: null }), row("c")];
    writeFileSync(join(dir, "eval-porter-attacks.json"), JSON.stringify(buildEvalFile("porter", "attacks", rows, null)));
    writeFileSync(join(dir, "eval-porter-benign.json"), JSON.stringify(buildEvalFile("porter", "benign", [row("x", { set: "benign", inconclusive: true, blocked_at: null })], null)));
    const block = renderBlock(loadResults(dir));
    expect(block).toContain("| Porter | 1/3 (1 inconclusive) |");
    expect(block).toContain("| Porter | 0/1 (1 inconclusive) |");
  });

  it("renders measured numbers and sources from the files", () => {
    const dir = mkdtempSync(join(tmpdir(), "porter-res-"));
    mkdirSync(dir, { recursive: true });
    const rows = [
      row("a", { hijacked: true, blocked_at: null }),
      row("b", { hijacked: true, blocked_at: "acl" }),
      row("c", { status: "held_guardrail", blocked_at: "gateway_guardrail" }),
      row("d"),
    ];
    writeFileSync(join(dir, "eval-porter-attacks.json"), JSON.stringify(buildEvalFile("porter", "attacks", rows, null)));
    writeFileSync(
      join(dir, "eval-porter-benign.json"),
      JSON.stringify(buildEvalFile("porter", "benign", [row("x", { set: "benign", falseBlock: true, blocked_at: "output_check" }), row("y", { set: "benign" })], null)),
    );
    writeFileSync(
      join(dir, "spam-porter.json"),
      JSON.stringify({
        arm: "porter", n: 20, issues: [{ index: 1, status: "answered", cost_usd: 0.01, cumulative_usd: 0.01, run_id: "r" }],
        total_cost_usd: 0.02, first_refusal_index: 5, legit: { status: "answered", served: true, cost_usd: 0.01, run_id: "r" },
        stopped: null, modeled: { modeled: true, n: 100, cost_usd: 0.06, formula: "F" },
      }),
    );
    const block = renderBlock(loadResults(dir));
    expect(block).toContain("| Porter | 2/4 |");
    expect(buildEvalFile("porter", "attacks", [row("q", { inconclusive: true, blocked_at: null }), row("r")], null).totals).toMatchObject({ cases: 2, conclusive: 1, inconclusive: 1 });
    expect(block).toContain("| Porter | 1/2 |");
    expect(block).toContain("issue 5");
    expect(block).toContain("$0.0600 (modeled)");
    expect(block).toContain("- Porter: F");
    expect(block).toContain("| Baseline | Not run yet. |");
  });
});
