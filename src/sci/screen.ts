// SCI0 screen: 320x200 visual, priority and control layers, plus priority bands.

export const SCREEN_W = 320;
export const SCREEN_H = 200;
export const MASK_VIS = 1;
export const MASK_PRI = 2;
export const MASK_CTL = 4;

/** A picture transition in progress on the output buffer (see transitions.ts). */
export interface PendingTransition {
  /** Applies the steps due at `now` (ms, same clock as SciContext.now); true when finished. */
  advance(now: number): boolean;
  /** Applies all remaining steps. */
  finish(): void;
}

/** Where a sprite pixel came from: a cel drawn with its top-left corner at (left, top) on screen. */
export interface CelPlacement {
  view: number;
  loop: number;
  cel: number;
  left: number;
  top: number;
}

/** One character drawn with a game font (for redrawing text in high resolution). */
export interface TextGlyph {
  ch: number;
  font: number;
  left: number;
  top: number;
  w: number;
  h: number;
  color: number;
  greyed: boolean;
  /** Number of pixels the bitmap glyph set. */
  pixels: number;
}

/** Owner values <= OWNER_TEXT_BASE are text glyphs: glyph id = OWNER_TEXT_BASE - owner. */
export const OWNER_TEXT_BASE = -2;

/** Owner value for pixels of the current room picture. */
export const OWNER_PICTURE = 0;
/** Owner value for anything else (text, window frames, overlay pictures, fills). */
export const OWNER_OTHER = -1;

export class SciScreen {
  visual = new Uint8Array(SCREEN_W * SCREEN_H);
  /**
   * What drew each display pixel: OWNER_PICTURE, OWNER_OTHER, or a placement id (> 0) for sprite cels.
   * Only used by the repainted-graphics mode; the game itself never reads it.
   */
  owner = new Int32Array(SCREEN_W * SCREEN_H);
  /** `owner` for what the player currently sees (follows `output`). */
  outOwner = new Int32Array(SCREEN_W * SCREEN_H);
  /** Owner recorded by putPixel/clearRect. */
  curOwner = OWNER_OTHER;
  placements = new Map<number, CelPlacement>();
  private placementKeys = new Map<string, number>();
  private nextPlacement = 1;

  placementId(view: number, loop: number, cel: number, left: number, top: number): number {
    const key = `${view},${loop},${cel},${left},${top}`;
    let id = this.placementKeys.get(key);
    if (id === undefined) {
      id = this.nextPlacement++;
      this.placementKeys.set(key, id);
      this.placements.set(id, { view, loop, cel, left, top });
    }
    return id;
  }

  textGlyphs = new Map<number, TextGlyph>();
  private textKeys = new Map<string, number>();
  private nextText = 0;

  /** Owner value for a glyph drawn at a position (same glyph, place and color share one id). */
  textOwner(ch: number, font: number, left: number, top: number, w: number, h: number, color: number, greyed: boolean): number {
    const key = `${ch},${font},${left},${top},${color},${greyed ? 1 : 0}`;
    let id = this.textKeys.get(key);
    if (id === undefined) {
      id = this.nextText++;
      this.textKeys.set(key, id);
      this.textGlyphs.set(id, { ch, font, left, top, w, h, color, greyed, pixels: 0 });
    }
    return OWNER_TEXT_BASE - id;
  }

  /** Forgets sprite placements (a new room picture replaces everything on screen). */
  resetPlacements(): void {
    this.placements.clear();
    this.placementKeys.clear();
  }

  priority = new Uint8Array(SCREEN_W * SCREEN_H);
  control = new Uint8Array(SCREEN_W * SCREEN_H);
  /** Mirrors visual writes (Sierra's display buffer); restored separately in some cases. */
  display = new Uint8Array(SCREEN_W * SCREEN_H);
  /** What the player sees: only updated by copyToOutput (Sierra's "show bits"). */
  output = new Uint8Array(SCREEN_W * SCREEN_H);
  /** Set whenever `output` changes so the host knows to repaint. */
  outputDirty = true;
  /**
   * Sierra's picNotValid flag (0, 1 or 2): set by kDrawPic/kAddToPic, makes the next kAnimate
   * show the new picture (with its transition) instead of updating individual cels.
   */
  picNotValid = 0;
  /**
   * Picture transition still being revealed on `output`. Hosts should call advanceTransition(now)
   * every frame; any copyToOutput completes it first.
   */
  pendingTransition: PendingTransition | null = null;

  /** Animates a pending picture transition; returns true while one is still running. */
  advanceTransition(now: number): boolean {
    const t = this.pendingTransition;
    if (!t) return false;
    if (t.advance(now)) this.pendingTransition = null;
    return this.pendingTransition !== null;
  }

  finishTransition(): void {
    const t = this.pendingTransition;
    this.pendingTransition = null;
    if (t) t.finish();
  }

  priorityBands = new Uint8Array(200);
  priorityBottom = 199;
  private bandCount = 15;

  constructor() {
    this.initPriorityBands(15, 42, 200);
  }

  putPixel(x: number, y: number, m: number, color: number, pri: number, ctl: number): void {
    if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return;
    const o = y * SCREEN_W + x;
    if (m & MASK_VIS) {
      this.visual[o] = color;
      this.display[o] = color;
      this.owner[o] = this.curOwner;
    }
    if (m & MASK_PRI) this.priority[o] = pri;
    if (m & MASK_CTL) this.control[o] = ctl;
  }

  drawLine(x1: number, y1: number, x2: number, y2: number, color: number, pri: number, ctl: number): void {
    const m = (color !== 255 ? MASK_VIS : 0) | (pri !== 255 ? MASK_PRI : 0) | (ctl !== 255 ? MASK_CTL : 0);
    const clip = (v: number, max: number) => Math.min(Math.max(v, 0), max);
    let left = clip(x1, SCREEN_W - 1);
    let top = clip(y1, SCREEN_H - 1);
    let right = clip(x2, SCREEN_W - 1);
    let bottom = clip(y2, SCREEN_H - 1);
    if (top === bottom) {
      if (right < left) [left, right] = [right, left];
      for (let i = left; i <= right; i++) this.putPixel(i, top, m, color, pri, ctl);
      return;
    }
    if (left === right) {
      if (top > bottom) [top, bottom] = [bottom, top];
      for (let i = top; i <= bottom; i++) this.putPixel(left, i, m, color, pri, ctl);
      return;
    }
    let dy = bottom - top;
    let dx = right - left;
    const stepy = dy < 0 ? -1 : 1;
    const stepx = dx < 0 ? -1 : 1;
    dy = Math.abs(dy) << 1;
    dx = Math.abs(dx) << 1;
    this.putPixel(left, top, m, color, pri, ctl);
    this.putPixel(right, bottom, m, color, pri, ctl);
    if (dx > dy) {
      let fraction = dy - (dx >> 1);
      while (left !== right) {
        if (fraction >= 0) {
          top += stepy;
          fraction -= dx;
        }
        left += stepx;
        fraction += dy;
        this.putPixel(left, top, m, color, pri, ctl);
      }
    } else {
      let fraction = dx - (dy >> 1);
      while (top !== bottom) {
        if (fraction >= 0) {
          left += stepx;
          fraction -= dy;
        }
        top += stepy;
        fraction += dx;
        this.putPixel(left, top, m, color, pri, ctl);
      }
    }
  }

  /** Resolves EGA color pairs drawn by pictures into single dithered colors. */
  dither(): void {
    const v = this.visual;
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const o = y * SCREEN_W + x;
        let c = v[o];
        if (c & 0xf0) {
          c ^= (c << 4) & 0xff;
          v[o] = (x ^ y) & 1 ? c >> 4 : c & 0x0f;
          this.display[o] = v[o];
        }
      }
    }
  }

  initPriorityBands(count: number, top: number, bottom: number): void {
    this.bandCount = count;
    const bandSize = Math.trunc(((bottom - top) * 2000) / count);
    this.priorityBands.fill(0, 0, top);
    for (let y = top; y < bottom; y++) this.priorityBands[y] = 1 + Math.trunc(((y - top) * 2000) / bandSize);
    if (count === 15) {
      let y = bottom;
      while (this.priorityBands[--y] === count) this.priorityBands[y]--;
    }
    for (let y = bottom; y < 200; y++) this.priorityBands[y] = count;
    this.priorityBottom = bottom === 200 ? 199 : bottom;
  }

  setPriorityBandsExplicit(data: Uint8Array): void {
    let i = 0;
    let inx = 0;
    for (; inx < 14; inx++) while (i < data[inx] && i < 200) this.priorityBands[i++] = inx;
    while (i < 200) this.priorityBands[i++] = inx;
  }

  coordinateToPriority(y: number): number {
    if (y < 0) return this.priorityBands[0];
    if (y > this.priorityBottom) return this.priorityBands[this.priorityBottom];
    return this.priorityBands[y];
  }

  priorityToCoordinate(p: number): number {
    if (p <= this.bandCount) {
      for (let y = 0; y <= this.priorityBottom; y++) if (this.priorityBands[y] === p) return y;
    }
    return this.priorityBottom;
  }

  /** Copies a rectangle of the display buffer to what the player sees. */
  copyToOutput(left: number, top: number, right: number, bottom: number): void {
    if (this.pendingTransition) this.finishTransition();
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(SCREEN_W, right);
    bottom = Math.min(SCREEN_H, bottom);
    for (let y = top; y < bottom; y++) {
      const o = y * SCREEN_W;
      this.output.set(this.display.subarray(o + left, o + right), o + left);
      this.outOwner.set(this.owner.subarray(o + left, o + right), o + left);
    }
    this.outputDirty = true;
  }

  getPriority(x: number, y: number): number {
    return this.priority[y * SCREEN_W + x];
  }

  /** Clears a rectangle on all three layers (used before drawing a non-overlay picture). */
  clearRect(left: number, top: number, right: number, bottom: number, color: number): void {
    for (let y = Math.max(0, top); y < Math.min(SCREEN_H, bottom); y++) {
      const o = y * SCREEN_W;
      this.visual.fill(color, o + Math.max(0, left), o + Math.min(SCREEN_W, right));
      this.display.fill(color, o + Math.max(0, left), o + Math.min(SCREEN_W, right));
      this.owner.fill(this.curOwner, o + Math.max(0, left), o + Math.min(SCREEN_W, right));
      this.priority.fill(0, o + Math.max(0, left), o + Math.min(SCREEN_W, right));
      this.control.fill(0, o + Math.max(0, left), o + Math.min(SCREEN_W, right));
    }
  }
}
