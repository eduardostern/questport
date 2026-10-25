// Picture transitions shown when kAnimate presents a newly drawn picture (Sierra's "showPic").
// Port of ScummVM's GfxTransitions (SCI0/SCI01 numbering, translated through the old-ID table).
//
// Sierra performed transitions synchronously with busy-waits. In a browser we cannot block, so a
// transition is computed up front as a timed list of operations on the output buffer. The caller
// makes the VM yield for the transition's duration (so the game does not advance, as in Sierra);
// the host may call `screen.advanceTransition(now)` every frame to animate it, and any later write to
// the output (copyToOutput) completes the pending transition first.

import type { Rect } from './gfx';
import { SciScreen, SCREEN_W, SCREEN_H, PendingTransition } from './screen';

export const TRANSITION = {
  VERTICALROLL_FROMCENTER: 0,
  HORIZONTALROLL_FROMCENTER: 1,
  STRAIGHT_FROM_RIGHT: 2,
  STRAIGHT_FROM_LEFT: 3,
  STRAIGHT_FROM_BOTTOM: 4,
  STRAIGHT_FROM_TOP: 5,
  DIAGONALROLL_TOCENTER: 6,
  DIAGONALROLL_FROMCENTER: 7,
  BLOCKS: 8,
  PIXELATION: 9,
  FADEPALETTE: 10,
  SCROLL_RIGHT: 11,
  SCROLL_LEFT: 12,
  SCROLL_UP: 13,
  SCROLL_DOWN: 14,
  NONE_LONGBOW: 15,
  NONE: 100,
  VERTICALROLL_TOCENTER: 300,
  HORIZONTALROLL_TOCENTER: 301,
} as const;

const T = TRANSITION;

// old ID -> [new ID, blackout]
const OLD_IDS: Record<number, [number, boolean]> = {
  0: [T.VERTICALROLL_FROMCENTER, false],
  1: [T.HORIZONTALROLL_FROMCENTER, false],
  2: [T.STRAIGHT_FROM_RIGHT, false],
  3: [T.STRAIGHT_FROM_LEFT, false],
  4: [T.STRAIGHT_FROM_BOTTOM, false],
  5: [T.STRAIGHT_FROM_TOP, false],
  6: [T.DIAGONALROLL_TOCENTER, false],
  7: [T.DIAGONALROLL_FROMCENTER, false],
  8: [T.BLOCKS, false],
  9: [T.VERTICALROLL_TOCENTER, false],
  10: [T.HORIZONTALROLL_TOCENTER, false],
  11: [T.STRAIGHT_FROM_RIGHT, true],
  12: [T.STRAIGHT_FROM_LEFT, true],
  13: [T.STRAIGHT_FROM_BOTTOM, true],
  14: [T.STRAIGHT_FROM_TOP, true],
  15: [T.DIAGONALROLL_TOCENTER, true],
  16: [T.DIAGONALROLL_FROMCENTER, true],
  17: [T.BLOCKS, true],
  18: [T.PIXELATION, false],
  27: [T.PIXELATION, true],
  30: [T.FADEPALETTE, false],
  40: [T.SCROLL_RIGHT, false],
  41: [T.SCROLL_LEFT, false],
  42: [T.SCROLL_UP, false],
  43: [T.SCROLL_DOWN, false],
  100: [T.NONE, false],
};

// transition -> blackout transition performed first
const BLACKOUT_IDS: Record<number, number> = {
  [T.VERTICALROLL_FROMCENTER]: T.VERTICALROLL_TOCENTER,
  [T.HORIZONTALROLL_FROMCENTER]: T.HORIZONTALROLL_TOCENTER,
  [T.STRAIGHT_FROM_RIGHT]: T.STRAIGHT_FROM_LEFT,
  [T.STRAIGHT_FROM_LEFT]: T.STRAIGHT_FROM_RIGHT,
  [T.STRAIGHT_FROM_BOTTOM]: T.STRAIGHT_FROM_TOP,
  [T.STRAIGHT_FROM_TOP]: T.STRAIGHT_FROM_BOTTOM,
  [T.DIAGONALROLL_FROMCENTER]: T.DIAGONALROLL_TOCENTER,
  [T.DIAGONALROLL_TOCENTER]: T.DIAGONALROLL_FROMCENTER,
  [T.BLOCKS]: T.BLOCKS,
  [T.PIXELATION]: T.PIXELATION,
  [T.FADEPALETTE]: T.NONE,
  [T.SCROLL_RIGHT]: T.NONE,
  [T.SCROLL_LEFT]: T.NONE,
  [T.SCROLL_UP]: T.NONE,
  [T.SCROLL_DOWN]: T.NONE,
  [T.NONE_LONGBOW]: T.NONE,
  [T.NONE]: T.NONE,
  [T.VERTICALROLL_TOCENTER]: T.NONE,
  [T.HORIZONTALROLL_TOCENTER]: T.NONE,
};

// Operation kinds
const OP_NEW = 0; // copy rect from the new screen
const OP_BLACK = 1; // clear rect to black
const OP_OLD = 2; // copy rect (src) from the old screen to (dx, dy)
const OP_NEWAT = 3; // copy rect (src) from the new screen to (dx, dy)

interface Op {
  t: number;
  kind: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
  dx: number;
  dy: number;
}

class R {
  constructor(public left: number, public top: number, public right: number, public bottom: number) {}
  static of(r: Rect): R {
    return new R(r.left, r.top, r.right, r.bottom);
  }
  clone(): R {
    return new R(this.left, this.top, this.right, this.bottom);
  }
  get width(): number {
    return this.right - this.left;
  }
  get height(): number {
    return this.bottom - this.top;
  }
  translate(x: number, y: number): void {
    this.left += x;
    this.right += x;
    this.top += y;
    this.bottom += y;
  }
  clip(c: R): void {
    this.top = Math.min(Math.max(this.top, c.top), c.bottom);
    this.left = Math.min(Math.max(this.left, c.left), c.right);
    this.bottom = Math.max(Math.min(this.bottom, c.bottom), c.top);
    this.right = Math.max(Math.min(this.right, c.right), c.left);
  }
  get empty(): boolean {
    return this.left >= this.right || this.top >= this.bottom;
  }
}

class TransitionPlayback implements PendingTransition {
  private next = 0;
  constructor(
    private scr: SciScreen,
    private ops: Op[],
    private newScreen: Uint8Array,
    private oldScreen: Uint8Array,
    private start: number,
    readonly duration: number,
  ) {}

  private apply(op: Op): void {
    const out = this.scr.output;
    const top = Math.max(0, op.top);
    const left = Math.max(0, op.left);
    const bottom = Math.min(SCREEN_H, op.bottom);
    const right = Math.min(SCREEN_W, op.right);
    if (right <= left || bottom <= top) return;
    if (op.kind === OP_NEW) {
      for (let y = top; y < bottom; y++) out.set(this.newScreen.subarray(y * SCREEN_W + left, y * SCREEN_W + right), y * SCREEN_W + left);
    } else if (op.kind === OP_BLACK) {
      for (let y = top; y < bottom; y++) out.fill(0, y * SCREEN_W + left, y * SCREEN_W + right);
    } else {
      const src = op.kind === OP_OLD ? this.oldScreen : this.newScreen;
      for (let y = top; y < bottom; y++) {
        const ty = op.dy + (y - op.top);
        if (ty < 0 || ty >= SCREEN_H) continue;
        for (let x = left; x < right; x++) {
          const tx = op.dx + (x - op.left);
          if (tx < 0 || tx >= SCREEN_W) continue;
          out[ty * SCREEN_W + tx] = src[y * SCREEN_W + x];
        }
      }
    }
  }

  /** Applies all operations due at `now`; returns true when finished. */
  advance(now: number): boolean {
    const elapsed = now - this.start;
    let changed = false;
    while (this.next < this.ops.length && this.ops[this.next].t <= elapsed) {
      this.apply(this.ops[this.next++]);
      changed = true;
    }
    if (changed) this.scr.outputDirty = true;
    return this.next >= this.ops.length;
  }

  finish(): void {
    this.advance(Infinity);
  }
}

export class SciTransitions {
  /** Transition number as passed by kDrawPic (old SCI0 numbering). */
  private number: number = T.HORIZONTALROLL_FROMCENTER;
  private blackoutFlag = false;

  // schedule being built
  private ops: Op[] = [];
  private pending: Op[] = [];
  private msec = 0;
  private picRect = new R(0, 0, 0, 0);

  constructor(private scr: SciScreen) {}

  setup(number: number, blackoutFlag: boolean): void {
    if (number !== -1) {
      this.number = number;
      this.blackoutFlag = blackoutFlag;
    }
  }

  /**
   * Shows the display buffer's picture area (screen coordinates) using the configured transition.
   * Returns the transition's duration in milliseconds (0 when it completed instantly).
   */
  doit(picRect: Rect, now: number): number {
    if (this.scr.pendingTransition) this.scr.finishTransition();
    this.picRect = R.of(picRect);
    let number: number = T.NONE;
    let blackout = false;
    const entry = OLD_IDS[this.number];
    if (entry) {
      number = entry[0];
      blackout = entry[1];
    }
    void this.blackoutFlag; // SCI0: the blackout flag comes from the translation table

    this.ops = [];
    this.pending = [];
    this.msec = 0;
    if (blackout) {
      const b = BLACKOUT_IDS[number];
      if (b !== undefined) this.doTransition(b, true);
    }
    this.doTransition(number, false);
    this.flush();
    this.scr.picNotValid = 0;

    const newScreen = this.scr.display.slice();
    this.scr.outOwner.set(this.scr.owner);
    const oldScreen = this.scr.output.slice();
    const duration = this.msec;
    const pb = new TransitionPlayback(this.scr, this.ops, newScreen, oldScreen, now, duration);
    this.ops = [];
    // Operations due immediately are applied now.
    if (pb.advance(now)) return 0;
    this.scr.pendingTransition = pb;
    return duration;
  }

  // ---------------------------------------------------------------- schedule helpers

  private copy(r: R, blackout: boolean): void {
    this.pending.push({ t: 0, kind: blackout ? OP_BLACK : OP_NEW, top: r.top, left: r.left, bottom: r.bottom, right: r.right, dx: 0, dy: 0 });
  }

  private copyFrom(kind: number, r: R, dx: number, dy: number): void {
    this.pending.push({ t: 0, kind, top: r.top, left: r.left, bottom: r.bottom, right: r.right, dx, dy });
  }

  /** Marks the pending operations as shown at `msec` (Sierra's updateScreenAndWait). */
  private frame(msec: number): void {
    for (const op of this.pending) {
      op.t = msec;
      this.ops.push(op);
    }
    this.pending = [];
    this.msec = Math.max(this.msec, msec);
  }

  private flush(): void {
    this.frame(this.msec);
  }

  private doTransition(number: number, blackout: boolean): void {
    // Each transition's timing starts at the end of the previous one.
    const base = this.msec;
    const frame = (ms: number) => this.frame(base + ms);
    switch (number) {
      case T.VERTICALROLL_FROMCENTER:
        this.verticalRollFromCenter(blackout, frame);
        break;
      case T.VERTICALROLL_TOCENTER:
        this.verticalRollToCenter(blackout, frame);
        break;
      case T.HORIZONTALROLL_FROMCENTER:
        this.horizontalRollFromCenter(blackout, frame);
        break;
      case T.HORIZONTALROLL_TOCENTER:
        this.horizontalRollToCenter(blackout, frame);
        break;
      case T.DIAGONALROLL_TOCENTER:
        this.diagonalRollToCenter(blackout, frame);
        break;
      case T.DIAGONALROLL_FROMCENTER:
        this.diagonalRollFromCenter(blackout, frame);
        break;
      case T.STRAIGHT_FROM_RIGHT:
      case T.STRAIGHT_FROM_LEFT:
      case T.STRAIGHT_FROM_BOTTOM:
      case T.STRAIGHT_FROM_TOP:
        this.straight(number, blackout, frame);
        break;
      case T.PIXELATION:
        this.pixelation(blackout, frame);
        break;
      case T.BLOCKS:
        this.blocks(blackout, frame);
        break;
      case T.SCROLL_RIGHT:
      case T.SCROLL_LEFT:
      case T.SCROLL_UP:
      case T.SCROLL_DOWN:
        this.scroll(number, frame);
        break;
      case T.FADEPALETTE: // EGA: no palette fading, just show the new screen
      case T.NONE_LONGBOW:
      case T.NONE:
      default:
        if (!blackout) this.copy(this.picRect, false);
        break;
    }
    this.frame(this.msec);
  }

  // ---------------------------------------------------------------- transitions (ScummVM ports)

  private pixelation(blackout: boolean, frame: (ms: number) => void): void {
    let mask = 0x40;
    let stepNr = 0;
    let msecCount = 0;
    do {
      mask = mask & 1 ? (mask >> 1) ^ 0xb400 : mask >> 1;
      if (mask >= SCREEN_W * SCREEN_H) continue;
      const r = new R(mask % SCREEN_W, Math.floor(mask / SCREEN_W), 0, 0);
      r.right = r.left + 1;
      r.bottom = r.top + 1;
      r.clip(this.picRect);
      if (!r.empty) this.copy(r, blackout);
      if ((stepNr & 0x3ff) === 0) {
        msecCount += 9;
        frame(msecCount);
      }
      stepNr = (stepNr + 1) & 0xffff;
    } while (mask !== 0x40);
  }

  private blocks(blackout: boolean, frame: (ms: number) => void): void {
    let mask = 0x40;
    let stepNr = 0;
    let msecCount = 0;
    do {
      mask = mask & 1 ? (mask >> 1) ^ 0x240 : mask >> 1;
      if (mask >= 40 * 25) continue;
      const r = new R((mask % 40) << 3, Math.floor(mask / 40) << 3, 0, 0);
      r.right = r.left + 8;
      r.bottom = r.top + 8;
      r.clip(this.picRect);
      if (!r.empty) this.copy(r, blackout);
      if ((stepNr & 7) === 0) {
        msecCount += 5;
        frame(msecCount);
      }
      stepNr++;
    } while (mask !== 0x40);
  }

  private straight(number: number, blackout: boolean, frame: (ms: number) => void): void {
    const pic = this.picRect;
    const r = pic.clone();
    let stepNr = 0;
    let msecCount = 0;
    switch (number) {
      case T.STRAIGHT_FROM_RIGHT:
        r.left = r.right - 1;
        while (r.left >= pic.left) {
          this.copy(r, blackout);
          if ((stepNr & 1) === 0) {
            msecCount += 2;
            frame(msecCount);
          }
          stepNr++;
          r.translate(-1, 0);
        }
        break;
      case T.STRAIGHT_FROM_LEFT:
        r.right = r.left + 1;
        while (r.right <= pic.right) {
          this.copy(r, blackout);
          if ((stepNr & 1) === 0) {
            msecCount += 2;
            frame(msecCount);
          }
          stepNr++;
          r.translate(1, 0);
        }
        break;
      case T.STRAIGHT_FROM_BOTTOM:
        r.top = r.bottom - 1;
        while (r.top >= pic.top) {
          this.copy(r, blackout);
          msecCount += 4;
          frame(msecCount);
          r.translate(0, -1);
        }
        break;
      case T.STRAIGHT_FROM_TOP:
        r.bottom = r.top + 1;
        while (r.bottom <= pic.bottom) {
          this.copy(r, blackout);
          msecCount += 4;
          frame(msecCount);
          r.translate(0, 1);
        }
        break;
    }
  }

  private scroll(number: number, frame: (ms: number) => void): void {
    const pic = this.picRect;
    const oldMove = pic.clone();
    const oldScreen = pic.clone();
    const newMove = pic.clone();
    const newScreen = pic.clone();
    let stepNr = 0;
    let msecCount = 0;
    switch (number) {
      case T.SCROLL_LEFT:
        newScreen.right = newScreen.left;
        newMove.left = newMove.right;
        while (oldMove.left < oldMove.right) {
          oldMove.right--;
          oldScreen.left++;
          newScreen.right++;
          newMove.left--;
          if ((stepNr & 1) === 0) {
            msecCount += 5;
            if (oldMove.right > oldMove.left) this.copyFrom(OP_OLD, oldScreen, oldMove.left, oldMove.top);
            this.copyFrom(OP_NEWAT, newScreen, newMove.left, newMove.top);
            frame(msecCount);
          }
          stepNr++;
        }
        break;
      case T.SCROLL_RIGHT:
        newScreen.left = newScreen.right;
        while (oldMove.left < oldMove.right) {
          oldMove.left++;
          oldScreen.right--;
          newScreen.left--;
          if ((stepNr & 1) === 0) {
            msecCount += 5;
            if (oldMove.right > oldMove.left) this.copyFrom(OP_OLD, oldScreen, oldMove.left, oldMove.top);
            this.copyFrom(OP_NEWAT, newScreen, newMove.left, newMove.top);
            frame(msecCount);
          }
          stepNr++;
        }
        break;
      case T.SCROLL_UP:
        newScreen.bottom = newScreen.top;
        newMove.top = newMove.bottom;
        while (oldMove.top < oldMove.bottom) {
          oldMove.top++;
          oldScreen.top++;
          newScreen.bottom++;
          newMove.top--;
          msecCount += 5;
          if (oldMove.top < oldMove.bottom) this.copyFrom(OP_OLD, oldScreen, pic.left, pic.top);
          this.copyFrom(OP_NEWAT, newScreen, newMove.left, newMove.top);
          frame(msecCount);
        }
        break;
      case T.SCROLL_DOWN:
        newScreen.top = newScreen.bottom;
        while (oldMove.top < oldMove.bottom) {
          oldMove.top++;
          oldScreen.bottom--;
          newScreen.top--;
          msecCount += 5;
          if (oldMove.top < oldMove.bottom) this.copyFrom(OP_OLD, oldScreen, oldMove.left, oldMove.top);
          this.copyFrom(OP_NEWAT, newScreen, pic.left, pic.top);
          frame(msecCount);
        }
        break;
    }
    this.copy(newScreen, false);
  }

  private verticalRollFromCenter(blackout: boolean, frame: (ms: number) => void): void {
    const pic = this.picRect;
    const half = pic.left + (pic.width >> 1);
    const l = new R(half - 1, pic.top, half, pic.bottom);
    const r = new R(l.right, pic.top, l.right + 1, pic.bottom);
    let msecCount = 0;
    while (l.left >= pic.left || r.right <= pic.right) {
      if (l.left < pic.left) l.translate(1, 0);
      if (r.right > pic.right) r.translate(-1, 0);
      this.copy(l, blackout);
      l.translate(-1, 0);
      this.copy(r, blackout);
      r.translate(1, 0);
      msecCount += 3;
      frame(msecCount);
    }
  }

  private verticalRollToCenter(blackout: boolean, frame: (ms: number) => void): void {
    const pic = this.picRect;
    const l = new R(pic.left, pic.top, pic.left + 1, pic.bottom);
    const r = new R(pic.right - 1, pic.top, pic.right, pic.bottom);
    let msecCount = 0;
    while (l.left < r.right) {
      this.copy(l, blackout);
      l.translate(1, 0);
      this.copy(r, blackout);
      r.translate(-1, 0);
      msecCount += 3;
      frame(msecCount);
    }
  }

  private horizontalRollFromCenter(blackout: boolean, frame: (ms: number) => void): void {
    const pic = this.picRect;
    const half = pic.top + (pic.height >> 1);
    const u = new R(pic.left, half - 1, pic.right, half);
    const lo = new R(u.left, u.bottom, u.right, u.bottom + 1);
    let msecCount = 0;
    while (u.top >= pic.top || lo.bottom <= pic.bottom) {
      if (u.top < pic.top) u.translate(0, 1);
      if (lo.bottom > pic.bottom) lo.translate(0, -1);
      this.copy(u, blackout);
      u.translate(0, -1);
      this.copy(lo, blackout);
      lo.translate(0, 1);
      msecCount += 4;
      frame(msecCount);
    }
  }

  private horizontalRollToCenter(blackout: boolean, frame: (ms: number) => void): void {
    const pic = this.picRect;
    const u = new R(pic.left, pic.top, pic.right, pic.top + 1);
    const lo = new R(u.left, pic.bottom - 1, u.right, pic.bottom);
    let msecCount = 0;
    while (u.top < lo.bottom) {
      this.copy(u, blackout);
      u.translate(0, 1);
      this.copy(lo, blackout);
      lo.translate(0, -1);
      msecCount += 4;
      frame(msecCount);
    }
  }

  private diagonalRollFromCenter(blackout: boolean, frame: (ms: number) => void): void {
    const pic = this.picRect;
    const halfHeight = pic.height >> 1;
    const u = new R(pic.left + halfHeight - 2, pic.top + halfHeight, pic.right - halfHeight + 1, pic.top + halfHeight + 1);
    const lo = u.clone();
    const l = new R(u.left, u.top, u.left + 1, lo.bottom);
    const r = new R(u.right, u.top, u.right + 1, lo.bottom);
    let msecCount = 0;
    while (u.top >= pic.top || lo.bottom <= pic.bottom) {
      if (u.top < pic.top) {
        u.translate(0, 1);
        l.top++;
        r.top++;
      }
      if (lo.bottom > pic.bottom) {
        lo.translate(0, -1);
        l.bottom--;
        r.bottom--;
      }
      if (l.left < pic.left) {
        l.translate(1, 0);
        u.left++;
        lo.left++;
      }
      if (r.right > pic.right) {
        r.translate(-1, 0);
        u.right--;
        lo.right--;
      }
      this.copy(u, blackout);
      u.translate(0, -1);
      u.left--;
      u.right++;
      this.copy(lo, blackout);
      lo.translate(0, 1);
      lo.left--;
      lo.right++;
      this.copy(l, blackout);
      l.translate(-1, 0);
      l.top--;
      l.bottom++;
      this.copy(r, blackout);
      r.translate(1, 0);
      r.top--;
      r.bottom++;
      msecCount += 4;
      frame(msecCount);
    }
  }

  private diagonalRollToCenter(blackout: boolean, frame: (ms: number) => void): void {
    const pic = this.picRect;
    const u = new R(pic.left, pic.top, pic.right, pic.top + 1);
    const lo = new R(pic.left, pic.bottom - 1, pic.right, pic.bottom);
    const l = new R(pic.left, pic.top, pic.left + 1, pic.bottom);
    const r = new R(pic.right - 1, pic.top, pic.right, pic.bottom);
    let msecCount = 0;
    while (u.top < lo.bottom) {
      this.copy(u, blackout);
      u.translate(0, 1);
      u.left++;
      u.right--;
      this.copy(lo, blackout);
      lo.translate(0, -1);
      lo.left++;
      lo.right--;
      this.copy(l, blackout);
      l.translate(1, 0);
      this.copy(r, blackout);
      r.translate(-1, 0);
      msecCount += 4;
      frame(msecCount);
    }
  }
}
