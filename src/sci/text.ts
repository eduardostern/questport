// SCI0 text layout and drawing (Sierra's TextSize / GetLongest / TextBox / ShowText),
// ported from ScummVM's GfxText16. SCI0 has no |c|/|f| text codes (those are SCI1.1+),
// so '|' is an ordinary character here. SQ3 1.018 uses the "early" GetLongest rules.

import type { SciGfx, Rect } from './gfx';
import { rect, rectWidth } from './gfx';

export const ALIGN_RIGHT = -1;
export const ALIGN_LEFT = 0;
export const ALIGN_CENTER = 1;

/** SCI0 interpreters (incl. SQ3 1.018) used the early GetLongest width test. */
const EARLY_GET_LONGEST = true;

export class SciText {
  constructor(private gfx: SciGfx) {}

  private get port() {
    return this.gfx.curPort;
  }

  private font() {
    return this.gfx.font(this.port.fontId);
  }

  setFont(id: number): void {
    this.gfx.setFont(id);
  }

  moveTo(left: number, top: number): void {
    this.port.curLeft = left;
    this.port.curTop = top;
  }

  /**
   * Returns how many chars of `text` starting at `pos` fit in maxWidth (breaking at spaces), and the
   * position where the next line starts. Line breaks (\r, \n, \r\n) are included in the count.
   */
  getLongest(text: string, pos: number, maxWidth: number): { count: number; next: number } {
    const f = this.font();
    const prevFont = this.port.fontId;
    const prevPen = this.port.penClr;
    let p = pos;
    let lastSpacePtr = -1;
    let lastSpaceCount = 0;
    let count = 0;
    let tempWidth = 0;
    const at = (i: number) => (i < text.length ? text.charCodeAt(i) & 0xff : 0);
    const restore = () => {
      this.setFont(prevFont);
      this.port.penClr = prevPen;
    };
    for (;;) {
      const c = at(p);
      if (c === 0x0d || c === 0x0a || c === 0) {
        if (c === 0x0d && at(p + 1) === 0x0a) {
          count++;
          p++;
        }
        if (c !== 0) {
          count++;
          p++;
        }
        restore();
        return { count, next: p };
      }
      if (c === 0x20) {
        lastSpaceCount = count;
        lastSpacePtr = p + 1;
      }
      tempWidth += f.charWidth(c);
      if (tempWidth > maxWidth) break;
      if (EARLY_GET_LONGEST && lastSpaceCount === 0 && tempWidth === maxWidth) break;
      count++;
      p++;
    }
    let result: number;
    if (lastSpaceCount) {
      result = lastSpaceCount;
      p = lastSpacePtr;
      while (at(p) === 0x20) p++;
    } else {
      if (EARLY_GET_LONGEST) {
        count++;
        p++;
      }
      result = count;
    }
    restore();
    return { count: result, next: p };
  }

  /** Width/height of `len` chars of text starting at `from` (line breaks only add height). */
  width(text: string, from: number, len: number): { w: number; h: number } {
    const f = this.font();
    let w = 0;
    let h = 0;
    for (let i = from; i < from + len && i < text.length; i++) {
      const c = text.charCodeAt(i) & 0xff;
      h = Math.max(h, this.port.fontHeight);
      if (c !== 0x0a && c !== 0x0d) w += f.charWidth(c);
    }
    return { w, h };
  }

  stringWidth(text: string): { w: number; h: number } {
    return this.width(text, 0, text.length);
  }

  /**
   * Sierra's TextSize: bounding rect of text. maxWidth < 0 forces a single line; 0 means default (192).
   * fontId -1 uses the current port font.
   */
  size(text: string, fontId: number, maxWidth: number): Rect {
    const prevFont = this.port.fontId;
    const prevPen = this.port.penClr;
    if (fontId !== -1) this.setFont(fontId);
    const r = rect(0, 0, 0, 0);
    if (maxWidth < 0) {
      const { w, h } = this.stringWidth(text);
      r.bottom = h;
      r.right = w;
    } else {
      r.right = maxWidth ? maxWidth : 192;
      let p = 0;
      let line = 0;
      let total = 0;
      let maxTextWidth = 0;
      while (p < text.length) {
        const { count, next } = this.getLongest(text, p, r.right);
        if (count === 0) break;
        p = next;
        const { w, h } = this.width(text, line, count);
        maxTextWidth = Math.max(maxTextWidth, w);
        total += h;
        line = p;
      }
      r.bottom = total;
      r.right = maxWidth ? maxWidth : Math.min(r.right, maxTextWidth);
    }
    this.setFont(prevFont);
    this.port.penClr = prevPen;
    return r;
  }

  /** Draws chars at the pen position (no screen update). */
  draw(text: string, from: number, len: number): void {
    const p = this.port;
    const f = this.font();
    for (let i = from; i < from + len && i < text.length; i++) {
      const c = text.charCodeAt(i) & 0xff;
      if (c === 0x0a || c === 0x0d || c === 0) continue;
      const cw = f.charWidth(c);
      if (p.penMode === 1) this.gfx.eraseRect(rect(p.curTop, p.curLeft, p.curTop + p.fontHeight, p.curLeft + cw));
      f.draw(this.gfx.screen, c, p.top + p.curTop, p.left + p.curLeft, p.penClr, p.greyedOutput);
      p.curLeft += cw;
    }
  }

  /** Draws chars and copies them to the output. */
  show(text: string, from: number, len: number): void {
    const p = this.port;
    const r = rect(p.curTop, p.curLeft, p.curTop + p.fontHeight, 0);
    this.draw(text, from, len);
    r.right = p.curLeft;
    this.gfx.bitsShow(r);
  }

  drawString(text: string): void {
    const prevFont = this.port.fontId;
    const prevPen = this.port.penClr;
    this.draw(text, 0, text.length);
    this.setFont(prevFont);
    this.port.penClr = prevPen;
  }

  /** Status line drawing: every byte (even 0x0a) is a glyph. */
  drawStatus(text: string): void {
    const p = this.port;
    const f = this.font();
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i) & 0xff;
      if (c === 0) continue;
      f.draw(this.gfx.screen, c, p.top + p.curTop, p.left + p.curLeft, p.penClr, p.greyedOutput);
      p.curLeft += f.charWidth(c);
    }
  }

  /** Sierra's TextBox: word-wrapped text in a rect with alignment. */
  box(text: string, show: boolean, r: Rect, alignment: number, fontId: number): void {
    const prevFont = this.port.fontId;
    const prevPen = this.port.penClr;
    if (fontId !== -1) this.setFont(fontId);
    const w = rectWidth(r);
    let p = 0;
    let line = 0;
    let hline = 0;
    let offset = 0;
    while (p < text.length) {
      const { count, next } = this.getLongest(text, p, w);
      if (count === 0) break;
      p = next;
      const tw = this.width(text, line, count);
      if (alignment === ALIGN_RIGHT) offset = w - tw.w;
      else if (alignment === ALIGN_CENTER) offset = Math.trunc((w - tw.w) / 2);
      else if (alignment === ALIGN_LEFT) offset = 0;
      this.moveTo(r.left + offset, r.top + hline);
      if (show) this.show(text, line, count);
      else this.draw(text, line, count);
      hline += tw.h;
      line = p;
    }
    this.setFont(prevFont);
    this.port.penClr = prevPen;
  }
}
