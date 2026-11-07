import { describe, expect, it } from "vitest";
import { buildTools, type RepoStore, type ToolDeps } from "../../lib/mcp/tools";
import type { GitHubWriter } from "../../lib/mcp/github-write";
import { POST } from "../../app/api/mcp/[transport]/route";

type Issue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string | null;
  labels: string[];
  embedding: number[] | null;
  createdAt: Date | null;
  closedAt: Date | null;
};

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

function makeStore() {
  const repos = new Map([
    ["acme/widget", { id: 1, fullName: "acme/widget", kind: "demo" as const, installationId: "99" }],
    ["acme/shadowed", { id: 2, fullName: "acme/shadowed", kind: "shadow" as const, installationId: "98" }],
    ["acme/noinst", { id: 3, fullName: "acme/noinst", kind: "demo" as const, installationId: null }],
  ]);
  const issues: Issue[] = [
    { number: 1, title: "Streaming drops after retry", body: "SSE stream stops when the request is retried", state: "open", author: "a", labels: ["bug"], embedding: [1, 0], createdAt: null, closedAt: null },
    { number: 2, title: "Docs typo in readme", body: "spelling", state: "open", author: "b", labels: [], embedding: [0, 1], createdAt: null, closedAt: null },
    { number: 3, title: "Misc", body: "no vector yet", state: "closed", author: "c", labels: [], embedding: null, createdAt: null, closedAt: null },
  ];
  const files = [
    { path: "README.md", content: Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") },
    { path: "src/a.ts", content: "const needle = 1;\nconst x = 2;\n// Needle again\n" },
  ];
  const store: RepoStore = {
    async getRepo(name) {
      return repos.get(name) ?? null;
    },
    async issuesForSearch(_id, q) {
      return issues.map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
        cosine: q && i.embedding ? dot(q, i.embedding) : null,
      }));
    },
    async getIssue(_id, n) {
      return issues.find((i) => i.number === n) ?? null;
    },
    async getFile(_id, path) {
      return files.find((f) => f.path === path) ?? null;
    },
    async filesContaining(_id, pat) {
      return files.filter((f) => f.content.toLowerCase().includes(pat.toLowerCase()));
    },
    async listReleases(_id, limit) {
      return [{ tag: "v1", name: "One", body: "b", publishedAt: new Date("2026-01-01") }].slice(0, limit);
    },
  };
  return store;
}

function deps(over: Partial<ToolDeps> = {}) {
  const calls: unknown[][] = [];
  const writer: GitHubWriter = {
    async addLabels(...a) {
      calls.push(["addLabels", ...a]);
    },
    async postComment(...a) {
      calls.push(["postComment", ...a]);
    },
    async closeAsDuplicate(...a) {
      calls.push(["closeAsDuplicate", ...a]);
    },
  };
  const d: ToolDeps = { store: makeStore(), embedQuery: async () => [1, 0], writer, ...over };
  return { tools: buildTools(d), calls };
}
type Res = { isError?: boolean; content: Array<{ text: string }> };
const text = (r: Res) => r.content[0].text;
const parse = (r: Res) => JSON.parse(text(r));
const find = (d: ReturnType<typeof deps>, n: string) => d.tools.find((t) => t.name === n)!;

describe("tool catalogue", () => {
  it("exposes exactly the eight tools with correct annotations", () => {
    const { tools } = deps();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_labels", "close_as_duplicate", "find_in_repo", "get_issue", "list_releases", "post_comment", "read_file", "search_issues",
    ]);
    for (const t of tools) {
      const write = ["add_labels", "post_comment", "close_as_duplicate"].includes(t.name);
      expect(t.annotations.readOnlyHint).toBe(!write);
      expect(["web_search", "web_fetch", "code_execution"]).not.toContain(t.name);
    }
    expect(find(deps(), "close_as_duplicate").annotations.destructiveHint).toBe(true);
    expect(find(deps(), "add_labels").annotations.destructiveHint).toBe(false);
  });
});

describe("search_issues", () => {
  it("ranks the semantically closest issue first", async () => {
    const out = parse(await find(deps(), "search_issues").run({ repo: "acme/widget", query: "something unrelated", limit: 8 }));
    expect(out.ranking).toBe("semantic+keyword");
    expect(out.results[0].number).toBe(1);
    expect(out.results[0]).toMatchObject({ state: "open", url: "https://github.com/acme/widget/issues/1" });
    expect(out.results).toHaveLength(3);
  });

  it("falls back to keyword ranking when the embedder fails", async () => {
    const out = parse(await find(deps({ embedQuery: async () => null }), "search_issues").run({ repo: "acme/widget", query: "typo readme" }));
    expect(out.ranking).toBe("keyword");
    expect(out.results[0].number).toBe(2);
  });

  it("falls back to keyword ranking when no row has an embedding", async () => {
    const noVec: RepoStore = {
      ...makeStore(),
      issuesForSearch: async () => [{ number: 3, title: "Misc retry", body: null, state: "open", cosine: null }],
    };
    const out = parse(await find(deps({ store: noVec }), "search_issues").run({ repo: "acme/widget", query: "retry" }));
    expect(out.ranking).toBe("keyword");
    expect(out.results[0].number).toBe(3);
  });

  it("declares limit max 8 in the schema", () => {
    const schema = find(deps(), "search_issues").schema.limit as unknown as { safeParse(v: unknown): { success: boolean } };
    expect(schema.safeParse(9).success).toBe(false);
    expect(schema.safeParse(8).success).toBe(true);
  });
});

describe("read-only tools", () => {
  it("rejects repos outside the allowlist", async () => {
    const r = await find(deps(), "read_file").run({ repo: "evil/other", path: "README.md" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("repo_not_allowed");
  });

  it("refuses path traversal", async () => {
    for (const p of ["../secret", "src/../../x", "/etc/passwd", "a\\..\\b", "a\0b"]) {
      const r = await find(deps(), "read_file").run({ repo: "acme/widget", path: p });
      expect(r.isError, p).toBe(true);
    }
  });

  it("reads a file slice of at most 300 lines", async () => {
    const out = parse(await find(deps(), "read_file").run({ repo: "acme/widget", path: "README.md" }));
    expect(out).toMatchObject({ start_line: 1, end_line: 300, total_lines: 500 });
    const out2 = parse(await find(deps(), "read_file").run({ repo: "acme/widget", path: "README.md", start_line: 10, end_line: 12 }));
    expect(out2.content).toBe("line 10\nline 11\nline 12");
    const out3 = parse(await find(deps(), "read_file").run({ repo: "acme/widget", path: "README.md", start_line: 1, end_line: 500 }));
    expect(out3.end_line).toBe(300);
  });

  it("find_in_repo does a literal case-insensitive search", async () => {
    const out = parse(await find(deps(), "find_in_repo").run({ repo: "acme/widget", pattern: "needle" }));
    expect(out.hits.map((h: { line: number }) => h.line)).toEqual([1, 3]);
    const regexy = parse(await find(deps(), "find_in_repo").run({ repo: "acme/widget", pattern: "n.*e" }));
    expect(regexy.hits).toHaveLength(0);
  });

  it("get_issue and list_releases return data", async () => {
    const i = parse(await find(deps(), "get_issue").run({ repo: "acme/widget", number: 1 }));
    expect(i).toMatchObject({ number: 1, title: "Streaming drops after retry", labels: ["bug"] });
    const miss = await find(deps(), "get_issue").run({ repo: "acme/widget", number: 404 });
    expect(miss.isError).toBe(true);
    const rel = parse(await find(deps(), "list_releases").run({ repo: "acme/widget" }));
    expect(rel.releases[0].tag).toBe("v1");
  });
});

describe("write tools", () => {
  it("works on a demo repo with an installation", async () => {
    const d = deps();
    const r = await find(d, "add_labels").run({ repo: "acme/widget", issue_number: 1, labels: ["bug"] });
    expect(r.isError).toBeFalsy();
    await find(d, "post_comment").run({ repo: "acme/widget", issue_number: 1, body: "hi" });
    await find(d, "close_as_duplicate").run({ repo: "acme/widget", issue_number: 2, duplicate_of: 1 });
    expect(d.calls.map((c) => c[0])).toEqual(["addLabels", "postComment", "closeAsDuplicate"]);
  });

  it("returns write_not_allowed for shadow repos and repos without installation", async () => {
    const d = deps();
    for (const repo of ["acme/shadowed", "acme/noinst"]) {
      const r = await find(d, "add_labels").run({ repo, issue_number: 1, labels: ["bug"] });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("write_not_allowed");
    }
    expect(d.calls).toHaveLength(0);
  });

  it("rejects self-duplicates", async () => {
    const r = await find(deps(), "close_as_duplicate").run({ repo: "acme/widget", issue_number: 1, duplicate_of: 1 });
    expect(r.isError).toBe(true);
  });
});

describe("MCP route auth", () => {
  it("returns 401 without a bearer token", async () => {
    process.env.MCP_TOKEN = "test-token";
    const res = await POST(new Request("http://localhost/api/mcp/mcp", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
  it("returns 401 with a wrong bearer token", async () => {
    process.env.MCP_TOKEN = "test-token";
    const res = await POST(
      new Request("http://localhost/api/mcp/mcp", { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" }),
    );
    expect(res.status).toBe(401);
  });
});
