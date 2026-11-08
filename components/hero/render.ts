import { clamp, smooth } from "./field";
import type { Col, GlyphField, Label, Tone } from "./field";

export type Palette = {
  ground: string;
  ink: string;
  ink2: string;
  /** Muted text that still reads on the ground (labels). */
  ink3: string;
  /** Muted glyphs and strokes in the field. */
  glyph3: string;
  ink4: string;
  ice: string;
  iceDeep: string;
};

/** Mirrors the tokens in app/globals.css; read from the page when it is there. */
export const DEFAULT_PALETTE: Palette = {
  ground: "#12110f",
  ink: "#f2efe8",
  ink2: "#b9b4aa",
  ink3: "#8c877e",
  glyph3: "#6f6a62",
  ink4: "#3a3631",
  ice: "#7ab8ff",
  iceDeep: "#4a86d6",
};

const VARS: Record<keyof Palette, string> = {
  ground: "--ground",
  ink: "--ink",
  ink2: "--ink-2",
  ink3: "--ink-3",
  glyph3: "--glyph-3",
  ink4: "--ink-4",
  ice: "--accent",
  iceDeep: "--accent-deep",
};

export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const out = { ...DEFAULT_PALETTE };
  for (const key of Object.keys(VARS) as Array<keyof Palette>) {
    const v = cs.getPropertyValue(VARS[key]).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) out[key] = v;
  }
  return out;
}

export function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export type Pointer = { on: boolean; x: number; y: number };

const LENS = 60;
const PADX = 9;
const PADY = 9;
// glyph styles: 0 dim · 1 mid · 2 light · 3 bright · 4 ice glow · 5 ice deep · 6 thin mid · 7 thin dim · 8 ice
const THIN = new Set([6, 7]);

export class FieldRenderer {
  private atlas: HTMLCanvasElement | null = null;
  private index = new Map<string, number>();
  private cwD = 0;
  private chD = 0;
  private gw = 0;
  private gh = 0;
  private dpr = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly pal: Palette,
    private readonly mono: string,
  ) {}

  private labelFont(mobile: boolean) {
    return `500 ${mobile ? 10.5 : 11}px ${this.mono}`;
  }

  readonly measure = (text: string, mobile: boolean) => {
    this.ctx.font = this.labelFont(mobile);
    return this.ctx.measureText(text).width;
  };

  resize(W: number, H: number, dpr: number) {
    this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
  }

  /** Pre-renders every character the field can show, in every style, once per size. */
  buildAtlas(f: GlyphField) {
    const set = new Set<string>();
    for (let c = 32; c < 127; c++) set.add(String.fromCharCode(c));
    for (const [, title] of f.data.issues) for (const ch of title) set.add(ch);
    for (const a of f.data.attacks) {
      for (const ch of a.lead) set.add(ch);
      for (const [text] of a.payload) for (const ch of text) set.add(ch);
    }
    for (const line of f.data.spam) for (const ch of line) set.add(ch);
    for (const ch of "…✓") set.add(ch);
    const list = [...set];
    this.index = new Map(list.map((c, i) => [c, i]));
    const { dpr, pal } = this;
    const styles = [pal.ink4, pal.glyph3, pal.ink2, pal.ink, pal.ice, pal.iceDeep, pal.glyph3, pal.ink4, pal.ice];
    this.gw = f.colW + PADX * 2;
    this.gh = f.cellH + PADY * 2;
    this.cwD = Math.ceil(this.gw * dpr);
    this.chD = Math.ceil(this.gh * dpr);
    const atlas = document.createElement("canvas");
    atlas.width = this.cwD * list.length;
    atlas.height = this.chD * styles.length;
    const a = atlas.getContext("2d");
    if (!a) return;
    a.textAlign = "center";
    a.textBaseline = "middle";
    styles.forEach((col, si) => {
      const thin = THIN.has(si);
      a.font = `${thin ? 400 : 500} ${Math.round((thin ? f.fontPx * 0.74 : f.fontPx) * dpr)}px ${this.mono}`;
      a.fillStyle = col;
      if (si === 4) {
        a.shadowColor = rgba(pal.ice, 0.9);
        a.shadowBlur = 9 * dpr;
      } else a.shadowBlur = 0;
      list.forEach((ch, ci) => {
        if (ch !== " ") a.fillText(ch, ci * this.cwD + this.cwD / 2, si * this.chD + this.chD / 2 + 0.5 * dpr);
      });
    });
    this.atlas = atlas;
  }

  private glyph(ch: string, si: number, x: number, y: number, alpha: number) {
    const ci = this.index.get(ch);
    if (ci === undefined || ch === " " || alpha <= 0.01 || !this.atlas) return;
    this.ctx.globalAlpha = Math.min(1, alpha);
    this.ctx.drawImage(this.atlas, ci * this.cwD, si * this.chD, this.cwD, this.chD, x - this.gw / 2, y - this.gh / 2, this.gw, this.gh);
  }

  private drawCol(f: GlyphField, c: Col, raw: boolean, clip?: { y0: number; y1: number }) {
    const { T, mY, H, cellH, fadeUp, fadeDn, midDepth } = f;
    for (const s of c.segs) {
      const fade = s.fadeT !== undefined ? 1 - (T - s.fadeT) / 0.6 : 1;
      if (fade <= 0) continue;
      const snuff = s.caught !== undefined ? clamp(1 - (T - s.caught) / 0.35, 0, 1) : 1;
      const lit = c.lit || s.kind !== "issue";
      for (let k = 0; k < s.g.length; k++) {
        const y = s.y + k * cellH;
        if (y > H + cellH) break;
        if (y < mY - fadeUp) continue;
        if (clip && (y < clip.y0 || y > clip.y1)) continue;
        const g = s.g[k];
        if (g.ch === " ") continue;
        let si = 1;
        let a = 1;
        if (y < mY) {
          // passed the line: settle dim and fade
          if (s.caught !== undefined && !g.pay) a = snuff;
          si = raw ? 2 : lit ? 1 : 0;
          a *= (1 - (mY - y) / fadeUp) * (raw ? 0.9 : 0.75);
          if (!raw) a *= c.edge;
        } else {
          const depth = y - mY;
          const bf = smooth(0, 1, (H - y) / fadeDn); // soft bottom edge
          if (lit) si = depth < cellH * 0.95 ? 3 : depth < 3 * cellH ? 2 : depth < midDepth ? 1 : 0;
          else si = depth < 3 * cellH ? 1 : 0;
          a = bf * (lit ? 1 : depth < 3 * cellH ? 0.5 : 1);
          if (raw) {
            si = depth < cellH * 0.95 ? 3 : 2;
            a = Math.max(bf, 0.4);
          } else a *= c.edge;
          if (s.kind === "spam") {
            si = f.burst && f.burst.thin && !s.crossed ? (depth < 4 * cellH ? 6 : 7) : 3;
            a = bf * Math.max(c.edge, 0.85);
          }
          if (g.pay) {
            if (s.caught !== undefined) {
              si = 4;
              a = 0.95 * smooth(0, 1, (H - y) / (fadeDn * 0.7));
            } else if (raw) si = 8;
            else if (g.hidden) continue; // invisible in the rendered issue
          }
          if (s.refused !== undefined && k < 2) si = 5;
        }
        this.glyph(g.ch, si, c.x, y, a * fade);
      }
    }
  }

  private tone(t: Tone) {
    return t === "ice" ? this.pal.ice : t === "ink" ? this.pal.ink : t === "ink2" ? this.pal.ink2 : this.pal.ink3;
  }

  private pill(l: Label, mobile: boolean) {
    const { ctx, pal } = this;
    const h = 22;
    ctx.font = this.labelFont(mobile);
    ctx.globalAlpha = l.alpha;
    ctx.beginPath();
    ctx.roundRect(l.x + 0.5, l.y - h / 2 + 0.5, l.w, h, h / 2);
    ctx.fillStyle = rgba(pal.ground, 0.94);
    ctx.fill();
    ctx.strokeStyle = l.stroke === "ice" ? rgba(pal.ice, 0.35) : rgba(pal.ink, 0.16);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textBaseline = "middle";
    let cx = l.x + 9;
    for (const [t, tone] of l.parts) {
      ctx.fillStyle = this.tone(tone);
      ctx.fillText(t, cx, l.y + 1);
      cx += ctx.measureText(t).width;
    }
    ctx.globalAlpha = 1;
    if (l.leader) {
      const d = l.leader;
      ctx.globalAlpha = d.alpha;
      ctx.strokeStyle = d.tone === "iceDeep" ? pal.iceDeep : pal.glyph3;
      ctx.beginPath();
      ctx.moveTo(d.x1, d.y1);
      ctx.lineTo(d.x2, d.y2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  draw(f: GlyphField, ptr: Pointer) {
    const { ctx, pal, dpr } = this;
    const { W, T, mY, holds } = f;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // catch glow pools, under the glyphs
    for (const h of holds) {
      const k = f.holdAlpha(h);
      if (k <= 0) continue;
      const g = ctx.createRadialGradient(h.c.x, mY, 0, h.c.x, mY, 74);
      g.addColorStop(0, rgba(pal.ice, 0.16 * k));
      g.addColorStop(0.8, rgba(pal.ice, 0));
      ctx.fillStyle = g;
      ctx.fillRect(h.c.x - 74, mY - 74, 148, 148);
    }

    for (const c of f.cols) this.drawCol(f, c, false);

    // the line: one hairline, fading past the ends of the field
    const lg = ctx.createLinearGradient(0, 0, W, 0);
    const line = rgba(pal.ink2, 0.5);
    const none = rgba(pal.ink2, 0);
    if (f.mobile) {
      lg.addColorStop(0, none);
      lg.addColorStop(0.06, line);
      lg.addColorStop(0.94, line);
      lg.addColorStop(1, none);
    } else {
      const a0 = Math.max(0, f.spanL - 170) / W;
      const a1 = (f.spanL + 50) / W;
      const b1 = (f.spanR - 50) / W;
      const b0 = Math.min(W, f.spanR + 170) / W;
      lg.addColorStop(a0, none);
      lg.addColorStop(a1, line);
      lg.addColorStop(b1, line);
      lg.addColorStop(b0, none);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = lg;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mY);
    ctx.lineTo(W, mY);
    ctx.stroke();
    for (const fl of f.flashes) {
      const k = (T - fl.t) / 1.4;
      ctx.globalAlpha = (1 - k) * (fl.soft ? 0.5 : 0.9);
      ctx.strokeStyle = fl.soft ? pal.iceDeep : pal.ice;
      ctx.beginPath();
      ctx.moveTo(fl.x - 34 - 40 * k, mY);
      ctx.lineTo(fl.x + 34 + 40 * k, mY);
      ctx.stroke();
    }
    for (const h of holds) {
      const k = f.holdAlpha(h);
      if (k <= 0) continue;
      ctx.globalAlpha = 0.9 * k;
      ctx.strokeStyle = pal.ice;
      ctx.beginPath();
      ctx.moveTo(h.c.x - 30, mY);
      ctx.lineTo(h.c.x + 30, mY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // answered ticks on the line
    ctx.strokeStyle = pal.glyph3;
    ctx.lineWidth = 1;
    for (const t of f.ticks) {
      const k = (T - t.t) / 2.6;
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.beginPath();
      ctx.moveTo(t.x - 3, mY - 7);
      ctx.lineTo(t.x - 1, mY - 5);
      ctx.lineTo(t.x + 3, mY - 10);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const l of f.labels()) this.pill(l, f.mobile);

    for (const r of f.rings) {
      const k = T - r.t;
      ctx.globalAlpha = (1 - k) * 0.6;
      ctx.strokeStyle = pal.iceDeep;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 5 + 16 * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // the lens: raw characters, hidden ones visible
    if (ptr.on) {
      const { x, y } = ptr;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, LENS, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = pal.ground;
      ctx.fillRect(x - LENS, y - LENS, LENS * 2, LENS * 2);
      ctx.fillStyle = rgba(pal.ice, 0.04);
      ctx.fillRect(x - LENS, y - LENS, LENS * 2, LENS * 2);
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = pal.ink2;
      ctx.beginPath();
      ctx.moveTo(x - LENS, mY);
      ctx.lineTo(x + LENS, mY);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const clip = { y0: y - LENS - f.cellH, y1: y + LENS + f.cellH };
      for (const c of f.cols) if (Math.abs(c.x - x) < LENS + f.colW) this.drawCol(f, c, true, clip);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = rgba(pal.ink, 0.28);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, LENS + 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = `400 10px ${this.mono}`;
      ctx.fillStyle = pal.ink3;
      ctx.textBaseline = "middle";
      ctx.fillText("raw", x + LENS * 0.74 + 6, y + LENS * 0.74 + 6);
    }
  }
}
