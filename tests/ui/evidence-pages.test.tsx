// @vitest-environment jsdom
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import EvalPage from "../../app/eval/page";
import OtariReportPage from "../../app/report/otari/page";
import { REPO_URL } from "../../components/site/links";

const FIXTURES = join(__dirname, "..", "fixtures", "results");
const ALL = ["eval-porter-attacks", "eval-baseline-attacks", "eval-porter-benign", "eval-baseline-benign", "spam-porter", "spam-baseline", "shadow-otari"];

let dir: string;
const use = (...names: string[]) => {
  for (const n of names) copyFileSync(join(FIXTURES, `${n}.json`), join(dir, `${n}.json`));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "porter-pages-"));
  process.env.PORTER_RESULTS_DIR = dir;
});
afterEach(() => {
  cleanup();
  delete process.env.PORTER_RESULTS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const cell = (container: HTMLElement, row: string, arm: string) => container.querySelector<HTMLElement>(`tr[data-row="${row}"] td[data-arm="${arm}"]`)!;

describe("/eval before any run", () => {
  it("says it has not run, shows no figure, and still shows the method", () => {
    const { container } = render(<EvalPage />);
    expect(screen.getByText("Not run yet — the method below is fixed in advance.")).toBeTruthy();
    expect(container.querySelector(".fig")).toBeNull();
    for (const arm of ["baseline", "porter"]) expect(cell(container, "hijacked", arm).textContent).toBe("Not run yet");
    // layers are described even with nothing to count
    expect(screen.getByText("Read-only tools (ACL)")).toBeTruthy();
    const prereg = screen.getByRole("link", { name: "Read the pre-registration" });
    expect(prereg.getAttribute("href")).toBe(`${REPO_URL}/blob/devs-wilding/eval/PREREGISTRATION.md`);
    const method = container.querySelector(".mt")!.textContent!;
    expect(method).toContain("of the 574 snapshot issues: 98 were dropped for length, 0 for containing something shaped like a real secret, and 119");
    expect(method).toContain("19 general (bug 5, feature 5, docs 3, other 6) and 6");
    expect(method).toContain("No results committed yet.");
    expect(container.querySelector("[data-modeled]")).toBeNull();
  });
});

describe("/eval with results", () => {
  it("computes the sentence from both attack files", () => {
    use(...ALL);
    render(<EvalPage />);
    expect(
      screen.getByText("Porter: 1 of 25 attacks got the bot to act or try to (1 inconclusive); the same bot with prompt-only defences: 11 of 25."),
    ).toBeTruthy();
    expect(screen.queryByText(/Not run yet — the method/)).toBeNull();
  });

  it("shows inconclusive runs in the same cell as the count", () => {
    use(...ALL);
    const { container } = render(<EvalPage />);
    const porter = cell(container, "hijacked", "porter");
    expect(within(porter).getByText("1 of 25")).toBeTruthy();
    expect(within(porter).getByText("(1 inconclusive)")).toBeTruthy();
    const baseline = cell(container, "hijacked", "baseline");
    expect(within(baseline).getByText("11 of 25")).toBeTruthy();
    expect(baseline.textContent).not.toContain("inconclusive");
    expect(within(cell(container, "false", "porter")).getByText("2 of 25")).toBeTruthy();
  });

  it("places each attack at its layer and links each case to its run", () => {
    use(...ALL);
    const { container } = render(<EvalPage />);
    const acl = container.querySelector<HTMLElement>('tr[data-layer="acl"] td[data-arm="porter"]')!;
    expect(acl.textContent).toContain("2");
    expect(acl.textContent).toContain("1 counted as hijacked");
    const through = container.querySelector<HTMLElement>('tr[data-layer="not_stopped"] td[data-arm="baseline"]')!;
    expect(through.querySelector(".lay-n")!.textContent).toBe("7");
    const marks = container.querySelectorAll('tr[data-technique="indirect_link"] td[data-arm="porter"] .cm');
    expect(marks).toHaveLength(2);
    const i24 = container.querySelector<HTMLAnchorElement>('tr[data-technique="indirect_link"] td[data-arm="porter"] a.cm')!;
    expect(i24.getAttribute("href")).toMatch(/^\/console\/runs\/[0-9a-f-]{36}$/);
    expect(i24.getAttribute("data-tone")).toBe("steered");
    expect(container.querySelectorAll("tr[data-technique]")).toHaveLength(9);
  });

  it("labels the 100-issue spam figure as modeled, next to what was measured", () => {
    use(...ALL);
    const { container } = render(<EvalPage />);
    const waves = container.querySelectorAll<HTMLElement>("[data-modeled]");
    expect(waves).toHaveLength(2);
    for (const w of waves) {
      expect(within(w).getByText("modeled")).toBeTruthy();
      expect(w.textContent).toContain("Not a measurement.");
    }
    const porter = container.querySelector<HTMLElement>('.sw[data-arm="porter"]')!;
    expect(porter.textContent).toContain("Issue 10");
    expect(porter.querySelectorAll(".sw-cells a.sw-refused")).toHaveLength(11);
    expect(porter.querySelector('[data-legit="served"]')).toBeTruthy();
  });

  it("leaves the modeled line out when the file has no model", () => {
    use("spam-porter");
    const s = JSON.parse(readFileSync(join(dir, "spam-porter.json"), "utf8"));
    writeFileSync(join(dir, "spam-porter.json"), JSON.stringify({ ...s, modeled: null }));
    const { container } = render(<EvalPage />);
    expect(container.querySelector("[data-modeled]")).toBeNull();
    expect(container.querySelector('.sw[data-arm="baseline"]')!.textContent).toContain("Not run yet");
  });

  it("drops the sentence while one arm has not run", () => {
    use("eval-porter-attacks");
    const { container } = render(<EvalPage />);
    expect(screen.getByText("Not run yet — the method below is fixed in advance.")).toBeTruthy();
    expect(within(cell(container, "hijacked", "porter")).getByText("1 of 25")).toBeTruthy();
    expect(cell(container, "hijacked", "baseline").textContent).toBe("Not run yet");
  });

  it("shows a broken file as an error in its cell and keeps the page", () => {
    use("eval-baseline-attacks");
    writeFileSync(join(dir, "eval-porter-attacks.json"), "{");
    const { container } = render(<EvalPage />);
    expect(cell(container, "hijacked", "porter").textContent).toBe("Can’t read eval-porter-attacks.json: not valid JSON");
    expect(screen.getByText("Not run yet — the method below is fixed in advance.")).toBeTruthy();
  });

  it("links the raw files that exist", () => {
    use("eval-porter-attacks", "spam-baseline");
    render(<EvalPage />);
    const links = screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.includes("/results/"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      `${REPO_URL}/blob/devs-wilding/results/spam-baseline.json`,
      `${REPO_URL}/blob/devs-wilding/results/eval-porter-attacks.json`,
    ]);
  });
});

describe("/report/otari", () => {
  it("says it is read-only and not run yet", () => {
    const { container } = render(<OtariReportPage />);
    expect(screen.getByText("Read-only: nothing was posted to Otari’s tracker.")).toBeTruthy();
    expect(screen.getByText("Not run yet")).toBeTruthy();
    expect(container.querySelector(".sh-list")).toBeNull();
  });

  it("shows a broken file as such", () => {
    writeFileSync(join(dir, "shadow-otari.json"), "nope");
    render(<OtariReportPage />);
    expect(screen.getByText("The report file is there but can’t be shown")).toBeTruthy();
    expect(screen.getByText("Read-only: nothing was posted to Otari’s tracker.")).toBeTruthy();
  });

  it("lists every sampled issue with its claims and their verification state", () => {
    use("shadow-otari");
    const { container } = render(<OtariReportPage />);
    expect(screen.getByText("3 of 5 claims checked by hand: 67% correct")).toBeTruthy();
    expect(container.querySelectorAll(".sh-issue")).toHaveLength(8);

    const issue = container.querySelector<HTMLElement>('[data-issue="2998"]')!;
    expect(within(issue).getAllByRole("link", { name: "#2998" })[0].getAttribute("href")).toBe("https://github.com/mozilla-ai/otari/issues/2998");
    const claims = issue.querySelectorAll<HTMLElement>("[data-claim-kind]");
    expect([...claims].map((c) => c.querySelector(".vchip")?.getAttribute("data-claim"))).toEqual(["unchecked", "outside"]);
    expect(claims[0].textContent).toContain("unchecked");
    expect(claims[1].textContent).toContain("not in snapshot");
    expect(within(issue).getByRole("link", { name: "Run trace" }).getAttribute("href")).toMatch(/^\/console\/runs\//);

    const states = (n: number) => [...container.querySelectorAll(`[data-issue="${n}"] .vchip`)].map((c) => c.getAttribute("data-claim"));
    expect(states(3011)).toEqual(["correct"]);
    expect(states(2987)).toEqual(["wrong"]);
    expect(states(3006)).toEqual(["unchecked"]);
    expect(states(2979)).toEqual(["correct"]);
  });

  it("never states a claim without its verification chip, and gives no precision before any check", () => {
    use("shadow-otari");
    const f = JSON.parse(readFileSync(join(dir, "shadow-otari.json"), "utf8"));
    for (const i of f.issues) {
      for (const d of i.duplicates) d.verified = null;
      if (i.fixed_in) i.fixed_in.verified = null;
    }
    writeFileSync(join(dir, "shadow-otari.json"), JSON.stringify(f));
    const { container } = render(<OtariReportPage />);
    expect(screen.getByText("Claims not yet checked by hand")).toBeTruthy();
    expect(container.textContent).not.toMatch(/\d+% correct/);
    const claims = container.querySelectorAll<HTMLElement>("[data-claim-kind]");
    expect(claims.length).toBe(6);
    for (const c of claims) {
      const chip = c.querySelector(".vchip");
      expect(chip).toBeTruthy();
      expect(["unchecked", "outside"]).toContain(chip!.getAttribute("data-claim"));
    }
    expect(container.querySelector(".vchip-correct, .vchip-wrong")).toBeNull();
  });
});
