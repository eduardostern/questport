// Core kernel functions: scripts & objects, lists, math, strings, time, and misc stubs.

import { SciVM, mk, segOf, offOf, s16, num, isNum, SciError } from '../vm';
import { ResType } from '../resource';

export interface CoreContext {
  vm: SciVM;
  /** Milliseconds since an arbitrary epoch. */
  now(): number;
}

/** Looks up text either from a heap string pointer or from a text resource (number + index). */
export function lookupText(vm: SciVM, r: number, index: number): string {
  if (!isNum(r)) return vm.getString(r);
  const data = vm.res.get(ResType.Text, offOf(r));
  if (!data) return '';
  let i = 0;
  let p = 0;
  while (i < index && p < data.length) {
    if (data[p++] === 0) i++;
  }
  let s = '';
  while (p < data.length && data[p]) s += String.fromCharCode(data[p++]);
  return s;
}

export function sciFormat(vm: SciVM, argv: number[], startIndex: number): string {
  const position = argv[startIndex];
  let start: number;
  let source: string;
  if (segOf(position)) {
    start = startIndex + 1;
    source = vm.getString(position);
  } else {
    start = startIndex + 2;
    source = lookupText(vm, position, offOf(argv[startIndex + 1] ?? 0));
  }
  const args = argv.slice(start);
  let out = '';
  let pi = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== '%') {
      out += ch;
      continue;
    }
    i++;
    if (source[i] === '%') {
      out += '%';
      continue;
    }
    let fill = ' ';
    let align = 0; // 0 none, 1 right, -1 left, 2 center
    let width = 0;
    if (/[0-9=-]/.test(source[i] ?? '')) {
      if (source[i] === '0') fill = '0';
      if (source[i] === '=') {
        align = 2;
        i++;
      }
      const m = /^-?\d+/.exec(source.slice(i));
      if (m) {
        width = Number(m[0]);
        i += m[0].length;
      }
      if (width < 0) {
        align = -1;
        width = -width;
      } else if (align !== 2) align = 1;
    }
    const conv = source[i];
    let piece = '';
    switch (conv) {
      case 's': {
        const r = args[pi] ?? 0;
        piece = lookupText(vm, r, offOf(args[pi + 1] ?? 0));
        pi += segOf(r) ? 1 : 2;
        break;
      }
      case 'c': {
        const c = offOf(args[pi++] ?? 0) & 0xff;
        piece = c ? String.fromCharCode(c) : '';
        break;
      }
      case 'd':
        piece = String(s16(args[pi++] ?? 0));
        break;
      case 'u':
        piece = String(offOf(args[pi++] ?? 0));
        break;
      case 'x':
        piece = offOf(args[pi++] ?? 0).toString(16);
        break;
      default:
        piece = '%' + (conv ?? '');
    }
    if (width > piece.length) {
      const pad = width - piece.length;
      if (align === -1) piece = piece + ' '.repeat(pad);
      else if (align === 2) piece = ' '.repeat(pad >> 1) + piece + ' '.repeat(pad - (pad >> 1));
      else piece = (conv === 's' ? ' ' : fill).repeat(pad) + piece;
    }
    out += piece;
  }
  return out;
}

function angleSci0(x1: number, y1: number, x2: number, y2: number): number {
  let xRel = x2 - x1;
  let yRel = y1 - y2;
  if (y1 < y2) yRel = -yRel;
  if (x2 < x1) xRel = -xRel;
  if (yRel === 0 && xRel === 0) return 0;
  let angle = Math.trunc((100 * xRel) / (xRel + yRel));
  if (y1 < y2) angle = 200 - angle;
  if (x2 < x1) angle = 400 - angle;
  angle -= Math.trunc((angle + 9) / 10);
  return angle;
}

export function registerCore(ctx: CoreContext): void {
  const vm = ctx.vm;
  const k = vm.kernelImpl;
  const start = ctx.now();
  const epoch = Date.now() - ctx.now();
  let lastWait = ctx.now();
  const ticks = () => Math.floor(((ctx.now() - start) * 60) / 1000) & 0xffff;
  let rngSeed = (Date.now() & 0x7fff) || 1;

  // --- scripts & objects
  k.set('Load', (_vm, a) => {
    const type = offOf(a[0]) & 0x7f;
    return num((type << 11) | offOf(a[1]));
  });
  k.set('UnLoad', () => undefined);
  k.set('ScriptID', (vm, a) => {
    if (segOf(a[0])) return a[0];
    const nr = offOf(a[0]);
    const index = a.length > 1 ? offOf(a[1]) : 0;
    const scr = vm.getScript(nr);
    if (!scr.exports.length) return 0;
    return mk(scr.seg, scr.exports[index] ?? 0);
  });
  k.set('DisposeScript', (vm, a) => {
    vm.disposeScript(offOf(a[0]));
    return a.length > 1 ? a[1] : undefined;
  });
  k.set('Clone', (vm, a) => vm.clone(a[0]));
  k.set('DisposeClone', (vm, a) => {
    vm.disposeClone(a[0]);
  });
  k.set('IsObject', (vm, a) => (vm.isObject(a[0]) ? 1 : 0));
  k.set('RespondsTo', (vm, a) => {
    const o = vm.getObject(a[0]);
    if (!o) return 0;
    const sel = offOf(a[1]);
    return vm.varIndex(o, sel) >= 0 || vm.findMethod(o, sel) ? 1 : 0;
  });

  // --- lists
  k.set('NewList', (vm) => vm.newList());
  k.set('DisposeList', (vm, a) => {
    vm.freeList(a[0]);
    return undefined;
  });
  k.set('NewNode', (vm, a) => vm.newNode(a[0], a.length > 1 ? a[1] : a[0]));
  k.set('FirstNode', (vm, a) => vm.list(a[0])?.first ?? 0);
  k.set('LastNode', (vm, a) => vm.list(a[0])?.last ?? 0);
  k.set('EmptyList', (vm, a) => {
    const l = vm.list(a[0]);
    return !l || !l.first ? 1 : 0;
  });
  k.set('NextNode', (vm, a) => vm.node(a[0])?.succ ?? 0);
  k.set('PrevNode', (vm, a) => vm.node(a[0])?.pred ?? 0);
  k.set('NodeValue', (vm, a) => vm.node(a[0])?.value ?? 0);
  const addToFront = (listR: number, nodeR: number) => {
    const l = vm.list(listR);
    const n = vm.node(nodeR);
    if (!l || !n) throw new SciError('AddToFront on bad list/node');
    n.pred = 0;
    n.succ = l.first;
    if (!l.first) l.last = nodeR;
    else vm.node(l.first)!.pred = nodeR;
    l.first = nodeR;
  };
  const addToEnd = (listR: number, nodeR: number) => {
    const l = vm.list(listR);
    const n = vm.node(nodeR);
    if (!l || !n) throw new SciError('AddToEnd on bad list/node');
    n.pred = l.last;
    n.succ = 0;
    if (!l.last) l.first = nodeR;
    else vm.node(l.last)!.succ = nodeR;
    l.last = nodeR;
  };
  k.set('AddToFront', (vm, a) => {
    addToFront(a[0], a[1]);
    if (a.length === 3) vm.node(a[1])!.key = a[2];
  });
  k.set('AddToEnd', (vm, a) => {
    addToEnd(a[0], a[1]);
    if (a.length === 3) vm.node(a[1])!.key = a[2];
  });
  k.set('AddAfter', (vm, a) => {
    const l = vm.list(a[0])!;
    const first = vm.node(a[1]);
    const n = vm.node(a[2])!;
    if (a.length === 4) n.key = a[3];
    if (first) {
      const oldNext = first.succ;
      n.pred = a[1];
      first.succ = a[2];
      n.succ = oldNext;
      if (!oldNext) l.last = a[2];
      else vm.node(oldNext)!.pred = a[2];
    } else addToFront(a[0], a[2]);
  });
  const findKey = (listR: number, key: number): number => {
    let p = vm.list(listR)?.first ?? 0;
    while (p) {
      const n = vm.node(p);
      if (!n) break;
      if (n.key === key) return p;
      p = n.succ;
    }
    return 0;
  };
  k.set('FindKey', (_vm, a) => findKey(a[0], a[1]));
  k.set('DeleteKey', (vm, a) => {
    const p = findKey(a[0], a[1]);
    if (!p) return 0;
    const l = vm.list(a[0])!;
    const n = vm.node(p)!;
    if (l.first === p) l.first = n.succ;
    if (l.last === p) l.last = n.pred;
    if (n.pred) vm.node(n.pred)!.succ = n.succ;
    if (n.succ) vm.node(n.succ)!.pred = n.pred;
    vm.freeNode(p);
    return 1;
  });

  // --- math
  k.set('Random', (_vm, a) => {
    if (a.length === 2) {
      const from = offOf(a[0]);
      const to = offOf(a[1]);
      if (from > to) return to;
      return num(from + Math.floor(Math.random() * (to - from + 1)));
    }
    return rngSeed;
  });
  k.set('Abs', (_vm, a) => num(Math.abs(s16(a[0]))));
  k.set('Sqrt', (_vm, a) => num(Math.trunc(Math.sqrt(Math.abs(s16(a[0]))))));
  k.set('GetAngle', (_vm, a) => num(angleSci0(s16(a[0]), s16(a[1]), s16(a[2]), s16(a[3]))));
  k.set('GetDistance', (_vm, a) => {
    const xdiff = a.length > 3 ? s16(a[3]) : 0;
    const ydiff = a.length > 2 ? s16(a[2]) : 0;
    const angle = a.length > 5 ? s16(a[5]) : 0;
    const xrel = Math.trunc((s16(a[1]) - xdiff) / Math.cos((angle * Math.PI) / 180));
    const yrel = s16(a[0]) - ydiff;
    return num(Math.trunc(Math.sqrt(xrel * xrel + yrel * yrel)));
  });
  const trig = (f: (x: number) => number, mult: boolean) => (_vm: SciVM, a: number[]) => {
    const v = f((s16(a[0]) * Math.PI) / 180);
    const value = s16(a[1]);
    if (mult) return num(Math.trunc(value * v));
    if (Math.abs(v) < 0.0001) return 0;
    return num(Math.trunc(value / v));
  };
  k.set('SinMult', trig(Math.sin, true));
  k.set('CosMult', trig(Math.cos, true));
  k.set('SinDiv', trig(Math.sin, false));
  k.set('CosDiv', trig(Math.cos, false));

  // --- time
  k.set('GetTime', (_vm, a) => {
    const mode = a.length ? offOf(a[0]) : 0;
    const d = new Date(epoch + ctx.now()); // wall clock, but driven by the engine's clock
    if (mode === 0) return ticks();
    if (mode === 1) {
      const h = d.getHours() % 12 || 12;
      return num((h << 12) | (d.getMinutes() << 6) | d.getSeconds());
    }
    if (mode === 2) return num((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1));
    return num(d.getDate() | ((d.getMonth() + 1) << 5) | (((d.getFullYear() - 1920) & 0x7f) << 9));
  });
  k.set('Wait', (vm, a) => {
    const t = offOf(a[0]);
    let time = ctx.now();
    const ms = (t * 1000) / 60;
    const elapsed = time - lastWait;
    if (ms > elapsed) {
      time += ms - elapsed;
      vm.waitUntil = time;
    } else vm.waitUntil = time;
    vm.yieldRequested = true;
    const delta = Math.floor(((time - lastWait) * 60) / 1000);
    lastWait = time;
    return num(delta);
  });

  // --- strings
  k.set('StrEnd', (vm, a) => mk(segOf(a[0]), offOf(a[0]) + vm.getString(a[0]).length));
  k.set('StrCat', (vm, a) => {
    vm.setString(a[0], vm.getString(a[0]) + vm.getString(a[1]));
    return a[0];
  });
  k.set('StrCmp', (vm, a) => {
    let s1 = vm.getString(a[0]);
    let s2 = vm.getString(a[1]);
    if (a.length > 2) {
      const n = offOf(a[2]);
      s1 = s1.slice(0, n);
      s2 = s2.slice(0, n);
    }
    for (let i = 0; ; i++) {
      const c1 = s1.charCodeAt(i) || 0;
      const c2 = s2.charCodeAt(i) || 0;
      if (c1 !== c2) return num(c1 - c2);
      if (!c1) return 0;
    }
  });
  k.set('StrLen', (vm, a) => vm.getString(a[0]).length);
  k.set('StrCpy', (vm, a) => {
    if (a.length > 2) {
      const len = s16(a[2]);
      if (len >= 0) {
        const src = vm.getString(a[1]).slice(0, len);
        for (let i = 0; i < len; i++) vm.writeByte(mk(segOf(a[0]), offOf(a[0]) + i), src.charCodeAt(i) || 0);
      } else {
        for (let i = 0; i < -len; i++) vm.writeByte(mk(segOf(a[0]), offOf(a[0]) + i), vm.readByte(mk(segOf(a[1]), offOf(a[1]) + i)));
      }
    } else vm.setString(a[0], vm.getString(a[1]));
    return a[0];
  });
  k.set('StrAt', (vm, a) => {
    const p = mk(segOf(a[0]), offOf(a[0]) + offOf(a[1]));
    const v = vm.readByte(p);
    if (a.length > 2) vm.writeByte(p, offOf(a[2]) & 0xff);
    return v;
  });
  k.set('Format', (vm, a) => {
    vm.setString(a[0], sciFormat(vm, a, 1));
    return a[0];
  });
  k.set('GetFarText', (vm, a) => {
    const text = lookupText(vm, num(a[0]), offOf(a[1]));
    let dest = a[2];
    if (!dest) dest = vm.allocDynMem(text.length + 1, 'FarText');
    vm.setString(dest, text);
    return dest;
  });
  k.set('ReadNumber', (vm, a) => {
    let s = vm.getString(a[0]).replace(/^\s+/, '');
    let sign = 1;
    if (s[0] === '-') {
      sign = -1;
      s = s.slice(1);
    }
    let result = 0;
    if (s[0] === '$') {
      const m = /^[0-9a-fA-F]*/.exec(s.slice(1))![0];
      result = m ? parseInt(m, 16) : 0;
    } else {
      const m = /^\d*/.exec(s)![0];
      result = m ? parseInt(m, 10) : 0;
    }
    return num(result * sign);
  });

  // --- debugging / memory stubs
  for (const n of ['SetDebug', 'InspectObj', 'ShowSends', 'ShowObjs', 'ShowFree', 'StackUsage', 'Profiler', 'FlushResources']) {
    k.set(n, () => undefined);
  }
  k.set('MemoryInfo', (_vm, a) => (offOf(a[0]) === 0 ? 0x7ffd : 0x7ffe));

  // --- files & devices (the browser has a single virtual drive)
  const dirStr = vm.allocDynMem(4, 'saveDir');
  vm.setString(dirStr, '/');
  k.set('GetSaveDir', () => dirStr);
  k.set('GetCWD', (vm, a) => {
    vm.setString(a[0], '/');
    return a[0];
  });
  k.set('CheckFreeSpace', () => 1);
  k.set('ValidPath', () => 1);
  k.set('DeviceInfo', (vm, a) => {
    switch (offOf(a[0])) {
      case 0: // get device of path
        vm.setString(a[2], '/');
        return a[2];
      case 1: // current device
        vm.setString(a[1], '/');
        return a[1];
      case 2: // same device?
        return 1;
      case 3: // is floppy?
        return 0;
      case 6:
      case 7:
        vm.setString(a[1], '__throwaway');
        return a[1];
    }
    return 0;
  });
  k.set('HaveMouse', () => 1);
  k.set('Joystick', () => 0);
  k.set('GameIsRestarting', (vm, a) => {
    const r = (vm as SciVM & { restarting?: boolean }).restarting ? 1 : 0;
    if (a.length && offOf(a[0]) === 0) (vm as SciVM & { restarting?: boolean }).restarting = false;
    return r;
  });
  void rngSeed;
}
