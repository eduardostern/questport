// The 320x200 display: picture area (160x168 doubled horizontally), a text layer
// for status/input/display() text, an optional message window, and full-screen modal layers.

import { FONT8X8 } from './font';
import { PIC_W, PIC_H } from './picture';

export const SCREEN_W = 320;
export const SCREEN_H = 200;
const T = 255; // transparent in the text layer

export interface TextWindow {
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
  col: number;
  lines: string[];
}

/** A character cell: valid bit, character, foreground and background color (see Screen.cell). */
export const CELL_VALID = 1 << 20;
export const cellChar = (c: number) => c & 0xff;
export const cellFg = (c: number) => (c >> 8) & 15;
export const cellBg = (c: number) => (c >> 12) & 0xff;

export class Screen {
  pixels = new Uint8Array(SCREEN_W * SCREEN_H);
  /**
   * What drew each pixel of `pixels` after compose (for the AI images mode): 0 = room picture,
   * > 0 = sprite placement id, -1 = anything else.
   */
  owner = new Int32Array(SCREEN_W * SCREEN_H);
  /** Characters visible after compose, 40x25 (0 = none). Text drawn on `pixels` later is in cells(pixels). */
  visibleCells = new Int32Array(40 * 25);
  /** Screen rectangle of the message window drawn by the last compose, if any. */
  windowRect: { top: number; left: number; bottom: number; right: number } | null = null;
  private cellMaps = new WeakMap<Uint8Array, Int32Array>();

  /** Character cells drawn on a layer (40x25). */
  cells(layer: Uint8Array): Int32Array {
    let c = this.cellMaps.get(layer);
    if (!c) {
      c = new Int32Array(40 * 25);
      this.cellMaps.set(layer, c);
    }
    return c;
  }
  text = new Uint8Array(SCREEN_W * SCREEN_H).fill(T);
  picRow = 1;
  textMode = false;
  textModeBg = 0;
  window: TextWindow | null = null;
  modal: Uint8Array | null = null; // full screen layer (inventory, text screens)
  shakeOffset = 0;

  /** Marks the picture area as transparent and other rows as black. */
  resetTextLayer(): void {
    const top = this.picRow * 8;
    for (let y = 0; y < SCREEN_H; y++) {
      const inPic = y >= top && y < top + PIC_H;
      this.text.fill(inPic ? T : 0, y * SCREEN_W, (y + 1) * SCREEN_W);
    }
    this.cells(this.text).fill(0);
  }

  /** Clears any text drawn over the picture area (done on show.pic). */
  clearPicAreaText(): void {
    const top = this.picRow * 8;
    this.text.fill(T, top * SCREEN_W, (top + PIC_H) * SCREEN_W);
    this.cells(this.text).fill(0, this.picRow * 40, Math.min(25, this.picRow + PIC_H / 8) * 40);
  }

  drawChar(layer: Uint8Array, row: number, col: number, ch: number, fg: number, bg: number): void {
    if (row < 0 || row >= 25 || col < 0 || col >= 40) return;
    this.cells(layer)[row * 40 + col] = CELL_VALID | (ch & 0xff) | ((fg & 15) << 8) | ((bg & 0xff) << 12);
    const g = (ch & 0x7f) * 8;
    for (let y = 0; y < 8; y++) {
      const bits = FONT8X8[g + y];
      const o = (row * 8 + y) * SCREEN_W + col * 8;
      for (let x = 0; x < 8; x++) layer[o + x] = bits & (1 << x) ? fg : bg;
    }
  }

  drawText(row: number, col: number, s: string, fg: number, bg: number, layer: Uint8Array = this.text): void {
    for (let i = 0; i < s.length; i++) this.drawChar(layer, row, col + i, s.charCodeAt(i), fg, bg);
  }

  clearRows(top: number, bottom: number, color: number, layer: Uint8Array = this.text): void {
    for (let y = top * 8; y < (bottom + 1) * 8 && y < SCREEN_H; y++) {
      layer.fill(color, y * SCREEN_W, (y + 1) * SCREEN_W);
    }
    this.cells(layer).fill(0, Math.max(0, top) * 40, Math.min(25, bottom + 1) * 40);
  }

  clearRect(r1: number, c1: number, r2: number, c2: number, color: number): void {
    for (let y = r1 * 8; y < (r2 + 1) * 8 && y < SCREEN_H; y++) {
      this.text.fill(color, y * SCREEN_W + c1 * 8, y * SCREEN_W + Math.min(40, c2 + 1) * 8);
    }
    const cells = this.cells(this.text);
    for (let r = Math.max(0, r1); r <= Math.min(24, r2); r++) cells.fill(0, r * 40 + Math.max(0, c1), r * 40 + Math.min(40, c2 + 1));
  }

  /** Builds a message window at a text position. */
  makeWindow(lines: string[], row: number, col: number): TextWindow {
    const w = Math.max(1, ...lines.map((l) => l.length));
    const h = lines.length;
    return { x: col * 8 - 6, y: row * 8 - 5, w: w * 8 + 12, h: h * 8 + 10, row, col, lines };
  }

  private drawWindow(win: TextWindow, out: Uint8Array): void {
    const x0 = Math.max(0, win.x);
    const y0 = Math.max(0, win.y);
    const x1 = Math.min(SCREEN_W, win.x + win.w);
    const y1 = Math.min(SCREEN_H, win.y + win.h);
    for (let y = y0; y < y1; y++) out.fill(15, y * SCREEN_W + x0, y * SCREEN_W + x1);
    // red border inset by 2px horizontally and 1px vertically
    const bx0 = x0 + 2, bx1 = x1 - 3, by0 = y0 + 1, by1 = y1 - 2;
    for (let x = bx0; x <= bx1; x++) {
      out[by0 * SCREEN_W + x] = 4;
      out[by1 * SCREEN_W + x] = 4;
    }
    for (let y = by0; y <= by1; y++) {
      out[y * SCREEN_W + bx0] = 4;
      out[y * SCREEN_W + bx0 + 1] = 4;
      out[y * SCREEN_W + bx1] = 4;
      out[y * SCREEN_W + bx1 - 1] = 4;
    }
    win.lines.forEach((l, i) => this.drawText(win.row + i, win.col, l, 0, 15, out));
  }

  /** Composes all layers into `pixels`. frame is the 160x168 picture+sprites buffer. */
  compose(frame: Uint8Array, frameOwner?: Int32Array): Uint8Array {
    const out = this.pixels;
    this.cells(out).fill(0);
    this.windowRect = null;
    this.owner.fill(-1);
    if (this.modal) {
      out.set(this.modal);
      this.visibleCells.set(this.cells(this.modal));
      return out;
    }
    this.visibleCells.set(this.cells(this.text));
    if (this.textMode) {
      for (let i = 0; i < out.length; i++) out[i] = this.text[i] === T ? this.textModeBg : this.text[i];
      return out;
    }
    out.fill(0);
    const top = this.picRow * 8;
    for (let y = 0; y < PIC_H; y++) {
      const sy = top + y;
      if (sy >= SCREEN_H) break;
      const so = sy * SCREEN_W;
      const fo = y * PIC_W;
      for (let x = 0; x < PIC_W; x++) {
        const c = frame[fo + x];
        out[so + x * 2] = c;
        out[so + x * 2 + 1] = c;
        if (frameOwner) {
          const o = frameOwner[fo + x];
          this.owner[so + x * 2] = o;
          this.owner[so + x * 2 + 1] = o;
        }
      }
    }
    for (let i = 0; i < out.length; i++) {
      if (this.text[i] !== T) {
        out[i] = this.text[i];
        this.owner[i] = -1;
      }
    }
    if (this.window) {
      this.drawWindow(this.window, out);
      const w = this.window;
      this.windowRect = { top: Math.max(0, w.y), left: Math.max(0, w.x), bottom: Math.min(SCREEN_H, w.y + w.h), right: Math.min(SCREEN_W, w.x + w.w) };
      // The window's text was drawn on `out`; it is part of what is visible.
      const wc = this.cells(out);
      for (let i = 0; i < wc.length; i++) if (wc[i]) this.visibleCells[i] = wc[i];
      wc.fill(0);
    }
    return out;
  }
}

/** Word-wraps text to a maximum line width. Honors explicit newlines. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      let w = word;
      while (w.length > width) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ' ' + w;
      else {
        lines.push(line);
        line = w;
      }
    }
    lines.push(line);
  }
  // Trim trailing spaces and a trailing empty line
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l.replace(/\s+$/, ''));
}
