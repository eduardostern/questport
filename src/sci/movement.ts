// Actor movement kernel functions: kInitBresen, kDoBresen, kDoAvoider, kSetJump, kDirLoop.
// Ported from ScummVM's kmovement.cpp / kgraphics.cpp, SCI0 (late) code paths.

import { s16, num } from './vm';
import type { SciVM } from './vm';
import type { SciContext } from './context';

const SIGNAL_DOESNT_TURN = 0x0800;
const SIGNAL_HIT_OBSTACLE = 0x0400;
const SIGNAL_REG = 0xffff;

/** Truncates to a signed 16-bit value (C int16 assignment). */
const w16 = (v: number): number => (v << 16) >> 16;
const idiv = (a: number, b: number): number => Math.trunc(a / b);

function getAngleSci0(x1: number, y1: number, x2: number, y2: number): number {
  let xRel = x2 - x1;
  let yRel = y1 - y2;
  if (y1 < y2) yRel = -yRel;
  if (x2 < x1) xRel = -xRel;
  if (yRel === 0 && xRel === 0) return 0;
  let angle = idiv(100 * xRel, xRel + yRel);
  if (y1 < y2) angle = 200 - angle;
  if (x2 < x1) angle = 400 - angle;
  angle -= idiv(angle + 9, 10);
  return angle;
}

const get = (vm: SciVM, obj: number, sel: string): number => s16(vm.getSel(obj, sel));
const set = (vm: SciVM, obj: number, sel: string, v: number): void => vm.setSel(obj, sel, num(v));

export function dirLoop(vm: SciVM, viewLoopCount: (view: number) => number, obj: number, angle: number): void {
  const viewId = vm.getSel(obj, 'view') & 0xffff;
  const signal = vm.getSel(obj, 'signal') & 0xffff;
  if (signal & SIGNAL_DOESNT_TURN) return;
  let useLoop = -1;
  // SCI0 late (> SCI0 early) thresholds
  if (angle > 315 || angle < 45) useLoop = 3;
  else if (angle > 135 && angle < 225) useLoop = 2;
  if (useLoop === -1) {
    useLoop = angle >= 180 ? 1 : 0;
  } else if (viewLoopCount(viewId) < 4) return;
  set(vm, obj, 'loop', useLoop);
}

export function registerMovement(ctx: SciContext): void {
  const k = ctx.vm.kernelImpl;
  const loopCount = (view: number) => ctx.gfx.view(view).loops.length;

  k.set('DirLoop', (vm, a) => {
    dirLoop(vm, loopCount, a[0], a[1] & 0xffff);
    return undefined;
  });

  k.set('SetJump', (vm, a) => {
    const object = a[0];
    let dx = s16(a[1]);
    const dy = s16(a[2]);
    const gy = s16(a[3]);
    let c: number;
    let vx = 0;
    let vy = 0;
    const dxWasNegative = dx < 0;
    dx = Math.abs(dx);
    if (dx === 0) c = 1;
    else if (dx + dy < 0) c = idiv(2 * Math.abs(dy), dx);
    else {
      c = idiv(idiv(dx * 3, 2) - dy, dx);
      if (c < 1) c = 1;
    }
    const tmp = c * dx + dy;
    if (tmp !== 0 && dx !== 0) {
      const f = dx * Math.sqrt(gy / (2.0 * tmp));
      vx = Number.isFinite(f) ? w16(Math.trunc(f)) : 0;
    }
    if (dxWasNegative) vx = -vx;
    if (dy < 0 && vx === 0) vy = Math.trunc(Math.sqrt(gy * Math.abs(2 * dy))) + 1;
    else vy = c * vx;
    vy = -Math.abs(vy);
    set(vm, object, 'xStep', vx);
    set(vm, object, 'yStep', vy);
    return undefined;
  });

  k.set('InitBresen', (vm, a) => {
    const mover = a[0];
    const client = vm.getSel(mover, 'client');
    const stepFactor = a.length >= 2 ? w16(a[1]) : 1;
    const moverX = get(vm, mover, 'x');
    const moverY = get(vm, mover, 'y');
    let xStep = w16(get(vm, client, 'xStep') * stepFactor);
    const yStep = w16(get(vm, client, 'yStep') * stepFactor);
    let step = xStep < yStep ? yStep * 2 : xStep * 2;
    const deltaX = w16(moverX - get(vm, client, 'x'));
    const deltaY = w16(moverY - get(vm, client, 'y'));
    let mdx = 0;
    let mdy = 0;
    let i1 = 0;
    let i2 = 0;
    let di = 0;
    let incr = 0;
    let xAxis = 0;
    for (;;) {
      mdx = xStep;
      mdy = yStep;
      incr = 1;
      if (Math.abs(deltaX) >= Math.abs(deltaY)) {
        xAxis = 1;
        if (deltaX < 0) mdx = -mdx;
        mdy = deltaX ? w16(idiv(mdx * deltaY, deltaX)) : 0;
        i1 = w16((mdx * deltaY - mdy * deltaX) * 2);
        if (deltaY < 0) {
          incr = -1;
          i1 = w16(-i1);
        }
        i2 = w16(i1 - deltaX * 2);
        di = w16(i1 - deltaX);
        if (deltaX < 0) {
          i1 = w16(-i1);
          i2 = w16(-i2);
          di = w16(-di);
        }
      } else {
        xAxis = 0;
        if (deltaY < 0) mdy = -mdy;
        mdx = deltaY ? w16(idiv(mdy * deltaX, deltaY)) : 0;
        i1 = w16((mdy * deltaX - mdx * deltaY) * 2);
        if (deltaX < 0) {
          incr = -1;
          i1 = w16(-i1);
        }
        i2 = w16(i1 - deltaY * 2);
        di = w16(i1 - deltaY);
        if (deltaY < 0) {
          i1 = w16(-i1);
          i2 = w16(-i2);
          di = w16(-di);
        }
        break;
      }
      if (xStep <= yStep) break;
      if (!xStep) break;
      if (yStep >= Math.abs(mdy + incr)) break;
      step--;
      if (!step) throw new Error('kInitBresen failed');
      xStep--;
    }
    set(vm, mover, 'dx', mdx);
    set(vm, mover, 'dy', mdy);
    set(vm, mover, 'b-i1', i1);
    set(vm, mover, 'b-i2', i2);
    set(vm, mover, 'b-di', di);
    set(vm, mover, 'b-incr', incr);
    set(vm, mover, 'b-xAxis', xAxis);
    return undefined;
  });

  k.set('DoBresen', (vm, a) => {
    const mover = a[0];
    const client = vm.getSel(mover, 'client');
    // SCI0 always handles the move count.
    let moveCnt = get(vm, mover, 'b-moveCnt') + 1;
    const moveSpeed = vm.hasSel(client, 'moveSpeed') ? get(vm, client, 'moveSpeed') : 0;
    if (moveSpeed < moveCnt) {
      moveCnt = 0;
      let cx = get(vm, client, 'x');
      let cy = get(vm, client, 'y');
      const mx = get(vm, mover, 'x');
      const my = get(vm, mover, 'y');
      const xAxis = get(vm, mover, 'b-xAxis');
      const mdx = get(vm, mover, 'dx');
      const mdy = get(vm, mover, 'dy');
      const incr = get(vm, mover, 'b-incr');
      let i1 = get(vm, mover, 'b-i1');
      let i2 = get(vm, mover, 'b-i2');
      let di = get(vm, mover, 'b-di');
      const orgI1 = i1;
      const orgI2 = i2;
      const orgDi = di;

      const clientObj = vm.getObject(client);
      const backup = clientObj ? clientObj.vars.slice() : [];

      let completed = false;
      if (xAxis) {
        if (Math.abs(mx - cx) < Math.abs(mdx)) completed = true;
      } else if (Math.abs(my - cy) < Math.abs(mdy)) completed = true;
      if (completed) {
        cx = mx;
        cy = my;
      } else {
        cx += mdx;
        cy += mdy;
        if (di < 0) di = w16(di + i1);
        else {
          di = w16(di + i2);
          if (xAxis === 0) cx += incr;
          else cy += incr;
        }
      }
      set(vm, client, 'x', cx);
      set(vm, client, 'y', cy);

      vm.acc = 0;
      const r = vm.invoke(client, 'canBeHere');
      if (r === 0) {
        // collision: restore the client's variables
        if (clientObj) for (let i = 0; i < backup.length; i++) clientObj.vars[i] = backup[i];
        i1 = orgI1;
        i2 = orgI2;
        di = orgDi;
        set(vm, client, 'signal', (vm.getSel(client, 'signal') & 0xffff) | SIGNAL_HIT_OBSTACLE);
      }
      set(vm, mover, 'b-i1', i1);
      set(vm, mover, 'b-i2', i2);
      set(vm, mover, 'b-di', di);
    }
    set(vm, mover, 'b-moveCnt', moveCnt);
    return undefined;
  });

  k.set('DoAvoider', (vm, a) => {
    const avoider = a[0];
    const timesStep = a.length > 1 ? w16(a[1]) : 1;
    if (!vm.isObject(avoider)) return SIGNAL_REG;
    const client = vm.getSel(avoider, 'client');
    let mover = vm.getSel(client, 'mover');
    if (!mover) return SIGNAL_REG;
    vm.invoke(mover, 'doit');
    mover = vm.getSel(client, 'mover');
    if (!mover) return SIGNAL_REG;

    const clientX = get(vm, client, 'x');
    const clientY = get(vm, client, 'y');
    const moverX = get(vm, mover, 'x');
    const moverY = get(vm, mover, 'y');
    let avoiderHeading = get(vm, avoider, 'heading');
    let result: number;

    const blocked = vm.invoke(client, 'isBlocked');
    if (!blocked) {
      if (avoiderHeading === -1) return SIGNAL_REG;
      avoiderHeading = -1;
      const angle = getAngleSci0(clientX, clientY, moverX, moverY);
      const looper = vm.getSel(client, 'looper');
      if (!looper) dirLoop(vm, loopCount, client, angle);
      else vm.invoke(looper, 'doit', num(angle), client);
      result = SIGNAL_REG;
    } else {
      if (avoiderHeading === -1) avoiderHeading = Math.random() < 0.5 ? 45 : -45;
      let clientHeading = get(vm, client, 'heading');
      clientHeading = idiv(clientHeading, 45) * 45;
      const xs = w16(get(vm, client, 'xStep') * timesStep);
      const ys = w16(get(vm, client, 'yStep') * timesStep);
      let newHeading = clientHeading;
      for (;;) {
        let nx = clientX;
        let ny = clientY;
        switch (newHeading) {
          case 45:
          case 90:
          case 135:
            nx += xs;
            break;
          case 225:
          case 270:
          case 315:
            nx -= xs;
            break;
        }
        switch (newHeading) {
          case 0:
          case 45:
          case 315:
            ny -= ys;
            break;
          case 135:
          case 180:
          case 225:
            ny += ys;
            break;
        }
        set(vm, client, 'x', nx);
        set(vm, client, 'y', ny);
        if (vm.invoke(client, 'canBeHere')) {
          result = num(newHeading);
          break;
        }
        newHeading += avoiderHeading;
        if (newHeading >= 360) newHeading -= 360;
        if (newHeading < 0) newHeading += 360;
        if (newHeading === clientHeading) {
          set(vm, client, 'x', clientX);
          set(vm, client, 'y', clientY);
          result = SIGNAL_REG;
          break;
        }
      }
    }
    set(vm, avoider, 'heading', avoiderHeading);
    return result;
  });
}
