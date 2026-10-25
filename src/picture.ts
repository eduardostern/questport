// AGI picture decoder. Pictures are vector drawing commands that render into two
// 160x168 buffers: the visual screen (16 EGA colors) and the priority/control screen.

export const PIC_W = 160;
export const PIC_H = 168;

const CIRCLE_LIST = [0, 1, 4, 9, 16, 25, 37, 50];
const CIRCLE_DATA = [
  0x8000,
  0xe000, 0xe000, 0xe000,
  0x7000, 0xf800, 0xf800, 0xf800, 0x7000,
  0x3800, 0x7c00, 0xfe00, 0xfe00, 0xfe00, 0x7c00, 0x3800,
  0x1c00, 0x7f00, 0xff80, 0xff80, 0xff80, 0xff80, 0xff80, 0x7f00, 0x1c00,
  0x0e00, 0x3f80, 0x7fc0, 0x7fc0, 0xffe0, 0xffe0, 0xffe0, 0x7fc0, 0x7fc0, 0x3f80, 0x1f00, 0x0e00,
  0x0f80, 0x3fe0, 0x7ff0, 0x7ff0, 0xfff8, 0xfff8, 0xfff8, 0xfff8, 0xfff8, 0x7ff0, 0x7ff0, 0x3fe0, 0x0f80,
  0x07c0, 0x1ff0, 0x3ff8, 0x7ffc, 0x7ffc, 0xfffe, 0xfffe, 0xfffe, 0xfffe, 0xfffe, 0x7ffc, 0x7ffc, 0x3ff8, 0x1ff0, 0x07c0,
];

export class PictureBuffer {
  vis = new Uint8Array(PIC_W * PIC_H);
  pri = new Uint8Array(PIC_W * PIC_H);

  constructor() {
    this.clear();
  }

  clear(): void {
    this.vis.fill(15);
    this.pri.fill(4);
  }

  copyFrom(o: PictureBuffer): void {
    this.vis.set(o.vis);
    this.pri.set(o.pri);
  }
}

class PictureDrawer {
  private pos = 0;
  private visOn = false;
  private priOn = false;
  private visColor = 0;
  private priColor = 0;
  private patCode = 0;
  private patNum = 0;

  constructor(private data: Uint8Array, private buf: PictureBuffer) {}

  private next(): number {
    return this.pos < this.data.length ? this.data[this.pos++] : 0xff;
  }

  private peek(): number {
    return this.pos < this.data.length ? this.data[this.pos] : 0xff;
  }

  private plot(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= PIC_W || y >= PIC_H) return;
    const i = y * PIC_W + x;
    if (this.visOn) this.buf.vis[i] = this.visColor;
    if (this.priOn) this.buf.pri[i] = this.priColor;
  }

  private line(x1: number, y1: number, x2: number, y2: number): void {
    x1 = Math.min(Math.max(x1, 0), PIC_W - 1);
    x2 = Math.min(Math.max(x2, 0), PIC_W - 1);
    y1 = Math.min(Math.max(y1, 0), PIC_H - 1);
    y2 = Math.min(Math.max(y2, 0), PIC_H - 1);
    if (x1 === x2) {
      if (y1 > y2) [y1, y2] = [y2, y1];
      for (; y1 <= y2; y1++) this.plot(x1, y1);
      return;
    }
    if (y1 === y2) {
      if (x1 > x2) [x1, x2] = [x2, x1];
      for (; x1 <= x2; x1++) this.plot(x1, y1);
      return;
    }
    let x = x1;
    let y = y1;
    let stepY = 1;
    let deltaY = y2 - y1;
    if (deltaY < 0) {
      stepY = -1;
      deltaY = -deltaY;
    }
    let stepX = 1;
    let deltaX = x2 - x1;
    if (deltaX < 0) {
      stepX = -1;
      deltaX = -deltaX;
    }
    let i: number, detdelta: number, errorX: number, errorY: number;
    if (deltaY > deltaX) {
      i = deltaY;
      detdelta = deltaY;
      errorX = deltaY >> 1;
      errorY = 0;
    } else {
      i = deltaX;
      detdelta = deltaX;
      errorX = 0;
      errorY = deltaX >> 1;
    }
    this.plot(x, y);
    do {
      errorY += deltaY;
      if (errorY >= detdelta) {
        errorY -= detdelta;
        y += stepY;
      }
      errorX += deltaX;
      if (errorX >= detdelta) {
        errorX -= detdelta;
        x += stepX;
      }
      this.plot(x, y);
      i--;
    } while (i > 0);
  }

  private fillOk(i: number): boolean {
    if (!this.visOn && !this.priOn) return false;
    if (!this.priOn && this.visOn && this.visColor !== 15) return this.buf.vis[i] === 15;
    if (this.priOn && !this.visOn && this.priColor !== 4) return this.buf.pri[i] === 4;
    return this.visOn && this.buf.vis[i] === 15 && this.visColor !== 15;
  }

  private fill(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= PIC_W || y >= PIC_H) return;
    if (!this.fillOk(y * PIC_W + x)) return;
    const stack: number[] = [x, y];
    while (stack.length) {
      const sy = stack.pop()!;
      let sx = stack.pop()!;
      if (!this.fillOk(sy * PIC_W + sx)) continue;
      while (sx > 0 && this.fillOk(sy * PIC_W + sx - 1)) sx--;
      let upOpen = false;
      let downOpen = false;
      for (; sx < PIC_W && this.fillOk(sy * PIC_W + sx); sx++) {
        this.plot(sx, sy);
        if (sy > 0) {
          const ok = this.fillOk((sy - 1) * PIC_W + sx);
          if (ok && !upOpen) stack.push(sx, sy - 1);
          upOpen = ok;
        }
        if (sy < PIC_H - 1) {
          const ok = this.fillOk((sy + 1) * PIC_W + sx);
          if (ok && !downOpen) stack.push(sx, sy + 1);
          downOpen = ok;
        }
      }
    }
  }

  private plotPattern(x: number, y: number): void {
    const penSize = this.patCode & 7;
    let circlePtr = CIRCLE_LIST[penSize];
    let penX = x * 2 - penSize;
    if (penX < 0) penX = 0;
    const maxX = PIC_W * 2 - 2 * penSize;
    if (penX >= maxX) penX = maxX;
    penX >>= 1;
    const penStartX = penX;
    let penY = y - penSize;
    if (penY < 0) penY = 0;
    const maxY = 167 - 2 * penSize;
    if (penY >= maxY) penY = maxY;
    let t = (this.patNum | 1) & 0xff;
    const size = (penSize << 1) + 1;
    const penFinalY = penY + size;
    const penWidth = size << 1;
    const rect = (this.patCode & 0x10) !== 0;
    const splatter = (this.patCode & 0x20) !== 0;
    for (; penY < penFinalY; penY++) {
      const word = CIRCLE_DATA[circlePtr++];
      for (let counter = 0; counter <= penWidth; counter += 4) {
        if (rect || ((0x8000 >> (counter >> 1)) & word) !== 0) {
          if (splatter) {
            const bit = t & 1;
            t >>= 1;
            if (bit) t ^= 0xb8;
          }
          if (!splatter || (t & 3) === 1) this.plot(penX, penY);
        }
        penX++;
      }
      penX = penStartX;
    }
  }

  draw(): void {
    for (;;) {
      const cmd = this.next();
      if (cmd === 0xff) return;
      switch (cmd) {
        case 0xf0:
          this.visColor = this.next() & 0x0f;
          this.visOn = true;
          break;
        case 0xf1:
          this.visOn = false;
          break;
        case 0xf2:
          this.priColor = this.next() & 0x0f;
          this.priOn = true;
          break;
        case 0xf3:
          this.priOn = false;
          break;
        case 0xf4:
          this.corner(true);
          break;
        case 0xf5:
          this.corner(false);
          break;
        case 0xf6: {
          // absolute line
          if (this.peek() >= 0xf0) break;
          let x1 = this.next();
          if (this.peek() >= 0xf0) break;
          let y1 = this.next();
          this.plot(x1, y1);
          for (;;) {
            if (this.peek() >= 0xf0) break;
            const x2 = this.next();
            if (this.peek() >= 0xf0) break;
            const y2 = this.next();
            this.line(x1, y1, x2, y2);
            x1 = x2;
            y1 = y2;
          }
          break;
        }
        case 0xf7: {
          // relative line
          if (this.peek() >= 0xf0) break;
          let x1 = this.next();
          if (this.peek() >= 0xf0) break;
          let y1 = this.next();
          this.plot(x1, y1);
          while (this.peek() < 0xf0) {
            const d = this.next();
            const dx = (d & 0x80 ? -1 : 1) * ((d >> 4) & 7);
            const dy = (d & 0x08 ? -1 : 1) * (d & 7);
            const x2 = x1 + dx;
            const y2 = y1 + dy;
            this.line(x1, y1, x2, y2);
            x1 = x2;
            y1 = y2;
          }
          break;
        }
        case 0xf8:
          while (this.peek() < 0xf0) {
            const x = this.next();
            if (this.peek() >= 0xf0) break;
            const y = this.next();
            this.fill(x, y);
          }
          break;
        case 0xf9:
          this.patCode = this.next();
          break;
        case 0xfa:
          for (;;) {
            if (this.patCode & 0x20) {
              if (this.peek() >= 0xf0) break;
              this.patNum = (this.next() >> 1) & 0x7f;
            }
            if (this.peek() >= 0xf0) break;
            const x = this.next();
            if (this.peek() >= 0xf0) break;
            const y = this.next();
            this.plotPattern(x, y);
          }
          break;
        default:
          // Unknown command: skip until the next command byte.
          while (this.peek() < 0xf0) this.pos++;
          break;
      }
    }
  }

  private corner(yFirst: boolean): void {
    if (this.peek() >= 0xf0) return;
    let x1 = this.next();
    if (this.peek() >= 0xf0) return;
    let y1 = this.next();
    this.plot(x1, y1);
    let doY = yFirst;
    while (this.peek() < 0xf0) {
      const v = this.next();
      if (doY) {
        this.line(x1, y1, x1, v);
        y1 = v;
      } else {
        this.line(x1, y1, v, y1);
        x1 = v;
      }
      doY = !doY;
    }
  }
}

/** Draws picture data into the buffer. If clear is true the buffer is reset first (draw.pic vs overlay.pic). */
export function drawPicture(data: Uint8Array, buf: PictureBuffer, clear: boolean): void {
  if (clear) buf.clear();
  new PictureDrawer(data, buf).draw();
}
