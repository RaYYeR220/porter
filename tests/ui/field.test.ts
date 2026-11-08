import { describe, expect, it } from "vitest";
import { GlyphField, hit } from "../../components/hero/field";
import type { Label } from "../../components/hero/field";
import { heroData } from "../../components/hero/data";

// Mono label font: about 0.6em per glyph at 11px (10.5px on phones).
const measure = (text: string, mobile: boolean) => [...text].length * (mobile ? 6.3 : 6.6);
const box = (l: Label) => ({ l: l.x, r: l.x + l.w, t: l.y - 11, b: l.y + 11 });
const text = (l: Label) => l.parts.map((p) => p[0]).join("");

const signals = heroData.attacks.map((a) => a.signal);
const issueNumbers = new Set(heroData.issues.map(([n]) => `#${n}`));
const ALLOWED = [
  /^gateway$/,
  /^held · ([a-z_]+) · 0 answer tokens$/,
  /^held · 0 answer tokens$/,
  /^(#\d+) · answered · gpt-oss-120b$/,
  /^one author · own daily budget$/,
  /^one author · ≥80% → gpt-oss-20b$/,
  /^refused · resets 00:00 UTC$/,
];

function open(W: number, H: number) {
  const f = new GlyphField(heroData, measure);
  f.layout(W, H);
  f.reset();
  f.prewarm(30);
  f.settleOpening();
  return f;
}

/** Plays the field and checks every frame's labels: no two overlap, none covers a held or refused column. */
function audit(f: GlyphField, seconds: number) {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    f.step(1 / 60);
    const labels = f.labels().filter((l) => l.alpha > 0.05);
    for (const l of labels) seen.add(text(l));
    for (let i = 0; i < labels.length; i++)
      for (let j = i + 1; j < labels.length; j++)
        if (hit(box(labels[i]), box(labels[j]), 0)) problems.push(`${labels[i].kind}/${labels[j].kind} at ${f.T.toFixed(1)}`);
    const strips = f.holds.filter((h) => f.holdAlpha(h) > 0.05).map((h) => f.strip(h.c));
    if (f.burst && f.burst.stage > 0) strips.push(f.strip(f.burst.col));
    for (const l of labels) {
      if (l.kind === "gateway" || l.kind === "answered") continue;
      for (const s of strips) if (hit(box(l), { l: s.l + 2, r: s.r - 2, t: s.t, b: s.b }, 0)) problems.push(`${l.kind}/column at ${f.T.toFixed(1)}`);
    }
  }
  return { seen, problems };
}

describe("hero field", () => {
  it.each([
    ["desktop", 1440, 306],
    ["wide", 2000, 338],
    ["phone", 390, 250],
  ])("never stacks labels or covers a held column (%s)", (_name, W, H) => {
    const { problems } = audit(open(W, H), 150);
    expect(problems).toEqual([]);
  });

  it("states only facts: signal ids from the detectors, real issue numbers, configured models and reset time", () => {
    const f = open(1440, 306);
    const { seen } = audit(f, 150);
    for (const t of seen) {
      expect(t).not.toMatch(/\$/);
      const rule = ALLOWED.find((r) => r.test(t));
      expect(rule, t).toBeDefined();
      const held = /^held · ([a-z_]+) · 0 answer tokens$/.exec(t);
      if (held) expect(signals).toContain(held[1]);
      const answered = /^(#\d+) · answered/.exec(t);
      if (answered) expect(issueNumbers.has(answered[1])).toBe(true);
    }
    // the loop shows the whole mechanism: a hold, an answer, a tier-down and a refusal
    const all = [...seen].join("\n");
    expect(all).toMatch(/^held · /m);
    expect(all).toMatch(/answered · gpt-oss-120b/);
    expect(all).toMatch(/→ gpt-oss-20b/);
    expect(all).toMatch(/^refused · resets 00:00 UTC$/m);
  });

  it("opens on a fresh hold, with an answered issue on desktop", () => {
    const f = open(1440, 306);
    expect(f.holds.some((h) => h.box && f.T - h.t < 0.25)).toBe(true);
    // the hold's label fades in over 0.3 s
    for (let t = 0; t < 0.35; t += 1 / 60) f.step(1 / 60);
    const kinds = f.labels().map((l) => l.kind);
    expect(kinds).toContain("held");
    expect(kinds).toContain("answered");
  });

  it("has a still frame with one held column and one answered issue, both labelled", () => {
    const f = open(1440, 306);
    f.settleStatic();
    const labels = f.labels();
    expect(labels.filter((l) => l.kind === "held" && l.alpha > 0.9)).toHaveLength(1);
    expect(labels.filter((l) => l.kind === "answered" && l.alpha > 0.9)).toHaveLength(1);
    expect(labels.some((l) => l.kind === "spam")).toBe(false);
  });

  it("sends a clicked attack up the nearest free column and holds it at the line", () => {
    const f = open(1440, 306);
    const holdsBefore = f.holds.length;
    expect(f.click(720, 200)).toBe(true);
    expect(f.rings).toHaveLength(1);
    let caught = false;
    for (let t = 0; t < 6 && !caught; t += 1 / 60) {
      f.step(1 / 60);
      caught = f.holds.length > holdsBefore || f.holds.some((h) => f.T - h.t < 0.05);
    }
    expect(caught).toBe(true);
    // above the line is not the field
    expect(f.click(720, 10)).toBe(false);
  });

  it("is deterministic for a given size", () => {
    const a = open(1440, 306);
    const b = open(1440, 306);
    expect(a.T).toBe(b.T);
    expect(a.labels().map(text)).toEqual(b.labels().map(text));
  });
});
