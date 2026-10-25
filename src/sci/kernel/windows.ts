// Windows, text, controls, menus, status line, kGraph and cursor kernel functions (SCI0, "new" gfx
// functions as used by SQ3 1.018). Ported from ScummVM's GfxPorts/GfxPaint16/kgraphics/kmenu.
//
// Engine requirements (see SciContext):
//  - ctx.hooks.reAnimate(screenRect): provided by the animation module (falls back to just showing the rect).
//  - ctx.hooks.shakeScreen(count, dirs): optional, host animates the shake.
//  - ctx.waitInput(): optional synchronous queued-input source used by kMenuSelect's interactive loop.
//  - ctx.said(spec): optional said matcher for kMenuSelect on said events.
//  - While windows.menu.isOpen() is true (a menu pulled down and waiting for input), the engine must not
//    run the VM and must feed input events to windows.menu.feed(ev); see src/sci/menu.ts.

import type { SciContext } from '../context';
import { Port, Window, WINDOW_STYLE, rect } from '../gfx';
import type { Rect } from '../gfx';
import { SCREEN_W, SCREEN_H, MASK_VIS, MASK_PRI } from '../screen';
import { lookupText } from './core';
import { segOf, offOf, mk, num, s16 } from '../vm';
import { SciText } from '../text';
import { SciMenu } from '../menu';
import { SciControls } from '../controls';

const STYLE_USER = WINDOW_STYLE.USER | WINDOW_STYLE.TRANSPARENT; // SCI0: user style includes transparent
const FIRST_SCRIPT_WINDOW_ID = 3;

const DISPLAY_MOVEPEN = 100;
const DISPLAY_SETALIGNMENT = 101;
const DISPLAY_SETPENCOLOR = 102;
const DISPLAY_SETBACKGROUNDCOLOR = 103;
const DISPLAY_SETGREYEDOUTPUT = 104;
const DISPLAY_SETFONT = 105;
const DISPLAY_WIDTH = 106;
const DISPLAY_SAVEUNDER = 107;
const DISPLAY_RESTOREUNDER = 108;
const DISPLAY_DONTSHOWBITS = 121;

export class SciWindows {
  readonly text: SciText;
  readonly menu: SciMenu;
  readonly controls: SciControls;
  private freeCounter = 0;

  constructor(private ctx: SciContext) {
    const { gfx, vm } = ctx;
    this.text = new SciText(gfx);
    this.menu = new SciMenu({
      gfx,
      text: this.text,
      redrawBox: (r) => this.redrawBox(r),
      getString: (p) => (p && segOf(p) ? vm.getString(p) : ''),
      said: (spec) => (ctx.said ? ctx.said(spec) : false),
      setCursorVisible: (v) => {
        const old = ctx.mouse.visible;
        ctx.mouse.visible = v;
        return old;
      },
    });
    this.controls = new SciControls(vm, gfx, this.text, () => ctx.now());
  }

  private get gfx() {
    return this.ctx.gfx;
  }

  // ---------------------------------------------------------------- ports & windows

  /** Sierra's kGraph RedrawBox / ReAnimate: `r` is relative to the current port. */
  redrawBox(r: Rect): void {
    const gfx = this.gfx;
    const p = gfx.curPort;
    const screenRect = { top: r.top + p.top, left: r.left + p.left, bottom: r.bottom + p.top, right: r.right + p.left };
    const old = gfx.setPort(gfx.picWind);
    if (this.ctx.hooks.reAnimate) this.ctx.hooks.reAnimate(screenRect);
    else {
      const w = gfx.picWind;
      gfx.bitsShow({ top: screenRect.top - w.top, left: screenRect.left - w.left, bottom: screenRect.bottom - w.top, right: screenRect.right - w.left });
    }
    gfx.setPort(old);
  }

  addWindow(dims: Rect, restoreRect: Rect | null, title: string | null, style: number, priority: number, draw: boolean): Window {
    const gfx = this.gfx;
    let id = 2;
    while (id < gfx.windowsById.length && gfx.windowsById[id]) {
      const w = gfx.windowsById[id] as Window;
      if (w.counterTillFree) {
        this.freeWindow(w);
        this.freeCounter--;
        break;
      }
      id++;
    }
    const wnd = new Window(id);
    gfx.windowsById[id] = wnd;
    // SCI0 always adds windows to the front-most position (end of list).
    gfx.windowList.push(wnd);
    gfx.openPort(wnd);
    const r = { ...dims };
    r.left &= 0xfffe;
    if (r.right - r.left > SCREEN_W) {
      r.left = 0;
      r.right = SCREEN_W - 1;
      if (style !== STYLE_USER && !(style & WINDOW_STYLE.NOFRAME)) r.right--;
    }
    wnd.rect = r;
    if (restoreRect) wnd.restoreRect = { ...restoreRect };
    wnd.wndStyle = style;
    wnd.hSaved1 = wnd.hSaved2 = 0;
    wnd.drawn = false;
    if ((style & WINDOW_STYLE.TRANSPARENT) === 0) wnd.saveScreenMask = priority === -1 ? MASK_VIS : MASK_VIS | MASK_PRI;
    if (title && style & WINDOW_STYLE.TITLE) wnd.title = title;
    const d = { ...wnd.rect };
    if (style !== STYLE_USER && !(style & WINDOW_STYLE.NOFRAME)) {
      d.top--;
      d.left--;
      d.bottom++;
      d.right++;
      if (style & WINDOW_STYLE.TITLE) {
        d.top -= 10;
        d.bottom++;
      }
    }
    wnd.dims = d;
    const wm = gfx.wmgrPort.rect;
    const oldTop = d.top;
    const oldLeft = d.left;
    const moveTo = (x: Rect, left: number, top: number) => {
      const w = x.right - x.left;
      const h = x.bottom - x.top;
      x.left = left;
      x.top = top;
      x.right = left + w;
      x.bottom = top + h;
    };
    const rr = wnd.restoreRect;
    if (wm.top > d.top) {
      moveTo(d, d.left, wm.top);
      if (restoreRect) moveTo(rr, rr.left, wm.top);
    }
    if (wm.bottom < d.bottom) {
      moveTo(d, d.left, wm.bottom - d.bottom + d.top);
      if (restoreRect) moveTo(rr, rr.left, wm.bottom - rr.bottom + rr.top);
    }
    if (wm.right < d.right) {
      moveTo(d, wm.right + d.left - d.right, d.top);
      if (restoreRect) moveTo(rr, wm.right + rr.left - rr.right, rr.top);
    }
    if (wm.left > d.left) {
      moveTo(d, wm.left, d.top);
      if (restoreRect) moveTo(rr, wm.left, rr.top);
    }
    moveTo(wnd.rect, wnd.rect.left + d.left - oldLeft, wnd.rect.top + d.top - oldTop);
    if (!restoreRect) wnd.restoreRect = { ...d };
    if (draw) this.drawWindow(wnd);
    gfx.setPort(wnd);
    gfx.setOrigin(wnd.rect.left, wnd.rect.top + gfx.wmgrPort.top);
    moveTo(wnd.rect, 0, 0);
    return wnd;
  }

  drawWindow(wnd: Window): void {
    if (wnd.drawn) return;
    const gfx = this.gfx;
    const style = wnd.wndStyle;
    wnd.drawn = true;
    const old = gfx.setPort(gfx.wmgrPort);
    gfx.curPort.penClr = 0;
    if ((style & WINDOW_STYLE.TRANSPARENT) === 0) {
      wnd.hSaved1 = gfx.bitsSave(wnd.restoreRect, MASK_VIS);
      if (wnd.saveScreenMask & MASK_PRI) {
        wnd.hSaved2 = gfx.bitsSave(wnd.restoreRect, MASK_PRI);
        if ((style & WINDOW_STYLE.USER) === 0) gfx.fillRect(wnd.restoreRect, MASK_PRI, 0, 15);
      }
    }
    if (style !== STYLE_USER) {
      let r = { ...wnd.dims };
      if (!(style & WINDOW_STYLE.NOFRAME)) {
        r.top++;
        r.left++;
        gfx.frameRect(r); // shadow
        r = { top: r.top - 1, left: r.left - 1, bottom: r.bottom - 1, right: r.right - 1 };
        gfx.frameRect(r); // frame
        if (style & WINDOW_STYLE.TITLE) {
          r.bottom = r.top + 10;
          gfx.frameRect(r); // SCI0: black line between title bar and content
          r = { top: r.top + 1, left: r.left + 1, bottom: r.bottom - 1, right: r.right - 1 };
          gfx.fillRect(r, MASK_VIS, 8); // grey title bar
          if (wnd.title) {
            const oldPen = gfx.curPort.penClr;
            gfx.curPort.penClr = 15;
            this.text.box(wnd.title, true, r, 1, 0);
            gfx.curPort.penClr = oldPen;
          }
          r = { top: r.top - 1, left: r.left - 1, bottom: r.bottom + 1, right: r.right + 1 };
          r.bottom = wnd.dims.bottom - 1;
          r.top += 9;
        }
        r = { top: r.top + 1, left: r.left + 1, bottom: r.bottom - 1, right: r.right - 1 };
      }
      if (!(style & WINDOW_STYLE.TRANSPARENT)) gfx.fillRect(r, MASK_VIS, wnd.backClr);
      gfx.bitsShow(wnd.dims);
    }
    gfx.setPort(old);
  }

  removeWindow(wnd: Window, reanimate: boolean): void {
    const gfx = this.gfx;
    gfx.setPort(gfx.wmgrPort);
    gfx.bitsRestore(wnd.hSaved1);
    wnd.hSaved1 = 0;
    gfx.bitsRestore(wnd.hSaved2);
    wnd.hSaved2 = 0;
    if (!reanimate) gfx.bitsShow(wnd.restoreRect);
    else this.redrawBox(wnd.restoreRect);
    const i = gfx.windowList.indexOf(wnd);
    if (i >= 0) gfx.windowList.splice(i, 1);
    gfx.setPort(gfx.windowList[gfx.windowList.length - 1]);
    // Freed after 15 kSetPort calls (scripts sometimes use a just-disposed port once more).
    wnd.counterTillFree = 15;
    this.freeCounter++;
  }

  freeWindow(wnd: Window): void {
    const gfx = this.gfx;
    if (wnd.hSaved1) gfx.bitsFree(wnd.hSaved1);
    if (wnd.hSaved2) gfx.bitsFree(wnd.hSaved2);
    wnd.hSaved1 = wnd.hSaved2 = 0;
    gfx.windowsById[wnd.id] = null;
  }

  /** Frees all script windows (restart/restore), like ScummVM's GfxPorts::reset. */
  reset(): void {
    const gfx = this.gfx;
    gfx.setPort(gfx.picWind);
    for (let id = FIRST_SCRIPT_WINDOW_ID; id < gfx.windowsById.length; id++) {
      const w = gfx.windowsById[id];
      if (w) this.freeWindow(w as Window);
    }
    this.freeCounter = 0;
    gfx.windowList.length = 0;
    gfx.windowList.push(gfx.wmgrPort, gfx.picWind);
    this.menu.reset();
  }

  setActive(portId: number): void {
    const gfx = this.gfx;
    if (this.freeCounter) {
      for (let id = FIRST_SCRIPT_WINDOW_ID; id < gfx.windowsById.length; id++) {
        const w = gfx.windowsById[id] as Window | null;
        if (w && w.counterTillFree) {
          w.counterTillFree--;
          if (!w.counterTillFree) {
            this.freeWindow(w);
            this.freeCounter--;
          }
        }
      }
    }
    if (portId === 0) gfx.setPort(gfx.wmgrPort);
    else if (portId === 0xffff) gfx.setPort(gfx.menuPort);
    else {
      const p = gfx.portById(portId);
      if (p) gfx.setPort(p);
      else console.warn(`kSetPort: invalid port id ${portId}`);
    }
  }

  // ---------------------------------------------------------------- kDisplay

  display(text: string, argv: number[]): number {
    const gfx = this.gfx;
    const port = gfx.curPort;
    const saved = snapshotPort(port);
    let alignment = 0;
    let colorBack = -1;
    let width = -1;
    let redraw = true;
    let doSaveUnder = false;
    let result = 0;
    let r: Rect = rect(0, 0, 0, 0);
    port.penMode = 0;
    port.penClr = 0;
    port.greyedOutput = false;
    let i = 0;
    while (i < argv.length) {
      const a = argv[i++];
      const code = segOf(a) ? 0xffff : offOf(a);
      switch (code) {
        case DISPLAY_MOVEPEN:
          gfx.curPort.curLeft = s16(argv[i] ?? 0);
          gfx.curPort.curTop = s16(argv[i + 1] ?? 0);
          i += 2;
          break;
        case DISPLAY_SETALIGNMENT:
          alignment = s16(argv[i++] ?? 0);
          break;
        case DISPLAY_SETPENCOLOR:
          gfx.curPort.penClr = offOf(argv[i++] ?? 0);
          break;
        case DISPLAY_SETBACKGROUNDCOLOR:
          colorBack = offOf(argv[i++] ?? 0);
          break;
        case DISPLAY_SETGREYEDOUTPUT:
          gfx.curPort.greyedOutput = (argv[i++] ?? 0) !== 0;
          break;
        case DISPLAY_SETFONT:
          this.text.setFont(offOf(argv[i++] ?? 0));
          break;
        case DISPLAY_WIDTH:
          width = s16(argv[i++] ?? 0);
          break;
        case DISPLAY_SAVEUNDER:
          doSaveUnder = true;
          break;
        case DISPLAY_RESTOREUNDER: {
          const h = argv[i] ?? 0;
          const br = gfx.bitsRect(h);
          if (br) {
            r = { top: br.top - gfx.curPort.top, left: br.left - gfx.curPort.left, bottom: br.bottom - gfx.curPort.top, right: br.right - gfx.curPort.left };
            gfx.bitsRestore(h);
            this.redrawBox(r);
          }
          i = argv.length;
          break;
        }
        case DISPLAY_DONTSHOWBITS:
          redraw = false;
          break;
        default:
          warnOnce(`kDisplay: unknown argument ${code}`);
      }
    }
    const cur = gfx.curPort;
    r = this.text.size(text, -1, width);
    const h = r.bottom - r.top;
    const w = r.right - r.left;
    r = rect(cur.curTop, cur.curLeft, cur.curTop + h, cur.curLeft + w);
    if (doSaveUnder) result = gfx.bitsSave(r, MASK_VIS);
    if (colorBack !== -1) gfx.fillRect(r, MASK_VIS, colorBack, 0, 0);
    this.text.box(text, false, r, alignment, -1);
    if (!gfx.screen.picNotValid && redraw) gfx.bitsShow(r);
    // SCI0 "new gfx functions": restore the port settings, keep the pen position.
    const tTop = cur.curTop;
    const tLeft = cur.curLeft;
    restorePort(cur, saved);
    cur.curTop = tTop;
    cur.curLeft = tLeft;
    return result;
  }
}

function snapshotPort(p: Port) {
  return {
    top: p.top, left: p.left, rect: { ...p.rect }, fontId: p.fontId, fontHeight: p.fontHeight,
    greyedOutput: p.greyedOutput, penClr: p.penClr, backClr: p.backClr, penMode: p.penMode,
  };
}

function restorePort(p: Port, s: ReturnType<typeof snapshotPort>): void {
  p.top = s.top;
  p.left = s.left;
  p.rect = s.rect;
  p.fontId = s.fontId;
  p.fontHeight = s.fontHeight;
  p.greyedOutput = s.greyedOutput;
  p.penClr = s.penClr;
  p.backClr = s.backClr;
  p.penMode = s.penMode;
}

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

/** Graph rect from (top, left, bottom, right) args, normalized. */
function graphRect(a: number[], i: number): Rect {
  let y = s16(a[i] ?? 0);
  let x = s16(a[i + 1] ?? 0);
  let y1 = s16(a[i + 2] ?? 0);
  let x1 = s16(a[i + 3] ?? 0);
  if (x > x1) [x, x1] = [x1, x];
  if (y > y1) [y, y1] = [y1, y];
  return rect(y, x, y1, x1);
}

export function registerWindows(ctx: SciContext): SciWindows {
  const { vm, gfx } = ctx;
  const w = new SciWindows(ctx);
  const k = vm.kernelImpl;
  const str = (r: number) => (r && segOf(r) ? vm.getString(r) : '');

  // ---------------------------------------------------------------- ports

  k.set('GetPort', () => gfx.curPort.id & 0xffff);

  k.set('SetPort', (_vm, a) => {
    if (a.length >= 6) {
      const pw = gfx.picWind;
      pw.rect = rect(s16(a[0]), s16(a[1]), s16(a[2]), s16(a[3]));
      pw.top = s16(a[4]);
      pw.left = s16(a[5]);
      if (a.length >= 7) gfx.screen.initPriorityBands(14, 42, 190);
      return undefined;
    }
    w.setActive(offOf(a[0] ?? 0));
    return undefined;
  });

  k.set('NewWindow', (_vm, a) => {
    // SCI0: (top left bottom right title style [priority] [fore] [back])
    const dims = rect(s16(a[0]), s16(a[1]), s16(a[2]), s16(a[3]));
    const title = str(a[4] ?? 0);
    const style = s16(a[5] ?? 0);
    const priority = a.length > 6 ? s16(a[6]) : -1;
    const pen = a.length > 7 ? s16(a[7]) & 0x0f : 0;
    const back = a.length > 8 ? s16(a[8]) & 0x0f : 15;
    const wnd = w.addWindow(dims, null, title, style & 0xffff, priority, false);
    wnd.penClr = pen;
    wnd.backClr = back;
    w.drawWindow(wnd);
    return wnd.id;
  });

  k.set('DisposeWindow', (_vm, a) => {
    const id = offOf(a[0] ?? 0);
    const reanimate = a.length !== 2 || a[1] === 0;
    const wnd = gfx.portById(id);
    if (wnd instanceof Window && id >= 2 && !wnd.counterTillFree) w.removeWindow(wnd, reanimate);
    else console.warn(`kDisposeWindow: bad window id ${id}`);
    return undefined;
  });

  k.set('GlobalToLocal', (_vm, a) => {
    const obj = a[0] ?? 0;
    if (segOf(obj)) {
      vm.setSel(obj, 'x', num(s16(vm.getSel(obj, 'x')) - gfx.curPort.left));
      vm.setSel(obj, 'y', num(s16(vm.getSel(obj, 'y')) - gfx.curPort.top));
    }
    return undefined;
  });

  k.set('LocalToGlobal', (_vm, a) => {
    const obj = a[0] ?? 0;
    if (segOf(obj)) {
      vm.setSel(obj, 'x', num(s16(vm.getSel(obj, 'x')) + gfx.curPort.left));
      vm.setSel(obj, 'y', num(s16(vm.getSel(obj, 'y')) + gfx.curPort.top));
    }
    return undefined;
  });

  // ---------------------------------------------------------------- text

  k.set('TextSize', (_vm, a) => {
    const dest = a[0] ?? 0;
    if (!segOf(dest)) return undefined;
    const text = str(a[1] ?? 0);
    const font = s16(a[2] ?? 0);
    const maxWidth = a.length > 3 ? offOf(a[3]) : 0;
    const put = (i: number, v: number) => vm.writeWord(mk(segOf(dest), offOf(dest) + i * 2), num(v));
    put(0, 0);
    put(1, 0);
    if (!text.length) {
      put(2, 0);
      put(3, 0);
      return undefined;
    }
    const r = w.text.size(text, font, s16(maxWidth) < 0 ? s16(maxWidth) : maxWidth);
    put(2, r.bottom - r.top);
    put(3, r.right - r.left);
    return undefined;
  });

  k.set('Display', (_vm, a) => {
    let text: string;
    let rest: number[];
    if (segOf(a[0] ?? 0)) {
      text = vm.getString(a[0]);
      rest = a.slice(1);
    } else {
      text = lookupText(vm, a[0] ?? 0, offOf(a[1] ?? 0));
      rest = a.slice(2);
    }
    return w.display(text, rest);
  });

  // ---------------------------------------------------------------- controls

  k.set('DrawControl', (_vm, a) => {
    w.controls.draw(a[0] ?? 0, false);
    return 0;
  });
  k.set('HiliteControl', (_vm, a) => {
    w.controls.draw(a[0] ?? 0, true);
    return undefined;
  });
  k.set('EditControl', (_vm, a) => {
    w.controls.edit(a[0] ?? 0, a[1] ?? 0);
    return undefined;
  });

  // ---------------------------------------------------------------- menus & status line

  k.set('AddMenu', (_vm, a) => {
    w.menu.addEntry(str(a[0] ?? 0), str(a[1] ?? 0), a[1] ?? 0);
    return undefined;
  });

  k.set('SetMenu', (_vm, a) => {
    const menuId = (offOf(a[0] ?? 0) >> 8) & 0xff;
    const itemId = offOf(a[0] ?? 0) & 0xff;
    for (let i = 1; i < a.length; i += 2) w.menu.setAttribute(menuId, itemId, offOf(a[i]), a[i + 1] ?? 0);
    return undefined;
  });

  k.set('GetMenu', (_vm, a) => {
    const menuId = (offOf(a[0] ?? 0) >> 8) & 0xff;
    const itemId = offOf(a[0] ?? 0) & 0xff;
    return w.menu.getAttribute(menuId, itemId, offOf(a[1] ?? 0));
  });

  k.set('DrawStatus', (_vm, a) => {
    const t = a[0] ?? 0;
    if (!t) return undefined;
    const pen = a.length > 1 ? s16(a[1]) : 0;
    const back = a.length > 2 ? s16(a[2]) : 15;
    w.menu.drawStatus(str(t), pen & 0xff, back & 0xff);
    return undefined;
  });

  k.set('DrawMenuBar', (_vm, a) => {
    if (a[0]) w.menu.drawMenuBar();
    else w.menu.drawStatus('', 0, 0);
    return undefined;
  });

  k.set('MenuSelect', (_vm, a) => {
    const ev = a[0] ?? 0;
    const e = {
      type: vm.getSel(ev, 'type') & 0xffff,
      message: vm.getSel(ev, 'message') & 0xffff,
      modifiers: vm.getSel(ev, 'modifiers') & 0xffff,
      x: s16(vm.getSel(ev, 'x')),
      y: s16(vm.getSel(ev, 'y')),
    };
    const r = w.menu.select(e, ctx.waitInput);
    if (r.claimed) vm.setSel(ev, 'claimed', 1);
    return r.result;
  });

  // ---------------------------------------------------------------- kGraph

  k.set('Graph', (_vm, a) => {
    const op = offOf(a[0] ?? 0);
    const args = a.slice(1);
    switch (op) {
      case 2: // GetColorCount
        return 16;
      case 4: { // DrawLine(y0 x0 y1 x1 color [pri] [ctl])
        const color = s16(args[4] ?? 0) & 0x0f;
        const pri = args.length > 5 ? s16(args[5]) & 0xff : 255;
        const ctl = args.length > 6 ? s16(args[6]) & 0xff : 255;
        const p = gfx.curPort;
        const clipX = (v: number) => Math.min(Math.max(v, p.rect.left), p.rect.right - 1);
        const clipY = (v: number) => Math.min(Math.max(v, p.rect.top), p.rect.bottom - 1);
        const x0 = clipX(s16(args[1] ?? 0)) + p.left;
        const y0 = clipY(s16(args[0] ?? 0)) + p.top;
        const x1 = clipX(s16(args[3] ?? 0)) + p.left;
        const y1 = clipY(s16(args[2] ?? 0)) + p.top;
        gfx.screen.drawLine(x0, y0, x1, y1, color, pri, ctl);
        return undefined;
      }
      case 7: // SaveBox(rect mask)
        return gfx.bitsSave(graphRect(args, 0), offOf(args[4] ?? 0) & 7);
      case 8: // RestoreBox(handle)
        gfx.bitsRestore(args[0] ?? 0);
        return undefined;
      case 9:
        gfx.eraseRect(graphRect(args, 0));
        return undefined;
      case 10:
        gfx.paintRect(graphRect(args, 0));
        return undefined;
      case 11: // FillBoxAny(rect mask color pri ctl)
        gfx.fillRect(graphRect(args, 0), offOf(args[4] ?? 0), s16(args[5] ?? 0) & 0x0f, s16(args[6] ?? 0), s16(args[7] ?? 0));
        return undefined;
      case 12: // UpdateBox(rect [map])
        if (args.length <= 5 || !args[5]) gfx.bitsShow(graphRect(args, 0));
        return undefined;
      case 13: // RedrawBox(rect)
        w.redrawBox(graphRect(args, 0));
        return undefined;
      case 14: // AdjustPriority(top bottom)
        gfx.screen.initPriorityBands(14, offOf(args[0] ?? 0), offOf(args[1] ?? 0));
        return undefined;
      default: // 1 load bits, 3 set palette, 5 nop, 6 draw pattern: unused/no-ops in SCI0 EGA
        return undefined;
    }
  });

  // ---------------------------------------------------------------- cursor & misc

  k.set('SetCursor', (_vm, a) => {
    // SCI0: (cursor [show] [x y])
    let cursorId = s16(a[0] ?? 0);
    if (a.length >= 4) {
      const x = s16(a[2]) + gfx.curPort.left;
      const y = s16(a[3]) + gfx.curPort.top;
      if (x <= SCREEN_W && y <= SCREEN_H && ctx.mouse.visible) {
        ctx.mouse.x = x;
        ctx.mouse.y = y;
      }
    }
    if (a.length >= 2 && s16(a[1]) === 0) cursorId = -1;
    if (cursorId === -1) ctx.mouse.visible = false;
    else {
      ctx.mouse.view = cursorId;
      ctx.mouse.loop = 0;
      ctx.mouse.cel = 0;
      ctx.mouse.visible = true;
    }
    return undefined;
  });

  k.set('Show', (_vm, a) => {
    // Debug: show a screen map. 1 = visual, 2 = priority, 3/4 = control.
    const map = offOf(a[0] ?? 0);
    const s = gfx.screen;
    if (map === 1) s.copyToOutput(0, 0, SCREEN_W, SCREEN_H);
    else if (map === 2) s.output.set(s.priority);
    else if (map === 3 || map === 4) s.output.set(s.control);
    s.outputDirty = true;
    return undefined;
  });

  k.set('ShakeScreen', (_vm, a) => {
    const count = a.length > 0 ? offOf(a[0]) : 1;
    const dirs = a.length > 1 ? offOf(a[1]) : 1;
    ctx.hooks.shakeScreen?.(count, dirs);
    return undefined;
  });

  return w;
}
