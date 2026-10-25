// High-resolution text for the repainted-graphics mode: every character the game drew with its bitmap
// font is erased from the blended frame and drawn again with a smooth font at the same place, size and
// color. Characters that are partly covered (by a window or the cursor) and special symbols stay as
// the original pixels.

import { OWNER_TEXT_BASE, TextGlyph } from './screen';
import { AI_SCALE, OUT_W } from './ai-compose';

export const TEXT_FONT_FAMILY = 'SciText';

/** The subset of CanvasRenderingContext2D used to draw text (browser canvas or @napi-rs/canvas). */
export interface TextContext {
  font: string;
  fillStyle: string | unknown;
  globalAlpha: number;
  textBaseline: string;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** A line of text to redraw: consecutive glyphs on one row with the same font and color. */
export interface TextRun {
  text: string;
  left: number; // original pixels
  top: number;
  right: number;
  h: number;
  color: number; // EGA color actually on screen
  greyed: boolean;
  /** Font size relative to the cell height (default 1.08). */
  size?: number;
  /** Largest horizontal stretch used to fill the original width (default 1.3). */
  maxStretch?: number;
}

const isRedrawable = (ch: number) => ch >= 33 && ch <= 126;

/**
 * Removes fully visible text from `out` (filling it with the surrounding color) and returns it as runs
 * for drawRuns. `hidden` marks pixels to leave alone (the cursor); `frame` gives the colors on screen.
 */
export function eraseText(
  owner: Int32Array,
  glyphs: Map<number, TextGlyph>,
  hidden: Uint8Array,
  frame: Uint8Array,
  out: Uint32Array,
): TextRun[] {
  const S = AI_SCALE;
  const visible = new Map<number, number>();
  const shown = new Map<number, number>(); // owner -> color on screen
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i];
    if (o > OWNER_TEXT_BASE) continue;
    visible.set(o, (visible.get(o) ?? 0) + 1);
    if (!hidden[i]) shown.set(o, frame[i]);
  }
  const ok = new Set<number>();
  const list: (TextGlyph & { shownColor: number })[] = [];
  for (const [o, n] of visible) {
    const g = glyphs.get(OWNER_TEXT_BASE - o);
    if (g && n === g.pixels && isRedrawable(g.ch)) {
      ok.add(o);
      list.push({ ...g, shownColor: shown.get(o) ?? g.color });
    }
  }
  if (!ok.size) return [];
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      const i = y * 320 + x;
      if (!ok.has(owner[i])) continue;
      // The nearest pixel on this row that is not text gives the background color.
      let fill = -1;
      for (let d = 1; d < 12 && fill < 0; d++) {
        for (const nx of [x - d, x + d]) {
          if (nx < 0 || nx >= 320) continue;
          if (owner[y * 320 + nx] > OWNER_TEXT_BASE) {
            fill = out[(y * S + S / 2) * OUT_W + nx * S + S / 2];
            break;
          }
        }
      }
      if (fill < 0) continue;
      for (let by = 0; by < S; by++) out.fill(fill >>> 0, (y * S + by) * OUT_W + x * S, (y * S + by) * OUT_W + x * S + S);
    }
  }
  // Group into runs; a small gap between glyphs is a space.
  list.sort((a, b) => a.top - b.top || a.left - b.left);
  const runs: TextRun[] = [];
  let cur: TextRun | null = null;
  let curFont = -1;
  for (const g of list) {
    const gap = cur ? g.left - cur.right : 0;
    if (cur && g.top === cur.top && g.font === curFont && g.shownColor === cur.color && g.greyed === cur.greyed && gap >= 0 && gap <= g.h) {
      if (gap > 0) cur.text += ' ';
      cur.text += String.fromCharCode(g.ch);
      cur.right = g.left + g.w;
    } else {
      cur = { text: String.fromCharCode(g.ch), left: g.left, top: g.top, right: g.left + g.w, h: g.h, color: g.shownColor, greyed: g.greyed };
      curFont = g.font;
      runs.push(cur);
    }
  }
  return runs;
}

/** Draws the pixels marked in `mask` (the mouse cursor) from the EGA frame on top of everything. */
export function drawMasked(ctx: TextContext, frame: Uint8Array, mask: Uint8Array, palette: [number, number, number][]): void {
  const S = AI_SCALE;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const [r, g, b] = palette[frame[i] & 15];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect((i % 320) * S, Math.floor(i / 320) * S, S, S);
  }
}

/** Draws runs with the smooth font, fitted to the width the original text occupied. */
export function drawRuns(ctx: TextContext, runs: TextRun[], palette: [number, number, number][]): void {
  const S = AI_SCALE;
  ctx.textBaseline = 'alphabetic';
  for (const r of runs) {
    const size = Math.round(r.h * S * (r.size ?? 1.08));
    ctx.font = `600 ${size}px ${TEXT_FONT_FAMILY}`;
    const [red, g, b] = palette[r.color & 15];
    ctx.fillStyle = `rgb(${red},${g},${b})`;
    ctx.globalAlpha = r.greyed ? 0.5 : 1;
    const target = (r.right - r.left) * S;
    const natural = ctx.measureText(r.text).width || 1;
    // Stretch or squeeze a little so lines keep their original length.
    const sx = Math.max(0.75, Math.min(r.maxStretch ?? 1.3, target / natural));
    ctx.save();
    ctx.translate(r.left * S, (r.top + r.h * 0.78) * S);
    ctx.scale(sx, 1);
    ctx.fillText(r.text, 0, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
