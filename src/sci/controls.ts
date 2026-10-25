// SCI0 dialog controls (kDrawControl / kHiliteControl / kEditControl), ported from ScummVM's
// GfxControls16 + _k_GenericDrawControl. SQ3 1.018 is SCI0 "late" (not SCI0 early), so buttons use the
// port colors and highlighting uses the invert pen mode.

import type { SciVM } from './vm';
import type { SciGfx, Rect } from './gfx';
import { rect } from './gfx';
import { mk, segOf, offOf, s16 } from './vm';
import { SciText, ALIGN_CENTER, ALIGN_LEFT } from './text';

export const CTL_BUTTON = 1;
export const CTL_TEXT = 2;
export const CTL_TEXTEDIT = 3;
export const CTL_ICON = 4;
export const CTL_LIST = 6;
export const CTL_LIST_ALIAS = 7;
export const CTL_DUMMY = 10;

export const STYLE_ENABLED = 0x0001;
export const STYLE_DISABLED = 0x0004;
export const STYLE_SELECTED = 0x0008;

const EV_MOUSE_DOWN = 1;
const EV_KEY_DOWN = 4;
const KEY_BACKSPACE = 8;
const KEY_ETX = 3;
const KEY_HOME = 71 << 8;
const KEY_END = 79 << 8;
const KEY_LEFT = 75 << 8;
const KEY_RIGHT = 77 << 8;
const KEY_DELETE = 83 << 8;
const MOD_CTRL = 4;

const grow = (r: Rect, n: number): Rect => ({ top: r.top - n, left: r.left - n, bottom: r.bottom + n, right: r.right + n });

export class SciControls {
  private cursorRect: Rect = rect(0, 0, 0, 0);
  private cursorVisible = false;
  private blinkTime = 0;

  constructor(
    private vm: SciVM,
    private gfx: SciGfx,
    private text: SciText,
    private now: () => number,
  ) {}

  private sel(obj: number, name: string): number {
    return s16(this.vm.getSel(obj, name));
  }

  /** Draws (hilite=false) or highlights (hilite=true) a control object. */
  draw(obj: number, hilite: boolean): void {
    const vm = this.vm;
    const type = this.sel(obj, 'type');
    const style = this.sel(obj, 'state');
    const x = this.sel(obj, 'nsLeft');
    const y = this.sel(obj, 'nsTop');
    let x1 = this.sel(obj, 'nsRight');
    let y1 = this.sel(obj, 'nsBottom');
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    const r = rect(y, x, y1, x1);
    const fontId = this.sel(obj, 'font');
    const textRef = vm.getSel(obj, 'text');
    const text = textRef && segOf(textRef) ? vm.getString(textRef) : '';
    switch (type) {
      case CTL_BUTTON:
        this.drawButton(r, text, fontId, style, hilite);
        return;
      case CTL_TEXT:
        this.drawText(r, text, fontId, this.sel(obj, 'mode'), style, hilite);
        return;
      case CTL_TEXTEDIT: {
        let cursorPos = this.sel(obj, 'cursor');
        if (cursorPos > text.length) {
          cursorPos = text.length;
          vm.setSel(obj, 'cursor', cursorPos);
        }
        this.drawTextEdit(r, text, fontId, style, cursorPos);
        return;
      }
      case CTL_ICON: {
        const view = this.sel(obj, 'view');
        const l = vm.getSel(obj, 'loop') & 0xff;
        const c = vm.getSel(obj, 'cel') & 0xff;
        const loop = l & 0x80 ? l - 256 : l;
        const cel = c & 0x80 ? c - 256 : c;
        const priority = vm.hasSel(obj, 'priority') ? this.sel(obj, 'priority') : -1;
        this.drawIcon(r, view, loop, cel, priority, style, hilite);
        return;
      }
      case CTL_LIST:
      case CTL_LIST_ALIAS: {
        const isAlias = type === CTL_LIST_ALIAS;
        const maxChars = this.sel(obj, 'x');
        const cursorOffset = vm.getSel(obj, 'cursor') & 0xffff;
        let upperOffset: number;
        if (vm.sel('topString') >= 0) upperOffset = vm.getSel(obj, 'topString') & 0xffff;
        else if (vm.hasSel(obj, 'brTop')) upperOffset = vm.getSel(obj, 'brTop') & 0xffff;
        else upperOffset = vm.getSel(obj, 'lsTop') & 0xffff;
        const entries: string[] = [];
        let upperPos = 0;
        let cursorPos = 0;
        if (textRef && segOf(textRef) && maxChars > 0) {
          let seeker = textRef;
          for (;;) {
            const s = vm.getString(seeker);
            if (!s.length) break;
            if (offOf(seeker) === upperOffset) upperPos = entries.length;
            if (offOf(seeker) === cursorOffset) cursorPos = entries.length;
            entries.push(s);
            seeker = mk(segOf(seeker), offOf(seeker) + maxChars);
          }
        }
        if (!hilite) {
          this.drawListControl(r, maxChars, entries, fontId, upperPos, cursorPos, isAlias);
          const rr = grow(r, 1);
          if (isAlias && style & STYLE_SELECTED) this.gfx.frameRect(rr);
          if (!this.gfx.screen.picNotValid) this.gfx.bitsShow(rr);
        }
        return;
      }
      default:
        return; // DUMMY and unknown types draw nothing
    }
  }

  private drawButton(r: Rect, text: string, fontId: number, style: number, hilite: boolean): void {
    const gfx = this.gfx;
    if (!hilite) {
      let rr = grow(r, 1);
      gfx.eraseRect(rr);
      gfx.frameRect(rr);
      rr = grow(rr, -2);
      gfx.curPort.greyedOutput = !(style & STYLE_ENABLED);
      this.text.box(text, false, rr, ALIGN_CENTER, fontId);
      gfx.curPort.greyedOutput = false;
      rr = grow(rr, 1);
      if (style & STYLE_SELECTED) gfx.frameRect(rr);
      if (!gfx.screen.picNotValid) gfx.bitsShow(grow(rr, 1));
    } else {
      gfx.invertRect(r);
      gfx.bitsShow(r);
    }
  }

  private drawText(r: Rect, text: string, fontId: number, alignment: number, style: number, hilite: boolean): void {
    const gfx = this.gfx;
    if (!hilite) {
      gfx.eraseRect(grow(r, 1));
      this.text.box(text, false, r, alignment, fontId);
      if (style & STYLE_SELECTED) gfx.frameRect(r);
      if (!gfx.screen.picNotValid) gfx.bitsShow(r);
    } else {
      gfx.invertRect(r);
      gfx.bitsShow(r);
    }
  }

  private drawTextEdit(r: Rect, text: string, fontId: number, style: number, cursorPos: number): void {
    const gfx = this.gfx;
    const oldFont = gfx.curPort.fontId;
    let rr = grow(r, 1);
    this.cursorVisible = false;
    this.cursorErase();
    gfx.eraseRect(rr);
    this.text.box(text, false, r, ALIGN_LEFT, fontId);
    gfx.frameRect(rr);
    if (style & STYLE_SELECTED) {
      this.text.setFont(fontId);
      rr = grow(rr, -1);
      this.cursorDraw(rr, text, cursorPos);
      this.text.setFont(oldFont);
      rr = grow(rr, 1);
    }
    if (!gfx.screen.picNotValid) gfx.bitsShow(rr);
  }

  private drawIcon(r: Rect, view: number, loop: number, cel: number, priority: number, style: number, hilite: boolean): void {
    const gfx = this.gfx;
    if (!hilite) {
      // drawCelAndShow
      try {
        const c = gfx.cel(view, loop, cel);
        const celRect = rect(r.top, r.left, r.top + c.height, r.left + c.width);
        gfx.drawCel(view, loop, cel, celRect, priority & 0xff);
        if (!gfx.screen.picNotValid) gfx.bitsShow(celRect);
      } catch {
        // missing view: Sierra would have errored; draw nothing
      }
      if (style & 0x20) gfx.frameRect(r);
      if (!gfx.screen.picNotValid) gfx.bitsShow(r);
    } else {
      gfx.invertRect(r);
      gfx.bitsShow(r);
    }
  }

  private drawListControl(r: Rect, maxChars: number, entries: string[], fontId: number, upperPos: number, cursorPos: number, isAlias: boolean): void {
    const gfx = this.gfx;
    const port = gfx.curPort;
    const oldFont = port.fontId;
    let w = { ...r };
    gfx.eraseRect(w);
    w = grow(w, 1);
    gfx.frameRect(w);
    // ScummVM draws the up arrow one pixel lower than Sierra ("looks nicer"); we follow Sierra.
    this.text.box('\x18', false, w, ALIGN_CENTER, 0);
    w.top = w.bottom - 10;
    this.text.box('\x19', false, w, ALIGN_CENTER, 0);
    w.top = r.top + 9;
    w.bottom -= 10;
    gfx.frameRect(w);
    w = grow(w, -1);
    this.text.setFont(fontId);
    const fontSize = port.fontHeight;
    w.bottom = w.top + fontSize;
    const lastY = r.bottom - fontSize;
    for (let i = upperPos; i < entries.length; i++) {
      gfx.eraseRect(w);
      const e = entries[i];
      if (e.length) {
        this.text.moveTo(w.left, w.top);
        this.text.draw(e, 0, Math.min(maxChars, e.length));
        if (!isAlias && i === cursorPos) gfx.invertRect(w);
      }
      w = { top: w.top + fontSize, left: w.left, bottom: w.bottom + fontSize, right: w.right };
      if (w.bottom > lastY) break;
    }
    this.text.setFont(oldFont);
  }

  // ---------------------------------------------------------------- edit control

  private cursorDraw(r: Rect, text: string, curPos: number): void {
    if (this.cursorVisible) return;
    const gfx = this.gfx;
    const f = gfx.font(gfx.curPort.fontId);
    let w = 0;
    for (let i = 0; i < curPos && i < text.length; i++) w += f.charWidth(text.charCodeAt(i) & 0xff);
    const cr = this.cursorRect;
    cr.left = r.left + w;
    cr.top = r.top;
    cr.bottom = cr.top + f.height;
    cr.right = cr.left + (curPos >= text.length ? 1 : f.charWidth(text.charCodeAt(curPos) & 0xff));
    gfx.invertRect(cr);
    gfx.bitsShow(cr);
    this.cursorVisible = true;
    this.setBlinkTime();
  }

  private cursorErase(): void {
    if (this.cursorVisible) {
      this.gfx.invertRect(this.cursorRect);
      this.gfx.bitsShow(this.cursorRect);
      this.cursorVisible = false;
    }
    this.setBlinkTime();
  }

  private setBlinkTime(): void {
    this.blinkTime = this.now() + (30 * 1000) / 60;
  }

  /** kEditControl: applies one event (or none) to a text-edit control; blinks the cursor. */
  edit(obj: number, eventObj: number): void {
    const vm = this.vm;
    if (!obj || this.sel(obj, 'type') !== CTL_TEXTEDIT) return;
    let cursorPos = vm.getSel(obj, 'cursor') & 0xffff;
    const maxChars = vm.getSel(obj, 'max') & 0xffff;
    const textRef = vm.getSel(obj, 'text');
    if (!textRef || !segOf(textRef)) return;
    let text = vm.getString(textRef);
    let changed = false;
    let addChar = false;
    let key = 0;
    if (eventObj) {
      const size = text.length;
      const type = vm.getSel(eventObj, 'type') & 0xffff;
      if (type === EV_MOUSE_DOWN) {
        // Not implemented by Sierra's SCI0 either (ScummVM: TODO)
      } else if (type === EV_KEY_DOWN) {
        key = vm.getSel(eventObj, 'message') & 0xffff;
        const mods = vm.getSel(eventObj, 'modifiers') & 0xffff;
        switch (key) {
          case KEY_BACKSPACE:
            if (cursorPos > 0) {
              cursorPos--;
              text = text.slice(0, cursorPos) + text.slice(cursorPos + 1);
              changed = true;
            }
            break;
          case KEY_DELETE:
            if (cursorPos < size) {
              text = text.slice(0, cursorPos) + text.slice(cursorPos + 1);
              changed = true;
            }
            break;
          case KEY_HOME:
            cursorPos = 0;
            changed = true;
            break;
          case KEY_END:
            cursorPos = size;
            changed = true;
            break;
          case KEY_LEFT:
            if (cursorPos > 0) {
              cursorPos--;
              changed = true;
            }
            break;
          case KEY_RIGHT:
            if (cursorPos + 1 <= size) {
              cursorPos++;
              changed = true;
            }
            break;
          case KEY_ETX:
            if (mods & MOD_CTRL) {
              cursorPos = 0;
              text = '';
              changed = true;
            }
            break;
          default:
            if (mods & MOD_CTRL && key === 99) {
              cursorPos = 0;
              text = '';
              changed = true;
            } else if (key > 31 && key < 256 && size < maxChars) {
              addChar = true;
              changed = true;
            }
        }
      }
    }
    const gfx = this.gfx;
    if (changed) {
      const oldFont = gfx.curPort.fontId;
      const fontId = this.sel(obj, 'font');
      const r = rect(this.sel(obj, 'nsTop'), this.sel(obj, 'nsLeft'), this.sel(obj, 'nsBottom'), this.sel(obj, 'nsRight'));
      this.text.setFont(fontId);
      if (addChar) {
        const f = gfx.font(gfx.curPort.fontId);
        let w = 0;
        for (let i = 0; i < text.length; i++) w += f.charWidth(text.charCodeAt(i) & 0xff);
        w += f.charWidth(key);
        if (w >= r.right - r.left) {
          this.text.setFont(oldFont);
          return;
        }
        text = text.slice(0, cursorPos) + String.fromCharCode(key) + text.slice(cursorPos);
        cursorPos++;
      }
      this.cursorErase();
      gfx.eraseRect(r);
      this.text.box(text, false, r, ALIGN_LEFT, -1);
      gfx.bitsShow(r);
      this.cursorDraw(r, text, cursorPos);
      this.text.setFont(oldFont);
      vm.setString(textRef, text);
    } else if (this.now() >= this.blinkTime) {
      gfx.invertRect(this.cursorRect);
      gfx.bitsShow(this.cursorRect);
      this.cursorVisible = !this.cursorVisible;
      this.setBlinkTime();
    }
    vm.setSel(obj, 'cursor', cursorPos);
  }
}
