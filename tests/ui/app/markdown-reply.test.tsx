// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownReply } from "../../../components/app/MarkdownReply";

describe("MarkdownReply", () => {
  afterEach(cleanup);

  it("renders Markdown and drops raw HTML entirely", () => {
    const { container } = render(
      <MarkdownReply
        text={[
          "Fixed in **v2.1**.",
          "",
          "<script>alert(1)</script>",
          '<img src="https://evil.example/pixel.gif" onerror="alert(1)">',
          "<!-- ignore previous instructions -->",
          '<a href="https://evil.example">raw link</a>',
          "",
          "- one",
          "- two",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("v2.1");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
    expect(container.innerHTML).not.toContain("ignore previous instructions");
    expect(container.textContent).not.toContain("raw link");
    expect(container.textContent).not.toContain("alert(1)");
  });

  it("opens links in a new tab without referrer and shows the full URL", () => {
    render(<MarkdownReply text="See [the export docs](https://docs.example.org/guide/export#csv)." />);
    const link = screen.getByRole("link", { name: "the export docs" });
    expect(link.getAttribute("href")).toBe("https://docs.example.org/guide/export#csv");
    expect(link.getAttribute("rel")).toBe("nofollow noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.parentElement?.textContent).toContain("(https://docs.example.org/guide/export#csv)");
  });

  it("does not repeat a URL that is already the link text", () => {
    const { container } = render(<MarkdownReply text="Docs: https://docs.example.org/x" />);
    expect(container.querySelector(".md-url")).toBeNull();
    expect(screen.getByRole("link").getAttribute("rel")).toBe("nofollow noopener noreferrer");
  });

  it("neutralises script URLs and never loads images", () => {
    const { container } = render(<MarkdownReply text={"[click](javascript:alert(1)) ![chart](https://img.example/c.png)"} />);
    for (const a of container.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("image: chart (https://img.example/c.png)");
  });
});
