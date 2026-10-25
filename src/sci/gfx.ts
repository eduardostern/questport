// Shared SCI0 graphics state: view (sprite) and font decoding, ports/windows,
// and the painting primitives the graphics kernel functions are built on.
// Behavior follows Sierra's SCI0 interpreter (via ScummVM's gfx/ports/paint16 code).

import { SciResources, ResType } from './resource';
import { SciScreen, SCREEN_W, SCREEN_H, MASK_VIS, MASK_PRI, MASK_CTL, OWNER_PICTURE, OWNER_OTHER, OWNER_TEXT_BASE } from './screen';
import { drawSciPicture } from './picture';

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export const rect = (top: number, left: number, bottom: number, right: number): Rect => ({ top, left, bottom, right });
export const rectEmpty = (r: Rect) => r.right <= r.left || r.bottom <= r.top;
export const rectWidth = (r: Rect) => r.right - r.left;
export const rectHeight = (r: Rect) => r.bottom - r.top;
export function rectClip(r: Rect, c: Rect): Rect {
  return {
    top: Math.max(r.top, c.top),
    left: Math.max(r.left, c.left),
    bottom: Math.min(r.bottom, c.bottom),
    right: Math.min(r.right, c.right),
  };
}
export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
export function rectUnion(a: Rect, b: Rect): Rect {
  if (rectEmpty(a)) return { ...b };
  if (rectEmpty(b)) return { ...a };
  return {
    top: Math.min(a.top, b.top),
    left: Math.min(a.left, b.left),
    bottom: Math.max(a.bottom, b.bottom),
    right: Math.max(a.right, b.right),
  };
}
export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
}

function grabRect(buf: Uint8Array, c: Rect): Uint8Array {
  const w = c.right - c.left;
  const out = new Uint8Array(w * (c.bottom - c.top));
  let o = 0;
  for (let y = c.top; y < c.bottom; y++) {
    let i = y * SCREEN_W + c.left;
    for (let x = 0; x < w; x++) out[o++] = buf[i++];
  }
  return out;
}

function grabRect32(buf: Int32Array, c: Rect): Int32Array {
  const w = c.right - c.left;
  const out = new Int32Array(w * (c.bottom - c.top));
  for (let y = c.top, o = 0; y < c.bottom; y++, o += w) out.set(buf.subarray(y * SCREEN_W + c.left, y * SCREEN_W + c.right), o);
  return out;
}

function putRect32(buf: Int32Array, c: Rect, src: Int32Array): void {
  const w = c.right - c.left;
  for (let y = c.top, o = 0; y < c.bottom; y++, o += w) buf.set(src.subarray(o, o + w), y * SCREEN_W + c.left);
}

function putRect(buf: Uint8Array, c: Rect, src: Uint8Array): void {
  const w = c.right - c.left;
  let o = 0;
  for (let y = c.top; y < c.bottom; y++) {
    let i = y * SCREEN_W + c.left;
    for (let x = 0; x < w; x++) buf[i++] = src[o++];
  }
}

// ---------------------------------------------------------------- views

export interface SciCel {
  width: number;
  height: number;
  displaceX: number;
  displaceY: number;
  clearKey: number;
  pixels: Uint8Array;
}

export interface SciView {
  loops: { cels: SciCel[]; mirror: boolean }[];
}

export function decodeSciView(d: Uint8Array): SciView {
  const loopCount = d[0];
  const mirrorBits = d[2] | (d[3] << 8);
  const loops: SciView['loops'] = [];
  for (let l = 0; l < loopCount; l++) {
    const lo = d[8 + l * 2] | (d[9 + l * 2] << 8);
    const celCount = d[lo] | (d[lo + 1] << 8);
    const mirror = ((mirrorBits >> l) & 1) === 1;
    const cels: SciCel[] = [];
    for (let c = 0; c < celCount; c++) {
      const co = d[lo + 4 + c * 2] | (d[lo + 5 + c * 2] << 8);
      const width = d[co] | (d[co + 1] << 8);
      const height = d[co + 2] | (d[co + 3] << 8);
      let displaceX = (d[co + 4] << 24) >> 24;
      const displaceY = d[co + 5];
      const clearKey = d[co + 6];
      const count = width * height;
      const pixels = new Uint8Array(count);
      let p = co + 7;
      let n = 0;
      while (n < count && p < d.length) {
        const b = d[p++];
        const run = b >> 4;
        pixels.fill(b & 0x0f, n, Math.min(count, n + run));
        n += run;
      }
      if (mirror) {
        for (let y = 0; y < height; y++) pixels.subarray(y * width, (y + 1) * width).reverse();
        displaceX = -displaceX;
      }
      cels.push({ width, height, displaceX, displaceY, clearKey, pixels });
    }
    loops.push({ cels, mirror });
  }
  return { loops };
}

// ---------------------------------------------------------------- fonts

export class SciFont {
  readonly numChars: number;
  readonly height: number;
  private offsets: number[] = [];

  constructor(
    private d: Uint8Array,
    readonly id = 0,
  ) {
    this.numChars = d[2] | (d[3] << 8);
    this.height = d[4] | (d[5] << 8);
    for (let i = 0; i < this.numChars; i++) this.offsets.push(d[6 + i * 2] | (d[7 + i * 2] << 8));
  }

  charWidth(c: number): number {
    return c < this.numChars ? this.d[this.offsets[c]] : 0;
  }

  charHeight(c: number): number {
    return c < this.numChars ? this.d[this.offsets[c] + 1] : 0;
  }

  /** Draws a glyph at screen coordinates (visual + display only). */
  draw(scr: SciScreen, c: number, top: number, left: number, color: number, greyed: boolean): void {
    if (c >= this.numChars) return;
    const w = this.charWidth(c);
    const h = this.charHeight(c);
    let p = this.offsets[c] + 2;
    let gt = top;
    const own = scr.textOwner(c, this.id, left, top, w, h, color, greyed);
    let count = 0;
    for (let y = 0; y < h; y++) {
      const mask = greyed ? (gt++ % 2 ? 0xaa : 0x55) : 0xff;
      let b = 0;
      for (let x = 0; x < w; x++) {
        if ((x & 7) === 0) b = this.d[p++] & mask;
        if (b & 0x80) {
          const sx = left + x;
          const sy = top + y;
          if (sx >= 0 && sx < SCREEN_W && sy >= 0 && sy < SCREEN_H) {
            const o = sy * SCREEN_W + sx;
            scr.visual[o] = color;
            scr.display[o] = color;
            scr.owner[o] = own;
            count++;
          }
        }
        b = (b << 1) & 0xff;
      }
    }
    scr.textGlyphs.get(OWNER_TEXT_BASE - own)!.pixels = count;
  }
}

// ---------------------------------------------------------------- ports & windows

export const WINDOW_STYLE = {
  TRANSPARENT: 1 << 0,
  NOFRAME: 1 << 1,
  TITLE: 1 << 2,
  TOPMOST: 1 << 3,
  USER: 1 << 7,
};

export class Port {
  top = 0;
  left = 0;
  rect: Rect = rect(0, 0, SCREEN_H, SCREEN_W);
  curTop = 0;
  curLeft = 0;
  fontId = 0;
  fontHeight = 8;
  greyedOutput = false;
  penClr = 0;
  backClr = 15;
  penMode = 0;
  constructor(public id: number) {}
  get isWindow(): boolean {
    return this.id >= 2 && this.id !== 0xffff;
  }
}

export class Window extends Port {
  dims: Rect = rect(0, 0, 0, 0);
  restoreRect: Rect = rect(0, 0, 0, 0);
  wndStyle = 0;
  saveScreenMask = 0;
  hSaved1 = 0; // handles from bitsSave (VM hunk registers)
  hSaved2 = 0;
  title = '';
  drawn = false;
  /** Set when disposed; the window is really freed after this many kSetPort calls (Sierra compat). */
  counterTillFree = 0;
}

// ---------------------------------------------------------------- the graphics state

export class SciGfx {
  readonly screen = new SciScreen();
  private views = new Map<number, SciView>();
  private fonts = new Map<number, SciFont>();

  menuPort: Port;
  wmgrPort: Port;
  picWind: Window;
  curPort: Port;
  /** Back-to-front list of open ports (wmgr first). */
  windowList: Port[] = [];
  windowsById: (Port | null)[] = [];
  /** Saved screen areas, keyed by hunk register handed to scripts. */
  savedBits = new Map<number, { r: Rect; mask: number; vis?: Uint8Array; disp?: Uint8Array; own?: Int32Array; pri?: Uint8Array; ctl?: Uint8Array }>();
  private nextBits = 1;
  /** Allocates a script-visible handle for saved bits (set by the engine to use VM hunks). */
  allocHandle: (v: unknown) => number = () => this.nextBits++;
  freeHandle: (h: number) => void = () => undefined;

  constructor(readonly res: SciResources) {
    this.menuPort = new Port(0xffff);
    this.openPort(this.menuPort);
    this.menuPort.rect = rect(0, 0, SCREEN_H, SCREEN_W);

    this.wmgrPort = new Port(1);
    this.openPort(this.wmgrPort);
    // SQ3 1.018 uses the "new" SCI0 graphics functions: wmgr port origin is below the menu bar.
    this.wmgrPort.top = 10;
    this.wmgrPort.left = 0;
    this.wmgrPort.rect = rect(0, 0, SCREEN_H - 10, SCREEN_W);
    this.windowsById[0] = this.wmgrPort;
    this.windowsById[1] = this.wmgrPort;
    this.windowList.push(this.wmgrPort);

    const pic = new Window(2);
    this.openPort(pic);
    pic.top = 10;
    pic.left = 0;
    pic.rect = rect(0, 0, SCREEN_H - 10, SCREEN_W);
    pic.dims = rect(10, 0, SCREEN_H, SCREEN_W);
    pic.restoreRect = { ...pic.dims };
    pic.wndStyle = WINDOW_STYLE.TRANSPARENT | WINDOW_STYLE.NOFRAME;
    pic.drawn = true;
    this.picWind = pic;
    this.windowsById[2] = pic;
    this.windowList.push(pic);
    this.curPort = pic;
    this.screen.initPriorityBands(14, 42, 190);
  }

  // ---------------------------------------------------------------- resources

  view(n: number): SciView {
    let v = this.views.get(n);
    if (!v) {
      const d = this.res.get(ResType.View, n);
      if (!d) throw new Error(`View ${n} not found`);
      v = decodeSciView(d);
      this.views.set(n, v);
    }
    return v;
  }

  font(n: number): SciFont {
    let f = this.fonts.get(n);
    if (!f) {
      const d = this.res.get(ResType.Font, n) ?? this.res.get(ResType.Font, 0);
      if (!d) throw new Error(`Font ${n} not found`);
      f = new SciFont(d, n);
      this.fonts.set(n, f);
    }
    return f;
  }

  /** Clamps loop/cel numbers like Sierra did, returning the cel. */
  cel(viewNr: number, loop: number, cel: number): SciCel {
    const v = this.view(viewNr);
    const l = v.loops[Math.max(0, Math.min(loop, v.loops.length - 1))];
    return l.cels[Math.max(0, Math.min(cel, l.cels.length - 1))];
  }

  /** Rectangle a cel occupies when positioned at (x, y, z), in port coordinates. */
  celRect(viewNr: number, loop: number, cel: number, x: number, y: number, z: number): Rect {
    const c = this.cel(viewNr, loop, cel);
    const left = x + c.displaceX - (c.width >> 1);
    const bottom = y + c.displaceY - z + 1;
    return rect(bottom - c.height, left, bottom, left + c.width);
  }

  // ---------------------------------------------------------------- ports

  openPort(p: Port): void {
    p.fontId = 0;
    p.fontHeight = this.font(0).height;
    p.top = 0;
    p.left = 0;
    p.greyedOutput = false;
    p.penClr = 0;
    p.backClr = 15;
    p.penMode = 0;
    p.rect = rect(0, 0, SCREEN_H, SCREEN_W);
  }

  setPort(p: Port): Port {
    const old = this.curPort;
    this.curPort = p;
    return old;
  }

  portById(id: number): Port | null {
    if (id === 0xffff) return this.menuPort;
    return this.windowsById[id] ?? null;
  }

  setOrigin(left: number, top: number): void {
    this.curPort.left = left & 0xfffe;
    this.curPort.top = top;
  }

  offsetRect(r: Rect): Rect {
    const p = this.curPort;
    return { top: r.top + p.top, bottom: r.bottom + p.top, left: r.left + p.left, right: r.right + p.left };
  }

  setFont(id: number): void {
    this.curPort.fontId = id;
    this.curPort.fontHeight = this.font(id).height;
  }

  // ---------------------------------------------------------------- painting

  /** Draws a cel at a port-relative rectangle, honoring the priority screen. */
  drawCel(viewNr: number, loop: number, celNr: number, celRect: Rect, priority: number): void {
    const c = this.cel(viewNr, loop, celNr);
    const clip = rectClip(celRect, this.curPort.rect);
    if (rectEmpty(clip)) return;
    const t = this.offsetRect(clip);
    const scr = this.screen;
    const mask = priority > 15 ? MASK_VIS : MASK_VIS | MASK_PRI;
    const w = Math.min(rectWidth(clip), c.width);
    const h = Math.min(rectHeight(clip), c.height);
    const sx0 = clip.left - celRect.left;
    const sy0 = clip.top - celRect.top;
    const full = this.offsetRect(celRect);
    scr.curOwner = scr.placementId(viewNr, loop, celNr, full.left, full.top);
    for (let y = 0; y < h; y++) {
      const y2 = t.top + y;
      if (y2 < 0 || y2 >= SCREEN_H) continue;
      for (let x = 0; x < w; x++) {
        const color = c.pixels[(sy0 + y) * c.width + sx0 + x];
        if (color === c.clearKey) continue;
        const x2 = t.left + x;
        if (x2 < 0 || x2 >= SCREEN_W) continue;
        if (priority >= scr.priority[y2 * SCREEN_W + x2]) scr.putPixel(x2, y2, mask, color, priority, 0);
      }
    }
    scr.curOwner = OWNER_OTHER;
  }

  fillRect(r: Rect, drawFlags: number, color: number, priority = 0, control = 0): void {
    let c = rectClip(r, this.curPort.rect);
    if (rectEmpty(c)) return;
    c = this.offsetRect(c);
    const scr = this.screen;
    const penMode = this.curPort.penMode;
    if (drawFlags & MASK_VIS) {
      for (let y = c.top; y < c.bottom; y++) {
        for (let x = c.left; x < c.right; x++) {
          if (penMode === 2) {
            const cur = scr.visual[y * SCREEN_W + x];
            // Inverting keeps what drew the pixel (highlighted menu text is still text).
            scr.curOwner = scr.owner[y * SCREEN_W + x];
            if (cur === color) scr.putPixel(x, y, MASK_VIS, priority, 0, 0);
            else if (cur === priority) scr.putPixel(x, y, MASK_VIS, color, 0, 0);
            scr.curOwner = OWNER_OTHER;
          } else scr.putPixel(x, y, MASK_VIS, color, 0, 0);
        }
      }
    }
    if (drawFlags < 2) return;
    const flags = drawFlags & (MASK_PRI | MASK_CTL);
    for (let y = c.top; y < c.bottom; y++) {
      for (let x = c.left; x < c.right; x++) {
        if (penMode !== 2) scr.putPixel(x, y, flags, 0, priority & 15, control & 15);
        else {
          const o = y * SCREEN_W + x;
          scr.putPixel(x, y, flags, 0, scr.priority[o] ? 0 : 1, scr.control[o] ? 0 : 1);
        }
      }
    }
  }

  eraseRect(r: Rect): void {
    this.fillRect(r, MASK_VIS, this.curPort.backClr);
  }

  paintRect(r: Rect): void {
    this.fillRect(r, MASK_VIS, this.curPort.penClr);
  }

  frameRect(r: Rect): void {
    const p = this.curPort.penClr;
    this.fillRect(rect(r.top, r.left, r.top + 1, r.right), MASK_VIS, p);
    this.fillRect(rect(r.bottom - 1, r.left, r.bottom, r.right), MASK_VIS, p);
    this.fillRect(rect(r.top, r.left, r.bottom, r.left + 1), MASK_VIS, p);
    this.fillRect(rect(r.top, r.right - 1, r.bottom, r.right), MASK_VIS, p);
  }

  /** Inverts the visual colors in a rectangle (XOR with 15, as SCI0 EGA did). */
  invertRect(r: Rect): void {
    const old = this.curPort.penMode;
    this.curPort.penMode = 2;
    this.fillRect(r, MASK_VIS, this.curPort.penClr, this.curPort.backClr);
    this.curPort.penMode = old;
  }

  /** Copies a port-relative rectangle to what the player sees. */
  bitsShow(r: Rect): void {
    let c = rectClip(r, this.curPort.rect);
    if (rectEmpty(c)) return;
    c = this.offsetRect(c);
    this.screen.copyToOutput(c.left & 0xfffe, c.top, (c.right + 1) & 0xfffe, c.bottom);
  }

  /** Saves a port-relative rectangle of the given screens; returns a handle (0 if empty). */
  bitsSave(r: Rect, mask: number): number {
    let c = rectClip(r, this.curPort.rect);
    if (rectEmpty(c)) return 0;
    c = this.offsetRect(c);
    return this.bitsSaveScreen(c, mask);
  }

  /** Same as bitsSave but with a rectangle already in screen coordinates. */
  bitsSaveScreen(c: Rect, mask: number): number {
    c = rectClip(c, rect(0, 0, SCREEN_H, SCREEN_W));
    if (rectEmpty(c)) return 0;
    const s = this.screen;
    const entry = {
      r: c,
      mask,
      vis: mask & MASK_VIS ? grabRect(s.visual, c) : undefined,
      disp: mask & MASK_VIS ? grabRect(s.display, c) : undefined,
      own: mask & MASK_VIS ? grabRect32(s.owner, c) : undefined,
      pri: mask & MASK_PRI ? grabRect(s.priority, c) : undefined,
      ctl: mask & MASK_CTL ? grabRect(s.control, c) : undefined,
    };
    const h = this.allocHandle(entry);
    this.savedBits.set(h, entry);
    return h;
  }

  bitsRect(h: number): Rect | null {
    return this.savedBits.get(h)?.r ?? null;
  }

  /** Restores saved bits (screen coordinates are stored) and frees the handle. */
  bitsRestore(h: number): void {
    const e = this.savedBits.get(h);
    if (!e) return;
    const s = this.screen;
    if (e.vis) putRect(s.visual, e.r, e.vis);
    if (e.disp) putRect(s.display, e.r, e.disp);
    if (e.own) putRect32(s.owner, e.r, e.own);
    if (e.pri) putRect(s.priority, e.r, e.pri);
    if (e.ctl) putRect(s.control, e.r, e.ctl);
    this.bitsFree(h);
  }

  bitsFree(h: number): void {
    if (this.savedBits.delete(h)) this.freeHandle(h);
  }

  /** Clears the current port with a color (visual) and zeroes priority/control. */
  clearScreen(color: number): void {
    this.fillRect(this.curPort.rect, MASK_VIS | MASK_PRI | MASK_CTL, color, 0, 0);
  }

  /** Draws a picture resource into the current port (kDrawPic draws into the pic window). */
  drawPicture(picNr: number, mirrored: boolean, addTo: boolean, paletteNo: number): void {
    const data = this.res.get(ResType.Pic, picNr);
    if (!data) throw new Error(`Picture ${picNr} not found`);
    const scr = this.screen;
    if (!addTo) {
      scr.resetPlacements();
      scr.curOwner = OWNER_PICTURE;
      this.clearScreen(15);
    }
    const p = this.curPort;
    try {
      drawSciPicture(data, scr, { top: p.top, left: p.left, rect: p.rect }, { mirrored, addTo, paletteNo });
    } finally {
      scr.curOwner = OWNER_OTHER;
    }
    // Remember the untouched room picture so a host can swap in a repainted version (AI images mode).
    if (!addTo) this.basePicture = { nr: picNr, mirrored, visual: this.screen.visual.slice() };
  }

  /** The last full (non-overlay) picture drawn and its visual layer right after drawing. */
  basePicture: { nr: number; mirrored: boolean; visual: Uint8Array } | null = null;

  /** Draws text with the current port's font/colors at the pen position (no wrapping). */
  drawString(text: string): void {
    const p = this.curPort;
    const f = this.font(p.fontId);
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i) & 0xff;
      const w = f.charWidth(ch);
      f.draw(this.screen, ch, p.curTop + p.top, p.curLeft + p.left, p.penClr, p.greyedOutput);
      p.curLeft += w;
    }
  }

  stringWidth(text: string, fontId = this.curPort.fontId): number {
    const f = this.font(fontId);
    let w = 0;
    for (let i = 0; i < text.length; i++) w += f.charWidth(text.charCodeAt(i) & 0xff);
    return w;
  }
}
