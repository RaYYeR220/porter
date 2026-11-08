import { FACTS } from "./data";
import type { HeroAttack, HeroData } from "./data";

/**
 * The glyph field under the landing headline, as a simulation with no DOM.
 *
 * Columns of issue text rise through one hairline (the gateway). Ordinary text crosses and settles; payload
 * characters catch on the line and the column holds; one author's burst thins out and is refused. Labels are
 * placed once, never on top of each other or of a held column. Everything is seeded, so a size always opens
 * on the same frame.
 */

/** Seconds. */
export const SCHEDULE = { attackEvery: 5.5, spamEvery: 26, spamAt: 9, holdFor: 5.5, refuseFor: 5, prewarm: 30 } as const;
/** The burst column: issues that cross before it thins out (tier-down), and before the next one is refused. */
const SPAM_THIN_AFTER = 4;
const SPAM_REFUSE_AFTER = 6;
const GAP = 5;
const ISSUE_MAX = 40;

export type Tone = "ink" | "ink2" | "ink3" | "ice";
export type Part = [text: string, tone: Tone];
export type Box = { l: number; r: number; t: number; b: number };
export type LabelKind = "gateway" | "held" | "spam" | "answered";

/** A label as drawn: a pill at (x, y) of width w, and an optional leader line. */
export type Label = {
  kind: LabelKind;
  x: number;
  y: number;
  w: number;
  parts: Part[];
  alpha: number;
  stroke?: "ice";
  leader?: { x1: number; y1: number; x2: number; y2: number; alpha: number; tone: "ink3" | "iceDeep" };
};

export type Glyph = { ch: string; pay?: boolean; hidden?: boolean };
export type Seg = {
  kind: "issue" | "attack" | "spam";
  g: Glyph[];
  y: number;
  /** Index of the first payload glyph (attacks). */
  p: number;
  num?: string;
  atk?: HeroAttack;
  caught?: number;
  fadeT?: number;
  done?: number;
  crossed?: boolean;
  refused?: number;
};
type Halt = { t: number; dur: number; seg: Seg; type: "held" | "refused"; h?: Hold };
export type Col = {
  i: number;
  x: number;
  ex: number;
  edge: number;
  lit: boolean;
  v: number;
  segs: Seg[];
  halted: Halt | null;
  spam: { queue: number[]; first: boolean } | null;
};
export type Hold = { c: Col; s: Seg; t: number; end: number | null; box: Box | null; right: boolean; parts: Part[] };
export type Burst = {
  passed: number;
  stage: 0 | 1 | 2 | 3;
  lastT: number;
  thin: boolean;
  col: Col;
  box: Box | null;
  above: boolean;
  right: boolean;
  done: boolean;
};
export type Answered = { c: Col; s: Seg; t: number; box: Box; parts: Part[]; kill: number | null };

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const hit = (a: Box | null | undefined, b: Box | null | undefined, pad = 6) =>
  !!(a && b) && a.l < b.r + pad && b.l < a.r + pad && a.t < b.b + pad && b.t < a.b + pad;

/** Width of a label's text at the label font; supplied by the renderer (or a stand-in in tests). */
export type Measure = (text: string, mobile: boolean) => number;

export class GlyphField {
  // geometry
  W = 0;
  H = 0;
  mobile = false;
  colW = 19;
  cellH = 17;
  fontPx = 13;
  fadeUp = 0;
  fadeDn = 0;
  mY = 0;
  midDepth = 0;
  pitch = 34;
  spanL = 0;
  spanR = 0;
  cols: Col[] = [];
  spamCol = 0;
  gateBox: Box = { l: 0, r: 0, t: 0, b: 0 };

  // simulation
  T = 0;
  holds: Hold[] = [];
  burst: Burst | null = null;
  answered: Answered | null = null;
  ticks: Array<{ x: number; t: number }> = [];
  flashes: Array<{ x: number; t: number; soft?: boolean }> = [];
  rings: Array<{ x: number; y: number; t: number }> = [];
  private issueIx = 0;
  private atkIx = 0;
  private nextAttack = 0;
  private nextSpam = 0;
  private catchPred = -1e9;
  private seed = 11;

  constructor(
    readonly data: HeroData,
    private readonly measure: Measure,
  ) {}

  private rnd() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /* ---------- geometry ----------
     The field is the band only. mY = the line, ~58px under the band's top edge (room for the "answered"
     label above it). Columns sit on a wide pitch inside one centred span and dim toward its ends. */
  layout(W: number, H: number) {
    this.W = W;
    this.H = H;
    const mobile = (this.mobile = W < 720);
    this.colW = mobile ? 17 : 19;
    this.cellH = mobile ? 15.5 : 17;
    this.fontPx = mobile ? 12 : 13;
    this.fadeUp = this.cellH * 1.6;
    this.fadeDn = Math.min(mobile ? 96 : 124, H * 0.44);
    this.mY = (mobile ? 50 : 58) + 0.5;
    // lit text stays readable down to the fade, at any band height
    this.midDepth = Math.max(7 * this.cellH, (H - this.mY) * 0.62);
    this.pitch = mobile ? 25 : 34;
    const span = mobile ? W - 20 : Math.min(W - 64, 1320);
    const n = Math.max(6, Math.floor(span / this.pitch) + 1);
    const x0 = (W - (n - 1) * this.pitch) / 2;
    this.spanL = x0;
    this.spanR = x0 + (n - 1) * this.pitch;
    const half = Math.max(1, (this.spanR - this.spanL) / 2);
    this.cols = Array.from({ length: n }, (_, i) => {
      const x = x0 + i * this.pitch;
      const ex = Math.abs(x - W / 2) / half;
      const edge = mobile ? 1 - 0.45 * smooth(0.7, 1, ex) : 1 - 0.8 * smooth(0.42, 1, ex);
      return { i, x, ex, edge, lit: false, v: 0, segs: [], halted: null, spam: null };
    });
    this.spamCol = Math.round((n - 1) * (mobile ? 0.3 : 0.22));
    const gateX = mobile ? 10 : Math.max(20, (W - 1280) / 2 + 28);
    this.gateBox = this.boxAt(gateX, this.mY, this.pillW(this.gateParts()), "left");
  }

  /* ---------- labels: only facts ---------- */
  gateParts(): Part[] {
    return [["gateway", "ink3"]];
  }
  holdParts(h: { s: Seg }): Part[] {
    return this.mobile
      ? [["held", "ice"], [" · 0 answer tokens", "ink2"]]
      : [["held", "ice"], [` · ${h.s.atk?.signal ?? "injection"} · 0 answer tokens`, "ink2"]];
  }
  burstParts(stage: number): Part[] {
    if (stage === 3) return [["refused", "ice"], [` · resets ${FACTS.resets}`, "ink2"]];
    if (stage === 2) return [[`one author · ${FACTS.tierDownAt} → ${FACTS.tierDownModel}`, "ink2"]];
    return [["one author · own daily budget", "ink2"]];
  }
  answeredParts(s: Seg): Part[] {
    return [[s.num ?? "", "ink"], [` · answered · ${FACTS.triageModel}`, "ink2"]];
  }

  private pillW(parts: Part[]) {
    return parts.reduce((s, p) => s + this.measure(p[0], this.mobile), 0) + 18;
  }
  private boxAt(x: number, y: number, w: number, align: "left" | "right" | "center"): Box {
    let l = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    l = clamp(l, 8, this.W - w - 8);
    return { l, r: l + w, t: y - 11, b: y + 11 };
  }

  /* ---------- simulation ---------- */
  private vNorm() {
    return (this.mobile ? 22 : 26) + this.rnd() * (this.mobile ? 7 : 8);
  }
  private vSpam() {
    return this.mobile ? 60 : 72;
  }
  // 5–10 empty rows between issues: a sparse field
  private gapRows() {
    return GAP + Math.floor(this.rnd() * 6);
  }
  private issueSeg(): Seg {
    const issues = this.data.issues;
    const r = issues[this.issueIx++ % issues.length];
    let t = `#${r[0]} ${r[1]}`;
    if (t.length > ISSUE_MAX) t = `${t.slice(0, ISSUE_MAX - 1).trimEnd()}…`;
    return { kind: "issue", g: [...t].map((ch) => ({ ch })), num: `#${r[0]}`, y: 0, p: 0 };
  }
  private attackSeg(short: boolean): Seg {
    const r = this.data.attacks[this.atkIx++ % this.data.attacks.length];
    const lead = short ? `${r.lead.trim().split(" ")[0]} ` : r.lead;
    const g: Glyph[] = [...lead].map((ch) => ({ ch }));
    for (const [text, hidden] of r.payload) for (const ch of text) g.push({ ch, pay: true, hidden });
    return { kind: "attack", g, atk: r, p: [...lead].length, y: 0 };
  }
  private spamSeg(k: number): Seg {
    return { kind: "spam", g: [...this.data.spam[k]].map((ch) => ({ ch })), y: 0, p: 0 };
  }
  tail(s: Seg) {
    return s.y + (s.g.length - 1) * this.cellH;
  }
  private append(col: Col, seg: Seg, y?: number) {
    const last = col.segs[col.segs.length - 1];
    seg.y = y ?? (last ? this.tail(last) + (this.gapRows() + 1) * this.cellH : this.H + this.rnd() * this.H * 0.8);
    col.segs.push(seg);
    return seg;
  }

  reset() {
    this.T = 0;
    this.issueIx = 0;
    this.atkIx = 0;
    this.seed = 11;
    this.ticks = [];
    this.holds = [];
    this.burst = null;
    this.answered = null;
    this.flashes = [];
    this.rings = [];
    this.nextAttack = 1;
    this.nextSpam = SCHEDULE.spamAt;
    this.catchPred = -1e9;
    for (const c of this.cols) {
      c.segs = [];
      c.halted = null;
      c.spam = null;
      c.v = this.vNorm();
      // most columns stay dim; the lit ones gather toward the centre
      c.lit = this.rnd() < lerp(0.5, 0.14, smooth(0.1, 1, c.ex));
      const seg = this.issueSeg();
      this.append(c, seg, this.mY + this.rnd() * (this.H - this.mY) - 14 * this.cellH * this.rnd());
    }
  }

  private busyNear(x: number, d: number) {
    return this.holds.some((h) => !h.end && Math.abs(h.c.x - x) < d);
  }
  private central() {
    const half = (this.spanR - this.spanL) / 2;
    const sx = this.cols[this.spamCol].x;
    const m = this.mobile;
    return this.cols.filter(
      (c) =>
        Math.abs(c.x - this.W / 2) < half * (m ? 0.8 : 0.56) &&
        Math.abs(c.x - sx) > (m ? 70 : 300) &&
        !c.halted &&
        !c.spam &&
        !this.busyNear(c.x, m ? 50 : 200) &&
        !c.segs.some((s) => s.kind === "attack" && s.caught === undefined),
    );
  }

  // An attack enters through the faded bottom edge of a central column. Catches are spaced so one hold
  // finishes before the next begins (predicted from the column's speed), so labels never stack.
  private injectAttack() {
    const pool = this.central();
    if (!pool.length || !this.data.attacks.length) return false;
    const { H, cellH } = this;
    const need = this.catchPred + SCHEDULE.holdFor + 1.6;
    const p = [...this.data.attacks[this.atkIx % this.data.attacks.length].lead].length;
    let best: { c: Col; idx: number; y: number; tc: number; score: number } | null = null;
    for (const c of pool) {
      const idx = c.segs.findIndex((o) => o.fadeT === undefined && o.y > H - 2 * cellH);
      const at = idx < 0 ? (c.segs.length ? this.tail(c.segs[c.segs.length - 1]) + (GAP + 1) * cellH : H) : c.segs[idx].y;
      const y = Math.max(at, H - cellH);
      const tc = this.T + (y + p * cellH - this.mY) / c.v;
      if (tc < need) continue;
      const score = tc + this.rnd() * 1.5;
      if (!best || score < best.score) best = { c, idx, y, tc, score };
    }
    if (!best) return false;
    const { c, idx, y, tc } = best;
    const s = this.attackSeg(false);
    s.y = y;
    if (idx >= 0) {
      const shift = s.y + (s.g.length + GAP) * cellH - c.segs[idx].y;
      if (shift > 0) for (let k = idx; k < c.segs.length; k++) c.segs[k].y += shift;
      c.segs.splice(idx, 0, s);
    } else c.segs.push(s);
    this.catchPred = tc;
    return true;
  }

  private startSpam() {
    const c = this.cols[this.spamCol];
    for (const s of c.segs) if (s.y > this.mY - this.cellH) s.fadeT = this.T;
    c.spam = { queue: this.data.spam.map((_, k) => k), first: true };
    c.v = this.vSpam();
    this.burst = { passed: 0, stage: 0, lastT: this.T, thin: false, col: c, box: null, above: false, right: true, done: false };
  }

  step(dt: number) {
    const { mY, cellH, H } = this;
    this.T += dt;
    const T = this.T;
    if (T >= this.nextAttack) this.nextAttack = this.injectAttack() ? T + SCHEDULE.attackEvery * (0.8 + 0.4 * this.rnd()) : T + 0.3;
    if (T >= this.nextSpam && this.data.spam.length) {
      if (this.cols[this.spamCol].halted || (this.burst && !this.burst.done)) this.nextSpam = T + 1;
      else {
        this.startSpam();
        this.nextSpam = T + SCHEDULE.spamEvery;
      }
    }

    for (const c of this.cols) {
      if (!c.halted) for (const s of c.segs) s.y -= c.v * dt;
      for (const s of c.segs) {
        if (s.fadeT !== undefined) continue;
        if (s.kind === "attack" && s.caught === undefined) {
          const yp = s.y + s.p * cellH;
          if (yp <= mY + 1) {
            const d = mY + 1 - yp;
            for (const o of c.segs) o.y += d;
            s.caught = T;
            const h: Hold = { c, s, t: T, end: null, box: null, right: true, parts: [] };
            this.placeHold(h);
            this.holds.push(h);
            c.halted = { t: T, dur: SCHEDULE.holdFor, seg: s, type: "held", h };
            this.flashes.push({ x: c.x, t: T });
          }
        }
        const b = this.burst;
        if (s.kind === "spam" && b) {
          if (!s.crossed && s.refused === undefined && b.passed >= SPAM_REFUSE_AFTER && s.y <= mY + 2 * cellH) {
            const d = mY + 2 * cellH - s.y;
            for (const o of c.segs) o.y += d;
            s.refused = T;
            c.halted = { t: T, dur: SCHEDULE.refuseFor, seg: s, type: "refused" };
            b.stage = 3;
            b.lastT = T;
            this.flashes.push({ x: c.x, t: T, soft: true });
          } else if (!s.crossed && s.refused === undefined && s.y <= mY) {
            s.crossed = true;
            b.passed++;
            b.lastT = T;
            if (b.stage < 1) {
              b.stage = 1;
              this.placeBurst();
            }
            if (b.passed >= SPAM_THIN_AFTER && b.stage < 2) {
              b.stage = 2;
              b.thin = true;
            }
            this.ticks.push({ x: c.x, t: T });
          }
        }
        if (s.kind === "issue" && s.done === undefined && this.tail(s) < mY) {
          s.done = T;
          this.ticks.push({ x: c.x, t: T });
          if (!this.mobile && c.lit && (!this.answered || T - this.answered.t > 5.8)) this.tryAnswered(c, s);
        }
      }
      if (c.halted && T - c.halted.t > c.halted.dur) {
        if (c.halted.type === "held") {
          c.halted.seg.fadeT = T;
          if (c.halted.h) c.halted.h.end = T;
          c.v = this.vNorm();
        } else {
          for (const s of c.segs) if (s.kind === "spam" && !s.crossed) s.fadeT = T;
          c.spam = null;
          c.v = this.vNorm();
          if (this.burst) this.burst.done = true;
        }
        c.halted = null;
      }
      // a burst whose lines all crossed without a refusal ends here, so the column goes back to issues
      if (c.spam && !c.spam.queue.length && !c.halted && !c.segs.some((s) => s.kind === "spam" && !s.crossed && s.fadeT === undefined)) {
        c.spam = null;
        c.v = this.vNorm();
        if (this.burst) this.burst.done = true;
      }
      c.segs = c.segs.filter((s) => !(s.fadeT !== undefined && T - s.fadeT > 0.7) && this.tail(s) > mY - this.fadeUp - cellH);
      // keep each column fed from the bottom edge
      const last = c.segs[c.segs.length - 1];
      if (!last || this.tail(last) < H + cellH) {
        if (c.spam && c.spam.queue.length) {
          const k = c.spam.queue.shift() as number;
          const y0 = c.spam.first ? Math.max(H + cellH, last && last.fadeT === undefined ? this.tail(last) + (GAP + 1) * cellH : 0) : undefined;
          c.spam.first = false;
          const s = this.append(c, this.spamSeg(k), y0);
          const prev = c.segs[c.segs.length - 2];
          if (prev && prev.kind === "spam") s.y = this.tail(prev) + 2 * cellH;
        } else if (!c.spam) {
          this.append(c, this.issueSeg());
        }
      }
    }
    this.holds = this.holds.filter((h) => !(h.end !== null && T - h.end > 0.6));
    if (this.burst && this.burst.done && T - this.burst.lastT > SCHEDULE.refuseFor + 1) this.burst = null;
    this.ticks = this.ticks.filter((t) => T - t.t < 2.6);
    this.flashes = this.flashes.filter((f) => T - f.t < 1.4);
    this.rings = this.rings.filter((r) => T - r.t < 1);
  }

  /* ---------- label placement: once, never on top of each other ---------- */
  // a column that is held or refused is an obstacle too: no label may cover its glyphs
  strip(c: Col): Box {
    return { l: c.x - 8, r: c.x + 8, t: this.mY - 2, b: this.H };
  }
  // (also any column with an attack still on its way up that will reach the line while a label placed now
  // is still showing)
  private inFlight(): Box[] {
    return this.cols
      .filter((c) =>
        c.segs.some(
          (s) =>
            s.kind === "attack" &&
            s.caught === undefined &&
            s.fadeT === undefined &&
            (s.y + s.p * this.cellH - this.mY) / Math.max(c.v, 1) < SCHEDULE.holdFor + 1.2,
        ),
      )
      .map((c) => this.strip(c));
  }
  // (holds count until their label and glow have fully faded, not just until release)
  private liveBoxes(skip: unknown): Box[] {
    const b = this.burst;
    const a = this.answered;
    return [
      this.gateBox,
      b && b !== skip ? b.box : null,
      this.cols[this.spamCol] ? this.strip(this.cols[this.spamCol]) : null,
      ...this.inFlight(),
      ...this.holds.filter((h) => h !== skip && h.box).map((h) => h.box),
      ...this.holds.map((h) => this.strip(h.c)),
      a && a !== skip && this.T - a.t < 5.4 ? a.box : null,
    ].filter((x): x is Box => !!x);
  }

  private placeHold(h: Hold) {
    const parts = this.holdParts(h);
    const w = this.pillW(parts);
    const b = this.burst;
    const sx = b && !b.done ? b.col.x : null;
    const prefRight = sx !== null ? h.c.x > sx : h.c.x < this.W * 0.62;
    const a = this.answered;
    const others = this.liveBoxes(h)
      .filter((x) => !(a && x === a.box))
      .concat([this.strip(h.c)]);
    for (const dy of [1.6, 3.2])
      for (const right of [prefRight, !prefRight]) {
        const box = this.boxAt(right ? h.c.x + 16 : h.c.x - 16, this.mY + this.cellH * dy, w, right ? "left" : "right");
        if (!others.some((o) => hit(o, box))) {
          h.box = box;
          h.right = right;
          h.parts = parts;
          // the hold outranks an answer
          if (a && hit(a.box, box)) this.answered = null;
          else if (a && h.c.x > a.box.l - 48 && h.c.x < a.box.r + 48) a.kill = this.T;
          return;
        }
      }
    h.box = null; // no clean slot: the glow carries it alone
  }

  private placeBurst() {
    const b = this.burst;
    if (!b) return;
    const w = Math.max(...[1, 2, 3].map((st) => this.pillW(this.burstParts(st))));
    if (this.mobile) {
      // narrow screen: no room beside the column, so the label sits above the line
      b.above = true;
      b.right = true;
      b.box = this.boxAt(b.col.x - 8, this.mY - 30, w, "left");
      return;
    }
    const y = this.mY + this.cellH * 4.2;
    const others = this.liveBoxes(b).concat([this.strip(b.col)]);
    for (const right of [true, false]) {
      const box = this.boxAt(right ? b.col.x + 16 : b.col.x - 16, y, w, right ? "left" : "right");
      if (!others.some((o) => hit(o, box))) {
        b.box = box;
        b.right = right;
        return;
      }
    }
    // both sides blocked (a visitor sent attacks next to it): lift the label above the line
    b.above = true;
    b.right = true;
    b.box = this.boxAt(b.col.x - 8, this.mY - 30, w, "left");
    if (this.answered && hit(this.answered.box, b.box)) this.answered = null;
  }

  private tryAnswered(c: Col, s: Seg) {
    const parts = this.answeredParts(s);
    const w = this.pillW(parts);
    const right = c.x < this.W / 2;
    const box = this.boxAt(right ? c.x - 8 : c.x + 8, this.mY - 30, w, right ? "left" : "right");
    if (box.l < this.spanL - 24 || box.r > this.spanR + 24) return;
    if (this.liveBoxes(this.answered).some((o) => hit(o, box))) return;
    // keep the answer clear of a held column, and of one about to be held
    const xs = this.holds.map((h) => h.c.x).concat(this.inFlight().map((st) => st.l + 8));
    if (xs.some((x) => x > box.l - 48 && x < box.r + 48)) return;
    this.answered = { c, s, t: this.T, box, parts, kill: null };
  }

  holdAlpha(h: Hold) {
    return clamp((this.T - h.t) / 0.3, 0, 1) * (1 - clamp((this.T - h.t - SCHEDULE.holdFor) / 0.4, 0, 1));
  }

  /** Every label visible now, as it is drawn. */
  labels(): Label[] {
    const out: Label[] = [];
    const pill = (box: Box, y: number, parts: Part[], align: "left" | "right", alpha: number, kind: LabelKind, stroke?: "ice"): Label => {
      const w = this.pillW(parts);
      return { kind, x: align === "right" ? box.r - w : box.l, y, w, parts, alpha, stroke };
    };
    out.push(pill(this.gateBox, this.mY, this.gateParts(), "left", 1, "gateway"));
    for (const h of this.holds) {
      if (!h.box) continue;
      const a = this.holdAlpha(h);
      if (a <= 0) continue;
      const y = (h.box.t + h.box.b) / 2;
      const l = pill(h.box, y, h.parts, h.right ? "left" : "right", a, "held", "ice");
      l.leader = h.right
        ? { x1: h.c.x + 7, y1: y, x2: h.box.l, y2: y, alpha: a * 0.5, tone: "iceDeep" }
        : { x1: h.box.r, y1: y, x2: h.c.x - 7, y2: y, alpha: a * 0.5, tone: "iceDeep" };
      out.push(l);
    }
    const b = this.burst;
    if (b && b.stage > 0 && b.box) {
      // shown for the whole burst; it fades once the refusal has been held long enough
      const age = this.T - b.lastT;
      const a = b.stage === 3 || b.done ? 1 - clamp((age - (b.stage === 3 ? SCHEDULE.refuseFor : 3.5)) / 0.6, 0, 1) : 1;
      if (a > 0) {
        const y = (b.box.t + b.box.b) / 2;
        const x = b.col.x;
        const l = pill(b.box, y, this.burstParts(b.stage), b.right ? "left" : "right", a, "spam");
        l.leader = b.above
          ? { x1: x + 0.5, y1: this.mY - 19, x2: x + 0.5, y2: this.mY - 12, alpha: a * 0.5, tone: "ink3" }
          : b.right
            ? { x1: x + 7, y1: y, x2: b.box.l, y2: y, alpha: a * 0.5, tone: "ink3" }
            : { x1: b.box.r, y1: y, x2: x - 7, y2: y, alpha: a * 0.5, tone: "ink3" };
        out.push(l);
      }
    }
    const an = this.answered;
    if (an && !this.mobile) {
      const age = this.T - an.t;
      const fade = an.kill !== null ? clamp((this.T - an.kill) / 0.25, 0, 1) : clamp((age - 4.8) / 0.5, 0, 1);
      const a = clamp(age / 0.3, 0, 1) * (1 - fade);
      if (a > 0) {
        const x = an.c.x;
        const l = pill(an.box, this.mY - 30, an.parts, x < this.W / 2 ? "left" : "right", a, "answered");
        l.leader = { x1: x + 0.5, y1: this.mY - 19, x2: x + 0.5, y2: this.mY - 12, alpha: a * 0.45, tone: "ink3" };
        out.push(l);
      }
    }
    return out;
  }

  /* ---------- input ---------- */
  inField(y: number) {
    return y > this.mY - this.cellH;
  }

  /** Sends an attack up the nearest free column, starting where the visitor clicked. */
  click(x: number, y: number) {
    if (!this.inField(y) || !this.data.attacks.length) return false;
    // nearest free column that no label is sitting on
    const b = this.burst;
    const boxes = [b && !b.above ? b.box : null, ...this.holds.filter((h) => h.box).map((h) => h.box)];
    const under = (cx: number) => boxes.some((bx) => bx && cx > bx.l - 10 && cx < bx.r + 10);
    const free = this.cols.filter((c) => !c.halted && !c.spam && !under(c.x)).sort((a, z) => Math.abs(a.x - x) - Math.abs(z.x - x));
    const c = free[0];
    if (!c) return false;
    // clear the column below the line (a crossing issue included) and start the attack where you clicked
    for (const s of c.segs) if (this.tail(s) > this.mY) s.fadeT = this.T;
    const y0 = Math.max(y, this.mY + 2 * this.cellH);
    const s = this.attackSeg(true);
    s.y = y0;
    c.segs.push(s);
    c.segs.sort((a, z) => a.y - z.y);
    // reaches the line in ~2s, never faster than 90px/s
    c.v = clamp((s.y + s.p * this.cellH - this.mY) / 2, c.v, 90);
    this.rings.push({ x: c.x, y: y0, t: this.T });
    return true;
  }

  /* ---------- runs ---------- */
  prewarm(sec: number) {
    for (let t = 0; t < sec; t += 1 / 60) this.step(1 / 60);
  }

  /** Opens on the mechanism: a column just caught on the line (and, on desktop, an ordinary issue just answered). */
  settleOpening() {
    const fresh = () => this.holds.some((h) => h.box && this.T - h.t < 0.25);
    const ans = () => this.mobile || (!!this.answered && this.answered.kill === null && this.T - this.answered.t < 1.2);
    let guard = 0;
    while (!(fresh() && ans()) && guard++ < 9000) this.step(1 / 60);
    guard = 0;
    while (!fresh() && guard++ < 1800) this.step(1 / 60);
  }

  /** The reduced-motion frame: one held column and one answered issue, both labelled, nothing else in flight. */
  settleStatic() {
    let guard = 0;
    while (!this.holds.some((h) => h.box && this.T - h.t > 0.6 && this.T - h.t < 2) && guard++ < 3600) this.step(1 / 60);
    if (this.answered) {
      this.answered.t = this.T - 1;
      this.answered.kill = null;
    }
    this.burst = null;
  }
}
