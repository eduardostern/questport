// Blends repainted ("AI") art with the original EGA frame at 4x resolution.
//
// Every screen pixel records what drew it (SciScreen.outOwner): the room picture, a sprite cel
// placement, or something else. Room-picture pixels come from the repainted background, sprite pixels
// from the repainted sprite sheet of that view, everything else (text, window frames, the cursor,
// art without a repaint) from the original EGA colors. The original pixel shapes decide what is
// visible, so priority (walking behind things) and the game's logic are unchanged.

import type { CelPlacement } from './screen';

export const AI_SCALE = 4;
export const PIC_TOP = 10;
export const OUT_W = 320 * AI_SCALE;
export const OUT_H = 200 * AI_SCALE;

/** RGBA pixels as a canvas ImageData Uint32 view (0xAABBGGRR on little-endian). */
export interface RgbaImage {
  w: number;
  h: number;
  px: Uint32Array;
}

/** Where a cel lives in a repainted sprite sheet, in original (unscaled) pixels. */
export interface CelArt {
  img: RgbaImage; // sheet scaled so one original pixel is AI_SCALE x AI_SCALE
  x: number;
  y: number;
  w: number;
  h: number;
  flip: boolean; // mirrored loop: sample the source loop flipped horizontally
  /** Screen pixels per original cel pixel horizontally (2 for AGI's double-wide pixels). */
  xs: number;
}

export interface ComposeInput {
  frame: Uint8Array; // 320x200 EGA indices (what the player sees, cursor included)
  owner: Int32Array; // SciScreen.outOwner
  placements: Map<number, CelPlacement>;
  /** Pixels that must stay original (open windows and menus): 1 = original. */
  forced: Uint8Array;
  /** The room picture's visual layer as drawn, or null when no repaint applies. */
  baseVisual: Uint8Array | null;
  background: RgbaImage | null; // 320*S x picH*S, already mirrored if needed
  /** First screen row of the picture area (10 for SCI, 8 for AGI). */
  picTop?: number;
  cel: (view: number, loop: number, cel: number) => CelArt | null;
  palette: Uint32Array; // EGA colors in the same packing as RgbaImage
}

/** Sprite sheets are painted on flat gray (119,119,119); near-gray samples at a sprite's edge are background. */
function isSheetGray(c: number): boolean {
  const r = c & 255;
  const g = (c >> 8) & 255;
  const b = (c >> 16) & 255;
  return Math.abs(r - 119) < 22 && Math.abs(g - 119) < 22 && Math.abs(b - 119) < 22 && Math.max(r, g, b) - Math.min(r, g, b) < 14;
}

/** Writes the blended frame into `out` (OUT_W x OUT_H). */
export function composeFrame(inp: ComposeInput, out: Uint32Array): void {
  const S = AI_SCALE;
  const { frame, owner, placements, forced, baseVisual, background, palette } = inp;
  const picTop = inp.picTop ?? PIC_TOP;
  const picBottom = background ? picTop + background.h / S : 200;
  const celCache = new Map<number, CelArt | null>();
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      const i = y * 320 + x;
      const o = owner[i];
      let src: RgbaImage | null = null;
      let sx = 0;
      let sy = 0;
      let flip = false;
      let edge = false;
      if (!forced[i] && y >= picTop && y < picBottom) {
        if (o === 0) {
          // Room picture: only if the pixel still shows the picture (guards against untracked writers).
          if (background && baseVisual && frame[i] === baseVisual[i]) {
            src = background;
            sx = x * S;
            sy = (y - picTop) * S;
          }
        } else if (o > 0) {
          let art = celCache.get(o);
          if (art === undefined) {
            const p = placements.get(o);
            art = p ? inp.cel(p.view, p.loop, p.cel) : null;
            celCache.set(o, art);
          }
          const p = art && placements.get(o);
          if (art && p) {
            let lx = x - p.left;
            const ly = y - p.top;
            if (lx >= 0 && ly >= 0 && lx < art.w * art.xs && ly < art.h) {
              if (art.flip) lx = art.w * art.xs - 1 - lx;
              src = art.img;
              sx = art.x * art.xs * S + lx * S;
              sy = (art.y + ly) * S;
              flip = art.flip;
              // On the sprite's outline, gray sheet background showing through is made transparent.
              edge =
                x === 0 || x === 319 || owner[i - 1] !== o || owner[i + 1] !== o ||
                owner[i - 320] !== o || (y < 199 && owner[i + 320] !== o);
            }
          }
        }
      }
      const ob = y * S * OUT_W + x * S;
      if (!src) {
        const c = palette[frame[i] & 15];
        for (let by = 0; by < S; by++) out.fill(c, ob + by * OUT_W, ob + by * OUT_W + S);
        continue;
      }
      const sp = src.px;
      const sw = src.w;
      for (let by = 0; by < S; by++) {
        const row = (sy + by) * sw + sx;
        const dst = ob + by * OUT_W;
        if (flip) for (let bx = 0; bx < S; bx++) out[dst + bx] = sp[row + S - 1 - bx];
        else for (let bx = 0; bx < S; bx++) out[dst + bx] = sp[row + bx];
        if (edge) {
          for (let bx = 0; bx < S; bx++) {
            if (!isSheetGray(out[dst + bx])) continue;
            // Show the room behind (the repainted background, or the original color if there is none).
            out[dst + bx] =
              background && y >= picTop && y < picBottom
                ? background.px[((y - picTop) * S + by) * background.w + x * S + bx]
                : palette[frame[i] & 15];
          }
        }
      }
    }
  }
}

/** Marks open windows and the pulled-down menu as "keep original". */
export function forcedMask(
  windows: { top: number; left: number; bottom: number; right: number }[],
  out: Uint8Array,
  cursor?: Uint8Array,
): Uint8Array {
  if (cursor) out.set(cursor);
  else out.fill(0);
  for (const r of windows) {
    for (let y = Math.max(0, r.top); y < Math.min(200, r.bottom); y++) {
      out.fill(1, y * 320 + Math.max(0, r.left), y * 320 + Math.min(320, r.right));
    }
  }
  return out;
}

/** Manifest written by tools/sci-ai-views.ts for one view's repainted sprite sheet(s). */
export interface ViewSheetManifest {
  sheets: { file: string; w: number; h: number }[]; // w/h in original pixels
  cels: Record<string, { sheet: number; x: number; y: number; w: number; h: number }>; // key "loop,cel"
  mirrors: Record<string, number>; // mirrored loop -> source loop
  /** Screen pixels per cel pixel horizontally (AGI: 2). Sheets are decoded at w*xs*AI_SCALE wide. */
  xs?: number;
}

/** Resolves a cel of a view to its place in the decoded sheets. */
export function lookupCel(m: ViewSheetManifest, sheets: (RgbaImage | null)[], loop: number, cel: number): CelArt | null {
  const src = m.mirrors[loop];
  const flip = src !== undefined;
  const e = m.cels[`${flip ? src : loop},${cel}`];
  if (!e) return null;
  const img = sheets[e.sheet];
  if (!img) return null;
  return { img, x: e.x, y: e.y, w: e.w, h: e.h, flip, xs: m.xs ?? 1 };
}
