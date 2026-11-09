import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../components/app/ansi";

const ESC = "\u001b";

describe("stripAnsi", () => {
  it("drops SGR colour codes and keeps the text", () => {
    expect(stripAnsi(`${ESC}[31mERROR: no such package${ESC}[0m`)).toBe("ERROR: no such package");
    expect(stripAnsi(`${ESC}[1;39;49m]${ESC}[0m ${ESC}[34;49mnotice${ESC}[0m`)).toBe("] notice");
  });

  it("matches pip's real output from a sandbox run", () => {
    const raw =
      `${ESC}[31mERROR: Could not find a version that satisfies the requirement any-fetch${ESC}[0m${ESC}[31m\r\n${ESC}[0m\r\n` +
      `${ESC}[1m[${ESC}[0m${ESC}[34;49mnotice${ESC}[0m${ESC}[1;39;49m]${ESC}[0m${ESC}[39;49m A new release of pip is available: ${ESC}[0m` +
      `${ESC}[31;49m26.2.2${ESC}[0m${ESC}[39;49m -> ${ESC}[0m${ESC}[32;49m26.3${ESC}[0m\r\n`;
    expect(stripAnsi(raw)).toBe(
      "ERROR: Could not find a version that satisfies the requirement any-fetch\r\n\r\n[notice] A new release of pip is available: 26.2.2 -> 26.3\r\n",
    );
  });

  it("drops cursor movement, erase, private modes and the 8-bit CSI", () => {
    expect(stripAnsi(`50%${ESC}[2K${ESC}[1G100%`)).toBe("50%100%");
    expect(stripAnsi(`${ESC}[?25lbusy${ESC}[?25h`)).toBe("busy");
    expect(stripAnsi(`a${ESC}[3Ab\u009b1mc`)).toBe("abc");
  });

  it("drops OSC sequences (window titles, hyperlinks) ended by BEL or ST", () => {
    expect(stripAnsi(`${ESC}]0;title\u0007done`)).toBe("done");
    expect(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
  });

  it("drops two-character escapes and charset selection", () => {
    expect(stripAnsi(`${ESC}(Bplain${ESC}7saved${ESC}8`)).toBe("plainsaved");
  });

  it("leaves ordinary text, brackets and newlines alone", () => {
    const text = "Traceback (most recent call last):\n  File \"x.py\", line 1\n[1, 2][0m]\ttab";
    expect(stripAnsi(text)).toBe(text);
    expect(stripAnsi("")).toBe("");
  });

  it("drops a stray escape left at the end of cut output", () => {
    expect(stripAnsi(`ok${ESC}[3`)).toBe("ok");
    expect(stripAnsi(`ok${ESC}`)).toBe("ok");
  });
});
