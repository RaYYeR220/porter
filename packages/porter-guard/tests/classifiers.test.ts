import { describe, expect, it } from "vitest";
import { parseLlamaGuard } from "../src/classifiers.ts";

describe("parseLlamaGuard", () => {
  it("flags unsafe output with a category that applies to an issue desk", () => {
    expect(parseLlamaGuard("unsafe\nS1")).toEqual({ flagged: true, score: 0.9 });
    expect(parseLlamaGuard("\n\nunsafe\nS10,S14")).toEqual({ flagged: true, score: 0.9 });
  });
  it("does not flag S14 alone: every issue carries code, and snippets run in an isolated sandbox", () => {
    expect(parseLlamaGuard("\n\nunsafe\nS14")).toEqual({ flagged: false, score: 0.2 });
  });
  it("still flags an unsafe verdict without a category", () => {
    expect(parseLlamaGuard("unsafe")).toEqual({ flagged: true, score: 0.9 });
  });
  it("reads safe and refuses garbage", () => {
    expect(parseLlamaGuard("safe")).toEqual({ flagged: false, score: 0.05 });
    expect(parseLlamaGuard("maybe")).toEqual({ flagged: null, score: null });
  });
});
