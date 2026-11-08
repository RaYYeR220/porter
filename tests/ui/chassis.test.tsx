// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const path = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current }));

import { Footer } from "../../components/site/Footer";
import { Nav } from "../../components/site/Nav";
import { REPO_URL, openIssueHref } from "../../components/site/links";

describe("site chassis", () => {
  afterEach(cleanup);

  it("links every section of the site, and GitHub", () => {
    path.current = "/";
    render(<Nav />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const href = (name: string) => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(href("Porter")).toBe("/");
    expect(href("How it works")).toBe("/#how");
    expect(href("Eval")).toBe("/eval");
    expect(href("Otari report")).toBe("/report/otari");
    expect(href("Try it")).toBe("/try");
    expect(href("Console")).toBe("/console");
    expect(href("GitHub")).toBe(REPO_URL);
  });

  it("marks the current page", () => {
    path.current = "/report/otari";
    render(<Nav />);
    expect(screen.getByRole("link", { name: "Otari report" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Eval" }).getAttribute("aria-current")).toBeNull();
  });

  it("repeats the links in the footer, with the licence", () => {
    render(<Footer />);
    const foot = screen.getByRole("navigation", { name: "Footer" });
    for (const name of ["Eval", "Otari report", "Try it", "Console", "GitHub", "MIT licence"]) {
      expect(within(foot).getByRole("link", { name })).toBeTruthy();
    }
  });
});

describe("openIssueHref", () => {
  it("opens a new issue on the demo repo when one is set", () => {
    expect(openIssueHref("RaYYeR220/porter-demo")).toBe("https://github.com/RaYYeR220/porter-demo/issues/new");
    expect(openIssueHref("  owner/repo.name ")).toBe("https://github.com/owner/repo.name/issues/new");
  });
  it("falls back to /try when unset or not an owner/repo name", () => {
    for (const v of [undefined, "", "   ", "porter", "a/b/c", "../evil", "https://evil.example/x"]) expect(openIssueHref(v)).toBe("/try");
  });
});
