import { describe, expect, it } from "vitest";
import { toStoredEmbedding } from "../../lib/db/vector";

describe("toStoredEmbedding", () => {
  it("truncates to 1024 dims and L2-normalises", () => {
    const v = Array.from({ length: 4096 }, (_, i) => (i % 7) + 1);
    const out = toStoredEmbedding(v);
    expect(out).toHaveLength(1024);
    const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("keeps direction of the first 1024 dims", () => {
    const v = Array.from({ length: 1030 }, () => 2);
    const out = toStoredEmbedding(v);
    expect(out[0]).toBeCloseTo(1 / Math.sqrt(1024), 9);
  });

  it("throws on fewer than 1024 dims", () => {
    expect(() => toStoredEmbedding(new Array(1023).fill(1))).toThrow(/1024/);
  });

  it("throws on a zero vector", () => {
    expect(() => toStoredEmbedding(new Array(1024).fill(0))).toThrow(/zero/);
  });
});
