// Pictures, cast animation, cels, collision and movement.
// Faithful port of Sierra's SCI0 behavior via ScummVM's GfxAnimate (animate.cpp), GfxCompare
// (compare.cpp), GfxPaint16::kernelDrawPicture/kernelDrawCel and kgraphics.cpp, using the
// "new" SCI0 graphics functions (SQ3 1.018: pic window at top=10, inverted kDrawPic addTo flag).

import type { SciContext } from '../context';
import { s16, num, offOf } from '../vm';
import { Rect, rect, rectClip, rectEmpty, Window, Port } from '../gfx';
import { MASK_VIS, MASK_PRI, MASK_CTL } from '../screen';
import { SciTransitions } from '../transitions';
import { registerMovement } from '../movement';

export const SIGNAL = {
  STOP_UPDATE: 0x0001,
  VIEW_UPDATED: 0x0002,
  NO_UPDATE: 0x0004,
  HIDDEN: 0x0008,
  FIXED_PRIORITY: 0x0010,
  ALWAYS_UPDATE: 0x0020,
  FORCE_UPDATE: 0x0040,
  REMOVE_VIEW: 0x0080,
  FROZEN: 0x0100,
  HIT_OBSTACLE: 0x0400,
  DOESNT_TURN: 0x0800,
  IGNORE_ACTOR: 0x4000,
  DISPOSE_ME: 0x8000,
};
const S = SIGNAL;
const MASK_ALL = MASK_VIS | MASK_PRI | MASK_CTL;

interface AnimateEntry {
  object: number;
  givenOrderNo: number;
  viewId: number;
  loopNo: number;
  celNo: number;
  x: number;
  y: number;
  z: number;
  priority: number;
  signal: number;
  celRect: Rect;
  showBitsFlag: boolean;
  castHandle: number;
}

const clip16 = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function registerAnimation(ctx: SciContext): void {
  const { vm, gfx } = ctx;
  const scr = gfx.screen;
  const k = vm.kernelImpl;
  const transitions = new SciTransitions(scr);

  let list: AnimateEntry[] = [];
  let lastCast: AnimateEntry[] = [];

  // ---------------------------------------------------------------- selector helpers

  const sel = new Map<string, number>();
  const selId = (name: string): number => {
    let id = sel.get(name);
    if (id === undefined) {
      id = vm.sel(name);
      sel.set(name, id);
    }
    return id;
  };
  /** Index of a selector's variable in an object (-1 if it has none). */
  const varIdx = (obj: number, name: string): number => {
    const o = vm.getObject(obj);
    const id = selId(name);
    if (!o || id < 0) return -1;
    return vm.varIndex(o, id);
  };
  const getU = (obj: number, name: string): number => {
    const o = vm.getObject(obj);
    if (!o) return 0;
    const i = vm.varIndex(o, selId(name));
    return i >= 0 ? (o.vars[i] ?? 0) & 0xffff : 0;
  };
  const getS = (obj: number, name: string): number => s16(getU(obj, name));
  const getRaw = (obj: number, name: string): number => {
    const o = vm.getObject(obj);
    if (!o) return 0;
    const i = vm.varIndex(o, selId(name));
    return i >= 0 ? o.vars[i] ?? 0 : 0;
  };
  const setV = (obj: number, name: string, v: number): void => {
    const o = vm.getObject(obj);
    if (!o) return;
    const i = vm.varIndex(o, selId(name));
    if (i >= 0) o.vars[i] = num(v);
  };
  const setRaw = (obj: number, name: string, v: number): void => {
    const o = vm.getObject(obj);
    if (!o) return;
    const i = vm.varIndex(o, selId(name));
    if (i >= 0) o.vars[i] = v;
  };

  const setNSRect = (obj: number, r: Rect): void => {
    setV(obj, 'nsLeft', r.left);
    setV(obj, 'nsTop', r.top);
    setV(obj, 'nsRight', r.right);
    setV(obj, 'nsBottom', r.bottom);
  };

  const withPort = <T>(p: Port, fn: () => T): T => {
    const old = gfx.setPort(p);
    try {
      return fn();
    } finally {
      gfx.setPort(old);
    }
  };

  const loopCount = (view: number): number => gfx.view(view).loops.length;
  const celCount = (view: number, loop: number): number => {
    const v = gfx.view(view);
    return v.loops[clip16(loop, 0, v.loops.length - 1)].cels.length;
  };

  /** fillRect on the control screen under a cel's base (GfxAnimate's IgnoreActor handling). */
  const fillControlUnder = (celRect: Rect, priority: number, control: number): void => {
    const r = { ...celRect };
    r.top = clip16(scr.priorityToCoordinate(priority & 0xff) - 1, r.top, r.bottom - 1);
    gfx.fillRect(r, MASK_CTL, 0, 0, control);
  };

  // ---------------------------------------------------------------- windows interplay (ports.cpp)

  const isFrontWindow = (w: Port): boolean => gfx.windowList[gfx.windowList.length - 1] === w;

  const updateWindow = (w: Port): void => {
    if (!(w instanceof Window)) return;
    if (w.saveScreenMask && w.drawn) {
      let h = gfx.bitsSave(w.restoreRect, MASK_VIS);
      gfx.bitsRestore(w.hSaved1);
      w.hSaved1 = h;
      if (w.saveScreenMask & MASK_PRI) {
        h = gfx.bitsSave(w.restoreRect, MASK_PRI);
        gfx.bitsRestore(w.hSaved2);
        w.hSaved2 = h;
      }
    }
  };

  const beginUpdate = (w: Port): void => {
    withPort(gfx.wmgrPort, () => {
      const idx = gfx.windowList.indexOf(w);
      for (let i = gfx.windowList.length - 1; i > idx; i--) updateWindow(gfx.windowList[i]);
    });
  };

  const endUpdate = (w: Port): void => {
    withPort(gfx.wmgrPort, () => {
      const idx = gfx.windowList.indexOf(w);
      for (let i = idx + 1; i < gfx.windowList.length; i++) updateWindow(gfx.windowList[i]);
      // SCI0: kernelGraphRedrawBox(curPort->rect) -- wmgr-local rect to picWind-local
      const p = gfx.curPort;
      const r = p.rect;
      const pic = gfx.picWind;
      const local = rect(r.top + p.top - pic.top, r.left + p.left - pic.left, r.bottom + p.top - pic.top, r.right + p.left - pic.left);
      withPort(pic, () => reAnimateLocal(local));
    });
  };

  // ---------------------------------------------------------------- GfxAnimate

  /** ScummVM GfxAnimate::reAnimate with a rect in the current (pic window) port's coordinates. */
  const reAnimateLocal = (r: Rect): void => {
    if (lastCast.length) {
      for (const e of lastCast) {
        e.castHandle = gfx.bitsSave(e.celRect, MASK_VIS | MASK_PRI);
        gfx.drawCel(e.viewId, e.loopNo, e.celNo, e.celRect, e.priority & 0xff);
      }
      gfx.bitsShow(r);
      for (let i = lastCast.length - 1; i >= 0; i--) gfx.bitsRestore(lastCast[i].castHandle);
    } else gfx.bitsShow(r);
  };

  /** Hook for the windows module: rect in screen coordinates. */
  ctx.hooks.reAnimate = (screenRect: Rect): void => {
    const pic = gfx.picWind;
    withPort(pic, () =>
      reAnimateLocal(rect(screenRect.top - pic.top, screenRect.left - pic.left, screenRect.bottom - pic.top, screenRect.right - pic.left)),
    );
  };

  const invokeCast = (listRef: number): boolean => {
    const l = vm.list(listRef);
    if (!l) return true;
    let curAddress = l.first;
    let curNode = vm.node(curAddress);
    while (curNode) {
      const obj = curNode.value;
      const signal = getU(obj, 'signal');
      if (!(signal & S.FROZEN)) {
        vm.invoke(obj, 'doit');
        if (vm.abort) return false;
        curNode = vm.node(curAddress);
      }
      if (curNode) {
        curAddress = curNode.succ;
        curNode = vm.node(curAddress);
      }
    }
    return true;
  };

  const makeSortedList = (listRef: number): void => {
    list = [];
    lastCast = [];
    const l = vm.list(listRef);
    if (!l) throw new Error('kAnimate called with non-list as parameter');
    let addr = l.first;
    let node = vm.node(addr);
    for (let n = 0; node; n++) {
      const obj = node.value;
      list.push({
        object: obj,
        givenOrderNo: n,
        viewId: getU(obj, 'view'),
        loopNo: getS(obj, 'loop'),
        celNo: getS(obj, 'cel'),
        x: getS(obj, 'x'),
        y: getS(obj, 'y'),
        z: getS(obj, 'z'),
        priority: getS(obj, 'priority'),
        signal: getU(obj, 'signal'),
        celRect: rect(0, 0, 0, 0),
        showBitsFlag: false,
        castHandle: 0,
      });
      addr = node.succ;
      node = vm.node(addr);
    }
    list.sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      if (a.z !== b.z) return a.z - b.z;
      return a.givenOrderNo - b.givenOrderNo;
    });
  };

  const fill = (oldPicNotValid: number): number => {
    for (const e of list) {
      const view = gfx.view(e.viewId);
      // adjustInvalidCels
      const lc = view.loops.length;
      if (e.loopNo >= lc) {
        e.loopNo = 0;
        setV(e.object, 'loop', 0);
      } else if (e.loopNo < 0) e.loopNo = lc - 1;
      const cc = view.loops[e.loopNo].cels.length;
      if (e.celNo >= cc) {
        e.celNo = 0;
        setV(e.object, 'cel', 0);
      } else if (e.celNo < 0) e.celNo = cc - 1;

      e.celRect = gfx.celRect(e.viewId, e.loopNo, e.celNo, e.x, e.y, e.z);
      setNSRect(e.object, e.celRect);

      if (!(e.signal & S.FIXED_PRIORITY)) {
        e.priority = scr.coordinateToPriority(e.y);
        setV(e.object, 'priority', e.priority);
      }

      if (e.signal & S.NO_UPDATE) {
        if (
          e.signal & (S.FORCE_UPDATE | S.VIEW_UPDATED) ||
          (e.signal & S.HIDDEN && !(e.signal & S.REMOVE_VIEW)) ||
          (!(e.signal & S.HIDDEN) && e.signal & S.REMOVE_VIEW) ||
          e.signal & S.ALWAYS_UPDATE
        )
          oldPicNotValid = (oldPicNotValid + 1) & 0xff;
        e.signal &= ~S.STOP_UPDATE;
      } else {
        if (e.signal & S.STOP_UPDATE || e.signal & S.ALWAYS_UPDATE) oldPicNotValid = (oldPicNotValid + 1) & 0xff;
        e.signal &= ~S.FORCE_UPDATE;
      }
    }
    return oldPicNotValid;
  };

  const update = (): void => {
    // Remove all no-update cels
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.signal & S.NO_UPDATE) {
        if (!(e.signal & S.REMOVE_VIEW)) {
          const h = getRaw(e.object, 'underBits');
          if (scr.picNotValid !== 1) {
            gfx.bitsRestore(h);
            e.showBitsFlag = true;
          } else gfx.bitsFree(h);
          setV(e.object, 'underBits', 0);
        }
        e.signal &= ~S.FORCE_UPDATE;
        if (e.signal & S.VIEW_UPDATED) e.signal &= ~(S.VIEW_UPDATED | S.NO_UPDATE);
      } else if (e.signal & S.STOP_UPDATE) {
        e.signal &= ~S.STOP_UPDATE;
        e.signal |= S.NO_UPDATE;
      }
    }
    // Draw always-update cels
    for (const e of list) {
      if (e.signal & S.ALWAYS_UPDATE) {
        gfx.drawCel(e.viewId, e.loopNo, e.celNo, e.celRect, e.priority & 0xff);
        e.showBitsFlag = true;
        e.signal &= ~(S.STOP_UPDATE | S.VIEW_UPDATED | S.NO_UPDATE | S.FORCE_UPDATE);
        if (!(e.signal & S.IGNORE_ACTOR)) fillControlUnder(e.celRect, e.priority, 15);
      }
    }
    // Save background for all no-update cels
    for (const e of list) {
      if (e.signal & S.NO_UPDATE) {
        if (e.signal & S.HIDDEN) e.signal |= S.REMOVE_VIEW;
        else {
          e.signal &= ~S.REMOVE_VIEW;
          const h = gfx.bitsSave(e.celRect, e.signal & S.IGNORE_ACTOR ? MASK_VIS | MASK_PRI : MASK_ALL);
          setRaw(e.object, 'underBits', h);
        }
      }
    }
    // Draw no-update cels
    for (const e of list) {
      if (e.signal & S.NO_UPDATE && !(e.signal & S.HIDDEN)) {
        gfx.drawCel(e.viewId, e.loopNo, e.celNo, e.celRect, e.priority & 0xff);
        e.showBitsFlag = true;
        if (!(e.signal & S.IGNORE_ACTOR)) fillControlUnder(e.celRect, e.priority, 15);
      }
    }
  };

  const drawCels = (): void => {
    lastCast = [];
    for (const e of list) {
      if (!(e.signal & (S.NO_UPDATE | S.HIDDEN | S.ALWAYS_UPDATE))) {
        const h = gfx.bitsSave(e.celRect, MASK_ALL);
        setRaw(e.object, 'underBits', h);
        gfx.drawCel(e.viewId, e.loopNo, e.celNo, e.celRect, e.priority & 0xff);
        e.showBitsFlag = true;
        if (e.signal & S.REMOVE_VIEW) e.signal &= ~S.REMOVE_VIEW;
        lastCast.push({ ...e, celRect: { ...e.celRect } });
      }
    }
  };

  const updateScreen = (oldPicNotValid: number, show: boolean): void => {
    for (const e of list) {
      if (
        e.showBitsFlag ||
        !(
          e.signal & (S.REMOVE_VIEW | S.NO_UPDATE) ||
          (!(e.signal & S.REMOVE_VIEW) && e.signal & S.NO_UPDATE && oldPicNotValid)
        )
      ) {
        const ls = rect(getS(e.object, 'lsTop'), getS(e.object, 'lsLeft'), getS(e.object, 'lsBottom'), getS(e.object, 'lsRight'));
        let worker: Rect;
        if (!rectEmpty(rectClip(ls, e.celRect))) {
          worker = {
            top: Math.min(ls.top, e.celRect.top),
            left: Math.min(ls.left, e.celRect.left),
            bottom: Math.max(ls.bottom, e.celRect.bottom),
            right: Math.max(ls.right, e.celRect.right),
          };
        } else {
          if (show) gfx.bitsShow(ls);
          worker = e.celRect;
        }
        setV(e.object, 'lsLeft', e.celRect.left);
        setV(e.object, 'lsTop', e.celRect.top);
        setV(e.object, 'lsRight', e.celRect.right);
        setV(e.object, 'lsBottom', e.celRect.bottom);
        if (show) gfx.bitsShow(worker);
        if (e.signal & S.HIDDEN) e.signal |= S.REMOVE_VIEW;
      }
    }
  };

  const restoreAndDelete = (): void => {
    for (const e of list) setV(e.object, 'signal', e.signal);
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!vm.isObject(e.object)) continue;
      e.signal = getU(e.object, 'signal');
      if ((e.signal & (S.NO_UPDATE | S.REMOVE_VIEW)) === 0) {
        gfx.bitsRestore(getRaw(e.object, 'underBits'));
        setV(e.object, 'underBits', 0);
      }
      if (e.signal & S.DISPOSE_ME) vm.invoke(e.object, 'delete');
    }
  };

  /** Shows the new picture with its transition; makes the VM wait while it plays. */
  const animateShowPic = (): void => {
    const pic = gfx.picWind;
    const r = pic.rect;
    const picRect = rect(r.top + pic.top, r.left + pic.left, r.bottom + pic.top, r.right + pic.left);
    const now = ctx.now();
    const duration = transitions.doit(picRect, now);
    if (duration > 0) {
      vm.yieldRequested = true;
      vm.waitUntil = Math.max(vm.waitUntil, now + duration);
    }
    ctx.hooks.present?.();
  };

  const kernelAnimate = (listRef: number, cycle: boolean): void => {
    const oldPicNotValid0 = scr.picNotValid;
    if (!listRef) {
      lastCast = [];
      if (scr.picNotValid) animateShowPic();
      return;
    }
    if (!vm.list(listRef)) throw new Error('kAnimate called with non-list as parameter');
    if (cycle && !invokeCast(listRef)) return;

    const oldPort = gfx.setPort(gfx.picWind);
    try {
      lastCast = [];
      makeSortedList(listRef);
      const oldPicNotValid = fill(oldPicNotValid0);
      if (oldPicNotValid) update();
      drawCels();
      let showedPic = false;
      if (scr.picNotValid) {
        animateShowPic();
        showedPic = true;
      }
      // While a transition is revealing the picture area (which contains every cel rect), the
      // individual bitsShow calls would only spoil it; the transition shows the same pixels.
      updateScreen(oldPicNotValid, !showedPic || !scr.pendingTransition);
      restoreAndDelete();
    } finally {
      gfx.setPort(oldPort);
    }
  };

  // ---------------------------------------------------------------- AddToPic

  const addToPicDrawCels = (): void => {
    for (const e of list) {
      if (e.priority === -1) e.priority = scr.coordinateToPriority(e.y);
      e.celRect = gfx.celRect(e.viewId, e.loopNo, e.celNo, e.x, e.y, e.z);
      gfx.drawCel(e.viewId, e.loopNo, e.celNo, e.celRect, e.priority & 0xff);
      if (!(e.signal & S.IGNORE_ACTOR)) {
        e.celRect.top = clip16(scr.priorityToCoordinate(e.priority & 0xff) - 1, e.celRect.top, e.celRect.bottom - 1);
        gfx.fillRect(e.celRect, MASK_CTL, 0, 0, 15);
      }
    }
  };

  // ---------------------------------------------------------------- GfxCompare

  const isOnControl = (screenMask: number, r: Rect): number => {
    if (rectEmpty(r)) return 0;
    let result = 0;
    const buf = screenMask & MASK_PRI ? scr.priority : scr.control;
    for (let y = r.top; y < r.bottom; y++) {
      const o = y * 320;
      for (let x = r.left; x < r.right; x++) result |= 1 << buf[o + x];
    }
    return result & 0xffff;
  };

  /** Clips a pic-window-relative rect and converts it to screen coordinates. */
  const onControlRect = (r: Rect): Rect => withPort(gfx.picWind, () => gfx.offsetRect(rectClip(r, gfx.picWind.rect)));

  const brRect = (obj: number): Rect => rect(getS(obj, 'brTop'), getS(obj, 'brLeft'), getS(obj, 'brBottom'), getS(obj, 'brRight'));

  const canBeHereCheckRectList = (checkObject: number, checkRect: Rect, listRef: number, signalFlags: number): number => {
    const l = vm.list(listRef);
    if (!l) return 0;
    let addr = l.first;
    let node = vm.node(addr);
    while (node) {
      const obj = node.value;
      if (obj !== checkObject) {
        const signal = getU(obj, 'signal');
        if (!(signal & signalFlags)) {
          const r = brRect(obj);
          if (r.right > checkRect.left && r.left < checkRect.right && r.bottom > checkRect.top && r.top < checkRect.bottom) return obj;
        }
      }
      addr = node.succ;
      node = vm.node(addr);
    }
    return 0;
  };

  // ---------------------------------------------------------------- kernel functions

  k.set('DrawPic', (_vm, a) => {
    const picNr = offOf(a[0]);
    let animationNr = -1;
    let blackout = false;
    let mirrored = false;
    let addTo = false;
    let paletteNo = 0;
    if (a.length >= 2) {
      const flags = a[1] & 0xffff;
      if (flags & 0x8000) blackout = true;
      animationNr = flags & 0xff;
      if (flags & 0x4000) mirrored = true;
    }
    if (a.length >= 3) {
      addTo = a[2] !== 0;
      addTo = !addTo; // new SCI0 graphics functions invert the flag
    }
    if (a.length >= 4) paletteNo = offOf(a[3]);

    withPort(gfx.picWind, () => {
      if (isFrontWindow(gfx.picWind)) {
        scr.picNotValid = 1;
        gfx.drawPicture(picNr, mirrored, addTo, paletteNo);
        transitions.setup(animationNr, blackout);
      } else {
        beginUpdate(gfx.picWind);
        gfx.drawPicture(picNr, mirrored, addTo, paletteNo);
        endUpdate(gfx.picWind);
      }
    });
    return undefined;
  });

  k.set('PicNotValid', (_vm, a) => {
    const old = scr.picNotValid;
    if (a.length > 0) scr.picNotValid = s16(a[0]);
    return num(old);
  });

  k.set('Animate', (_vm, a) => {
    const listRef = a.length > 0 ? a[0] : 0;
    const cycle = a.length > 1 ? (a[1] & 0xffff) !== 0 : false;
    kernelAnimate(listRef, cycle);
    return undefined;
  });

  k.set('SetNowSeen', (_vm, a) => {
    const obj = a[0];
    const r = gfx.celRect(getU(obj, 'view'), getS(obj, 'loop'), getS(obj, 'cel'), getS(obj, 'x'), getS(obj, 'y'), getS(obj, 'z'));
    if (varIdx(obj, 'nsTop') >= 0) setNSRect(obj, r);
    return undefined;
  });

  k.set('NumLoops', (_vm, a) => loopCount(getU(a[0], 'view')));
  k.set('NumCels', (_vm, a) => celCount(getU(a[0], 'view'), getS(a[0], 'loop')));
  k.set('CelWide', (_vm, a) => {
    const v = s16(a[0]);
    if (v === -1) return 0;
    return gfx.cel(v, s16(a[1]), a.length >= 3 ? s16(a[2]) : 0).width;
  });
  k.set('CelHigh', (_vm, a) => {
    const v = s16(a[0]);
    if (v === -1) return 0;
    return gfx.cel(v, s16(a[1]), a.length >= 3 ? s16(a[2]) : 0).height;
  });

  k.set('DrawCel', (_vm, a) => {
    const viewId = s16(a[0]);
    const loopNo = s16(a[1]);
    const celNo = s16(a[2]);
    const x = s16(a[3]);
    const y = s16(a[4]);
    const priority = a.length > 5 ? s16(a[5]) : -1;
    const c = gfx.cel(viewId, loopNo, celNo);
    const r = rect(y, x, y + c.height, x + c.width);
    gfx.drawCel(viewId, loopNo, celNo, r, priority & 0xff);
    if (!scr.picNotValid) gfx.bitsShow(r);
    return undefined;
  });

  k.set('AddToPic', (_vm, a) => {
    if (a.length === 1) {
      if (!a[0]) return undefined;
      gfx.setPort(gfx.picWind);
      makeSortedList(a[0]);
      addToPicDrawCels();
      scr.picNotValid = 1;
    } else if (a.length >= 7) {
      gfx.setPort(gfx.picWind);
      const viewId = a[0] & 0xffff;
      const loopNo = s16(a[1]);
      const celNo = s16(a[2]);
      const x = s16(a[3]);
      const y = s16(a[4]);
      let priority = s16(a[5]);
      const control = s16(a[6]);
      if (priority === -1) priority = scr.coordinateToPriority(y);
      const r = gfx.celRect(viewId, loopNo, celNo, x, y, 0);
      gfx.drawCel(viewId, loopNo, celNo, r, priority & 0xff);
      if (control !== -1) {
        r.top = clip16(scr.priorityToCoordinate(priority & 0xff) - 1, r.top, r.bottom - 1);
        gfx.fillRect(r, MASK_CTL, 0, 0, control);
      }
      scr.picNotValid = 1;
    } else throw new Error(`kAddToPic with unsupported parameter count ${a.length}`);
    return undefined;
  });

  k.set('CanBeHere', (_vm, a) => {
    const obj = a[0];
    const listRef = a.length > 1 ? a[1] : 0;
    const checkRect = brRect(obj);
    const signal = getU(obj, 'signal');
    if (checkRect.left > checkRect.right || checkRect.top > checkRect.bottom) return 1;
    const result = isOnControl(MASK_CTL, onControlRect(checkRect)) & getU(obj, 'illegalBits');
    if (!result && (signal & (S.IGNORE_ACTOR | S.REMOVE_VIEW)) === 0) {
      if (!listRef) return 1;
      return canBeHereCheckRectList(obj, checkRect, listRef, S.IGNORE_ACTOR | S.REMOVE_VIEW | S.NO_UPDATE) ? 0 : 1;
    }
    return result ? 0 : 1;
  });

  k.set('OnControl', (_vm, a) => {
    let screenMask: number;
    let base = 0;
    if (a.length === 2 || a.length === 4) screenMask = MASK_CTL;
    else {
      screenMask = a[0] & 0xffff;
      base = 1;
    }
    const left = s16(a[base]);
    const top = s16(a[base + 1]);
    let right = left + 1;
    let bottom = top + 1;
    if (a.length > 3) {
      right = s16(a[base + 2]);
      bottom = s16(a[base + 3]);
    }
    return isOnControl(screenMask, onControlRect(rect(top, left, bottom, right)));
  });

  k.set('BaseSetter', (_vm, a) => {
    const obj = a[0];
    if (varIdx(obj, 'brLeft') < 0) return undefined;
    const x = getS(obj, 'x');
    const y = getS(obj, 'y');
    const z = getS(obj, 'z');
    const yStep = getS(obj, 'yStep');
    const r = gfx.celRect(getU(obj, 'view'), getS(obj, 'loop'), getS(obj, 'cel'), x, y, z);
    r.bottom = y + 1;
    r.top = r.bottom - yStep;
    setV(obj, 'brLeft', r.left);
    setV(obj, 'brRight', r.right);
    setV(obj, 'brTop', r.top);
    setV(obj, 'brBottom', r.bottom);
    return undefined;
  });

  k.set('CoordPri', (_vm, a) => {
    const y = s16(a[0]);
    if (a.length < 2 || y !== 1) return scr.coordinateToPriority(y);
    return num(scr.priorityToCoordinate(s16(a[1])));
  });

  registerMovement(ctx);
}

