import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { applyBlock, END, loadResults, renderBlock, START } from "../../scripts/render-results";

const ROOT = join(__dirname, "../..");
const DOCS = ["README.md", "JUDGES.md", "CHALLENGE_CHECKLIST.md", "CLAIMS.md", "docs/architecture.md", "packages/porter-guard/README.md"];
const read = (file: string) => readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");

/** Prose only: fenced code blocks removed, so code samples are not read as links or tables. */
const prose = (md: string) => md.replace(/^```[\s\S]*?^```/gm, "");

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
function anchors(md: string): Set<string> {
  const out = new Set<string>();
  for (const m of prose(md).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const text = m[1].replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    out.add(text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-"));
  }
  return out;
}

function links(md: string): string[] {
  return [...prose(md).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

/** Repository paths named in inline code, e.g. `lib/agent/pipeline.ts`. Results files are written by runs, so they are left out. */
function codePaths(md: string): string[] {
  const re = /`((?:lib|app|packages|eval|scripts|tests|components|docs|drizzle)\/[A-Za-z0-9_.\-/[\]]+)`/g;
  return [...prose(md).matchAll(re)].map((m) => m[1]).filter((p) => !p.includes("<"));
}

/**
 * The results files git tracks, copied to a temp folder. A run in progress writes untracked files into
 * results/; the README is rendered from what is committed, so those are left out. Without git, results/ as is.
 */
function committedResultsDir(): string {
  let tracked: string[];
  try {
    tracked = execFileSync("git", ["ls-files", "results"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return join(ROOT, "results");
  }
  const dir = mkdtempSync(join(tmpdir(), "porter-committed-results-"));
  for (const file of tracked) copyFileSync(join(ROOT, file), join(dir, basename(file)));
  return dir;
}

/** Cells per table row, ignoring escaped pipes: GitHub splits cells on every other pipe, even inside code. */
const cells = (line: string) => line.replace(/\\\|/g, "").split("|").length - 2;

describe("docs: the README results block", () => {
  const readme = read("README.md");

  it("keeps the markers once each, in order, under the Results heading", () => {
    expect(readme.split(START)).toHaveLength(2);
    expect(readme.split(END)).toHaveLength(2);
    const results = readme.indexOf("\n## Results\n");
    const start = readme.indexOf(START);
    const end = readme.indexOf(END);
    expect(results).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(results);
    expect(end).toBeGreaterThan(start);
    const next = readme.indexOf("\n## ", results + 1);
    expect(next === -1 || next > end).toBe(true);
  });

  it("is exactly what pnpm eval:render writes from the committed results", () => {
    expect(applyBlock(readme, renderBlock(loadResults(committedResultsDir())))).toBe(readme);
  });

  it("renders cleanly with no results at all and changes nothing outside the markers", () => {
    const block = renderBlock(loadResults(mkdtempSync(join(tmpdir(), "porter-docs-"))));
    expect(block.match(/Not run yet\./g)).toHaveLength(6);
    const out = applyBlock(readme, block);
    expect(out.slice(0, out.indexOf(START))).toBe(readme.slice(0, readme.indexOf(START)));
    expect(out.slice(out.indexOf(END))).toBe(readme.slice(readme.indexOf(END)));
  });

  it("types no number by hand anywhere else in the Results section", () => {
    const results = readme.indexOf("\n## Results\n");
    const next = readme.indexOf("\n## ", results + 1);
    const section = readme.slice(results, next === -1 ? undefined : next);
    const outside = section.slice(0, section.indexOf(START)) + section.slice(section.indexOf(END) + END.length);
    expect(outside).not.toMatch(/\d/);
  });
});

describe("docs: links and paths", () => {
  for (const file of DOCS) {
    const md = read(file);

    it(`${file}: relative links point at files that exist, anchors at headings that exist`, () => {
      for (const target of links(md)) {
        if (/^[a-z]+:/i.test(target)) continue;
        const [path, hash] = target.split("#");
        const resolved = path === "" ? join(ROOT, file) : join(ROOT, dirname(file), decodeURIComponent(path));
        expect(existsSync(resolved), `${file} → ${target}`).toBe(true);
        if (hash) {
          const doc = readFileSync(resolved, "utf8").replace(/\r\n/g, "\n");
          expect(anchors(doc).has(hash), `${file} → ${target} (anchor)`).toBe(true);
        }
      }
    });

    it(`${file}: external links are well-formed https URLs`, () => {
      for (const target of links(md).filter((t) => /^[a-z]+:/i.test(t))) {
        const url = new URL(target);
        expect(url.protocol, target).toBe("https:");
        expect(url.hostname, target).toMatch(/\./);
      }
    });

    it(`${file}: every repository path in inline code exists`, () => {
      for (const p of codePaths(md)) {
        expect(existsSync(join(ROOT, dirname(file), p)) || existsSync(join(ROOT, p)), `${file}: ${p}`).toBe(true);
      }
    });

    it(`${file}: every table row has as many cells as its header`, () => {
      const lines = prose(md).split("\n");
      let header: number | null = null;
      for (const [i, line] of lines.entries()) {
        if (!line.startsWith("|")) {
          header = null;
          continue;
        }
        const n = cells(line);
        if (header === null) header = n;
        expect(n, `${relative(ROOT, join(ROOT, file))}:${i + 1}`).toBe(header);
      }
    });
  }

  it("the README draws the same diagram as docs/architecture.md", () => {
    const diagram = (md: string) => md.match(/```mermaid\n([\s\S]*?)```/)?.[1];
    expect(diagram(read("README.md"))).toBeTruthy();
    expect(diagram(read("README.md"))).toBe(diagram(read("docs/architecture.md")));
  });
});
