// SCI0 EGA picture decoder. Draws vector data into the visual, priority and control
// screens, then dithers the visual screen (each "color" is a pair of EGA colors).

import { SciScreen, MASK_VIS, MASK_PRI, MASK_CTL, SCREEN_W, SCREEN_H } from './screen';

const DEFAULT_PALETTE = [
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x88,
  0x88, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x88, 0x88, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
  0x08, 0x19, 0x2a, 0x3b, 0x4c, 0x5d, 0x6e, 0x88,
];

const CIRCLES: number[][] = [
  [0x01],
  [0x72, 0x02],
  [0xce, 0xf7, 0x7d, 0x0e],
  [0x1c, 0x3e, 0x7f, 0x7f, 0x7f, 0x3e, 0x1c, 0x00],
  [0x38, 0xf8, 0xf3, 0xdf, 0x7f, 0xff, 0xfd, 0xf7, 0x9f, 0x3f, 0x38],
  [0x70, 0xc0, 0x1f, 0xfe, 0xe3, 0x3f, 0xff, 0xf7, 0x7f, 0xff, 0xe7, 0x3f, 0xfe, 0xc3, 0x1f, 0xf8, 0x00],
  [0xf0, 0x01, 0xff, 0xe1, 0xff, 0xf8, 0x3f, 0xff, 0xdf, 0xff, 0xf7, 0xff, 0xfd, 0x7f, 0xff, 0x9f, 0xff, 0xe3, 0xff, 0xf0, 0x1f, 0xf0, 0x01],
  [0xe0, 0x03, 0xf8, 0x0f, 0xfc, 0x1f, 0xfe, 0x3f, 0xfe, 0x3f, 0xff, 0x7f, 0xff, 0x7f, 0xff, 0x7f, 0xff, 0x7f, 0xff, 0x7f, 0xfe, 0x3f, 0xfe, 0x3f, 0xfc, 0x1f, 0xf8, 0x0f, 0xe0, 0x03],
];

// Spray-brush texture bits (read bit 0 upward), 32 bytes repeated twice; bit 256 is never used.
const TEXTURE_BYTES = [
  0x04, 0x29, 0x40, 0x24, 0x09, 0x41, 0x25, 0x45, 0x41, 0x90, 0x50, 0x44, 0x48, 0x08, 0x42, 0x28,
  0x89, 0x52, 0x89, 0x88, 0x10, 0x48, 0xa4, 0x08, 0x44, 0x15, 0x28, 0x24, 0x00, 0x0a, 0x24, 0x20,
];
const TEXTURE_BITS: boolean[] = [];
for (let r = 0; r < 2; r++) {
  const half: boolean[] = [];
  for (const b of TEXTURE_BYTES) for (let bit = 0; bit < 8; bit++) half.push(((b >> bit) & 1) === 1);
  half.pop(); // the original interpreter ignores the 256th bit
  TEXTURE_BITS.push(...half);
}
const TEXTURE_OFFSET = [
  0x00, 0x18, 0x30, 0xc4, 0xdc, 0x65, 0xeb, 0x48, 0x60, 0xbd, 0x89, 0x04, 0x0a, 0xf4, 0x7d, 0x6d,
  0x85, 0xb0, 0x8e, 0x95, 0x1f, 0x22, 0x0d, 0xdf, 0x2a, 0x78, 0xd5, 0x73, 0x1c, 0xb4, 0x40, 0xa1,
  0xb9, 0x3c, 0xca, 0x58, 0x92, 0x34, 0xcc, 0xce, 0xd7, 0x42, 0x90, 0x0f, 0x8b, 0x7f, 0x32, 0xed,
  0x5c, 0x9d, 0xc8, 0x99, 0xad, 0x4e, 0x56, 0xa6, 0xf7, 0x68, 0xb7, 0x25, 0x82, 0x37, 0x3a, 0x51,
  0x69, 0x26, 0x38, 0x52, 0x9e, 0x9a, 0x4f, 0xa7, 0x43, 0x10, 0x80, 0xee, 0x3d, 0x59, 0x35, 0xcf,
  0x79, 0x74, 0xb5, 0xa2, 0xb1, 0x96, 0x23, 0xe0, 0xbe, 0x05, 0xf5, 0x6e, 0x19, 0xc5, 0x66, 0x49,
  0xf0, 0xd1, 0x54, 0xa9, 0x70, 0x4b, 0xa4, 0xe2, 0xe6, 0xe5, 0xab, 0xe4, 0xd2, 0xaa, 0x4c, 0xe3,
  0x06, 0x6f, 0xc6, 0x4a, 0x75, 0xa3, 0x97, 0xe1,
];

export interface PicPort {
  top: number; // screen y of the picture's origin (10 below the menu bar)
  left: number;
  rect: { top: number; left: number; bottom: number; right: number }; // relative to origin
}

export function drawSciPicture(
  data: Uint8Array,
  scr: SciScreen,
  port: PicPort,
  opts: { mirrored?: boolean; addTo?: boolean; paletteNo?: number } = {},
): void {
  const mirrored = !!opts.mirrored;
  const palettes = new Uint8Array(160);
  for (let i = 0; i < 160; i += 40) palettes.set(DEFAULT_PALETTE, i);
  const palBase = ((opts.paletteNo ?? 0) < 4 ? opts.paletteNo ?? 0 : 0) * 40;
  let color = 0;
  let priority = 255;
  let control = 255;
  let x = 0;
  let y = 0;
  let patCode = 0;
  let patTexture = 0;
  let p = 0;
  const nonOp = () => p < data.length && data[p] < 0xf0;

  const abs = () => {
    const b = data[p++];
    x = data[p++] + ((b & 0xf0) << 4);
    y = data[p++] + ((b & 0x0f) << 8);
    if (mirrored) x = 319 - x;
  };
  const relShort = () => {
    const b = data[p++];
    const m = mirrored ? -1 : 1;
    if (b & 0x80) x -= ((b >> 4) & 7) * m;
    else x += (b >> 4) * m;
    if (b & 0x08) y -= b & 7;
    else y += b & 7;
  };
  const relMed = () => {
    let b = data[p++];
    if (b & 0x80) y -= b & 0x7f;
    else y += b;
    b = data[p++];
    const m = mirrored ? -1 : 1;
    if (b & 0x80) x -= (128 - (b & 0x7f)) * m;
    else x += b * m;
  };
  const texture = () => {
    if (patCode & 0x20) patTexture = (data[p++] >> 1) & 0x7f;
  };
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    scr.drawLine(x1 + port.left, y1 + port.top, x2 + port.left, y2 + port.top, color, priority, control);
  const pattern = () => drawPattern(scr, port, x, y, color, priority, control, patCode, patTexture);

  while (p < data.length) {
    const op = data[p++];
    switch (op) {
      case 0xf0:
        color = palettes[palBase + data[p++]] ?? 0;
        color ^= (color << 4) & 0xff;
        break;
      case 0xf1:
        color = 255;
        break;
      case 0xf2:
        priority = data[p++] & 0x0f;
        break;
      case 0xf3:
        priority = 255;
        break;
      case 0xfb:
        control = data[p++] & 0x0f;
        break;
      case 0xfc:
        control = 255;
        break;
      case 0xf7: // short relative lines
        abs();
        while (nonOp()) {
          const ox = x, oy = y;
          relShort();
          line(ox, oy, x, y);
        }
        break;
      case 0xf5: // medium relative lines
        abs();
        while (nonOp()) {
          const ox = x, oy = y;
          relMed();
          line(ox, oy, x, y);
        }
        break;
      case 0xf6: // absolute lines
        abs();
        while (nonOp()) {
          const ox = x, oy = y;
          abs();
          line(ox, oy, x, y);
        }
        break;
      case 0xf8:
        while (nonOp()) {
          abs();
          floodFill(scr, port, x, y, color, priority, control);
        }
        break;
      case 0xf9:
        patCode = data[p++];
        break;
      case 0xf4:
      case 0xfd:
        texture();
        abs();
        pattern();
        while (nonOp()) {
          texture();
          if (op === 0xf4) relShort();
          else relMed();
          pattern();
        }
        break;
      case 0xfa:
        while (nonOp()) {
          texture();
          abs();
          pattern();
        }
        break;
      case 0xfe: {
        const sub = data[p++];
        switch (sub) {
          case 0:
            while (nonOp()) {
              const i = data[p++];
              const c = data[p++];
              if (i < 160) palettes[i] = c;
            }
            break;
          case 1: {
            const n = data[p++] % 4;
            for (let i = 0; i < 40; i++) palettes[n * 40 + i] = data[p++];
            break;
          }
          case 2:
            p += 41;
            break;
          case 3:
          case 5:
            p++;
            break;
          case 4:
          case 6:
            break;
          case 7: {
            // embedded view: skip (not used by SCI0 EGA games we target)
            p += 3;
            const size = data[p] | (data[p + 1] << 8);
            p += 2 + size;
            break;
          }
          case 8:
            scr.setPriorityBandsExplicit(data.subarray(p, p + 14));
            p += 14;
            break;
          default:
            throw new Error(`Unknown picture extended op ${sub}`);
        }
        break;
      }
      case 0xff:
        scr.dither();
        return;
      default:
        throw new Error(`Unknown picture op 0x${op.toString(16)} at ${p - 1}`);
    }
  }
  scr.dither();
}

function mask(color: number, pri: number, ctl: number): number {
  return (color !== 255 ? MASK_VIS : 0) | (pri !== 255 ? MASK_PRI : 0) | (ctl !== 255 ? MASK_CTL : 0);
}

function floodFill(scr: SciScreen, port: PicPort, x0: number, y0: number, color: number, pri: number, ctl: number): void {
  let screenMask = mask(color, pri, ctl);
  const px = x0 + port.left;
  const py = y0 + port.top;
  if (px < 0 || py < 0 || px >= SCREEN_W || py >= SCREEN_H) return;
  const o = py * SCREEN_W + px;
  let searchColor = scr.visual[o];
  if ((x0 ^ y0) & 1) searchColor = (searchColor ^ (searchColor >> 4)) & 0x0f;
  else searchColor &= 0x0f;
  const searchPri = scr.priority[o];
  const searchCtl = scr.control[o];
  if (screenMask & MASK_VIS) {
    if (color === 15 || searchColor !== 15) return;
  } else if (screenMask & MASK_PRI) {
    if (pri === 0 || searchPri !== 0) return;
  } else if (screenMask & MASK_CTL) {
    if (ctl === 0 || searchCtl !== 0) return;
  }
  if (screenMask & MASK_VIS && searchColor === color) screenMask &= ~MASK_VIS;
  if (screenMask & MASK_PRI && searchPri === pri) screenMask &= ~MASK_PRI;
  if (screenMask & MASK_CTL && searchCtl === ctl) screenMask &= ~MASK_CTL;
  if (!screenMask) return;
  const matchMask = screenMask & MASK_VIS ? MASK_VIS : screenMask & MASK_PRI ? MASK_PRI : MASK_CTL;

  const match = (x: number, y: number): boolean => {
    const i = y * SCREEN_W + x;
    if (matchMask === MASK_VIS) {
      let c = scr.visual[i];
      c = (x ^ y) & 1 ? (c ^ (c >> 4)) & 0x0f : c & 0x0f;
      return c === searchColor;
    }
    if (matchMask === MASK_PRI) return scr.priority[i] === searchPri;
    return scr.control[i] === searchCtl;
  };
  const put = (x: number, y: number) => scr.putPixel(x, y, screenMask, color, pri, ctl);

  const bl = port.rect.left + port.left;
  const bt = port.rect.top + port.top;
  const br = port.rect.right + port.left - 1;
  const bb = port.rect.bottom + port.top - 1;
  const stack: number[] = [px, py];
  while (stack.length) {
    const sy = stack.pop()!;
    const sx = stack.pop()!;
    if (!match(sx, sy)) continue;
    put(sx, sy);
    let l = sx;
    let r = sx;
    while (l > bl && match(l - 1, sy)) put(--l, sy);
    while (r < br && match(r + 1, sy)) put(++r, sy);
    let aSet = false;
    let bSet = false;
    for (; l <= r; l++) {
      if (sy > bt && match(l, sy - 1)) {
        if (!aSet) {
          stack.push(l, sy - 1);
          aSet = true;
        }
      } else aSet = false;
      if (sy < bb && match(l, sy + 1)) {
        if (!bSet) {
          stack.push(l, sy + 1);
          bSet = true;
        }
      } else bSet = false;
    }
  }
}

function drawPattern(
  scr: SciScreen, port: PicPort, x: number, y: number,
  color: number, pri: number, ctl: number, code: number, texture: number,
): void {
  const size = code & 7;
  let left = x - size;
  let top = y - size;
  const w = size * 2 + 2;
  const h = size * 2 + 1;
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  left += port.left;
  top += port.top;
  if (left + w > SCREEN_W + 1) left = SCREEN_W + 1 - w;
  if (top + h > SCREEN_H) top = SCREEN_H - h;
  const m = mask(color, pri, ctl);
  const useTexture = (code & 0x20) !== 0;
  let t = TEXTURE_OFFSET[texture & 0x7f];

  if (code & 0x10) {
    // rectangle
    for (let yy = top; yy < top + h; yy++) {
      for (let xx = left; xx < left + w; xx++) {
        if (useTexture && !TEXTURE_BITS[t++]) continue;
        if (yy < 0 || yy >= SCREEN_H || xx < 0) continue;
        if (xx < SCREEN_W) scr.putPixel(xx, yy, m, color, pri, ctl);
        else if (yy < SCREEN_H - 1) {
          // wraps to the next row with the opposite dither color
          let c = color;
          if (c & 0xf0) {
            c ^= (c << 4) & 0xff;
            c = ((c << 4) | (c >> 4)) & 0xff;
            c ^= (c << 4) & 0xff;
          }
          scr.putPixel(0, yy + 1, m, c, pri, ctl);
        }
      }
    }
  } else {
    const circle = CIRCLES[size];
    let ci = 0;
    let bitmap = circle[0];
    let bitNo = 0;
    for (let yy = top; yy < top + h; yy++) {
      for (let xx = left; xx < left + w; xx++) {
        if (bitNo === 8) {
          bitmap = circle[++ci] ?? 0;
          bitNo = 0;
        }
        if (bitmap & 1) {
          const draw = !useTexture || TEXTURE_BITS[t++];
          if (draw && xx >= 0 && yy >= 0 && xx < SCREEN_W && yy < SCREEN_H) scr.putPixel(xx, yy, m, color, pri, ctl);
        }
        bitNo++;
        bitmap >>= 1;
      }
    }
  }
}
