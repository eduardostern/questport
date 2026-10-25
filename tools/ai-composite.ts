// Headless version of src/sci-ai.ts: blends repainted art with the EGA frame (1280x800 RGB).
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { SciEngine } from '../src/sci/engine';
import { EGA } from '../src/palette';
import { Window } from '../src/sci/gfx';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { eraseText, drawRuns, drawMasked, TEXT_FONT_FAMILY, TextContext } from '../src/sci/ai-text';
import type { AiFrame } from '../src/ai-render';
import type { Interpreter } from '../src/interpreter';
import { agiText } from '../src/agi-ai';
import { PIC_W, PIC_H } from '../src/picture';
import { composeFrame, forcedMask, lookupCel, AI_SCALE, OUT_W, OUT_H, RgbaImage, ViewSheetManifest } from '../src/sci/ai-compose';

const cache = new Map<string, RgbaImage>();

/** Loads an image scaled to w x h (macOS sips -> BMP) as packed RGBA. */
export function loadImage(path: string, w: number, h: number, mirrored = false): RgbaImage {
  const key = `${path}:${w}:${h}:${mirrored}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const dir = `${tmpdir()}/sci-ai`;
  mkdirSync(dir, { recursive: true });
  const bmp = `${dir}/${key.replace(/\W/g, '_')}.bmp`;
  execFileSync('sips', ['-s', 'format', 'bmp', '-z', String(h), String(w), path, '--out', bmp], { stdio: 'ignore' });
  const b = readFileSync(bmp);
  const off = b.readUInt32LE(10);
  const bw = b.readInt32LE(18);
  const bh = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28) / 8;
  const stride = Math.ceil((bw * bpp) / 4) * 4;
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = bh > 0 ? bh - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const o = off + sy * stride + (mirrored ? w - 1 - x : x) * bpp;
      px[y * w + x] = ((255 << 24) | (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0;
    }
  }
  const img = { w, h, px };
  cache.set(key, img);
  return img;
}

const pal = new Uint32Array(EGA.map(([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0));

/** Node version of AiRenderer: blends one described frame and returns 1280x800 RGB. */
export function composeToRgb(f: AiFrame, aiDir: string): Uint8Array {
  const index = existsSync(`${aiDir}/index.json`) ? JSON.parse(readFileSync(`${aiDir}/index.json`, 'utf8')) : {};
  const pics: Record<string, string> = index.pics ?? {};
  const views: Record<string, string> = index.views ?? {};
  const base = f.useArt ? f.base : null;
  const viewCache = new Map<number, { m: ViewSheetManifest; sheets: RgbaImage[] } | null>();
  const out = new Uint32Array(OUT_W * OUT_H);
  composeFrame(
    {
      frame: f.frame,
      owner: f.owner,
      placements: f.placements,
      forced: f.forced,
      baseVisual: base?.visual ?? null,
      background: base && pics[base.nr] ? loadImage(`${aiDir}/${pics[base.nr]}`, 320 * AI_SCALE, f.picH * AI_SCALE, base.mirrored) : null,
      picTop: f.picTop,
      cel: (v, l, c) => {
        if (!f.useArt) return null;
        if (!viewCache.has(v)) {
          const file = views[v];
          if (!file) viewCache.set(v, null);
          else {
            const m: ViewSheetManifest = JSON.parse(readFileSync(`${aiDir}/${file}`, 'utf8'));
            viewCache.set(v, { m, sheets: m.sheets.map((s) => loadImage(`${aiDir}/${s.file}`, s.w * (m.xs ?? 1) * AI_SCALE, s.h * AI_SCALE)) });
          }
        }
        const e = viewCache.get(v);
        return e ? lookupCel(e.m, e.sheets, l, c) : null;
      },
      palette: pal,
    },
    out,
  );
  const runs = f.text ? f.text(out) : [];
  if (!GlobalFonts.has(TEXT_FONT_FAMILY)) GlobalFonts.registerFromPath('public/fonts/text.ttf', TEXT_FONT_FAMILY);
  const canvas = createCanvas(OUT_W, OUT_H);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(OUT_W, OUT_H);
  new Uint32Array(id.data.buffer).set(out);
  ctx.putImageData(id, 0, 0);
  drawRuns(ctx as unknown as TextContext, runs, EGA);
  if (f.topMask) drawMasked(ctx as unknown as TextContext, f.frame, f.topMask, EGA);
  const px = new Uint32Array(ctx.getImageData(0, 0, OUT_W, OUT_H).data.buffer);
  const rgb = new Uint8Array(OUT_W * OUT_H * 3);
  for (let i = 0; i < px.length; i++) {
    rgb[i * 3] = px[i] & 255;
    rgb[i * 3 + 1] = (px[i] >> 8) & 255;
    rgb[i * 3 + 2] = (px[i] >> 16) & 255;
  }
  return rgb;
}

/** SCI: blends the engine's current frame. */
export function aiComposite(engine: SciEngine, frame: Uint8Array, aiDir: string): Uint8Array {
  const gfx = engine.gfx;
  const scr = gfx.screen;
  const t = gfx.wmgrPort.top;
  const rects = gfx.windowList
    .filter((w): w is Window => w instanceof Window && w !== gfx.picWind)
    .map((w) => ({ top: w.restoreRect.top + t, left: w.restoreRect.left, bottom: w.restoreRect.bottom + t, right: w.restoreRect.right }));
  if (engine.windows.menu.dropRect) rects.push(engine.windows.menu.dropRect);
  return composeToRgb(
    {
      frame,
      owner: scr.outOwner,
      placements: scr.placements,
      forced: forcedMask(rects, new Uint8Array(320 * 200), engine.cursorMask),
      base: gfx.basePicture,
      picTop: 10,
      picH: 190,
      useArt: true,
      text: (out) => eraseText(scr.outOwner, scr.textGlyphs, engine.cursorMask, frame, out),
      topMask: engine.cursorMask,
    },
    aiDir,
  );
}

/** AGI: blends the interpreter's current frame. */
export function agiAiComposite(it: Interpreter, aiDir: string): Uint8Array {
  const scr = it.screen;
  const picTop = scr.picRow * 8;
  const cells = scr.visibleCells.slice();
  const late = scr.cells(scr.pixels);
  for (let i = 0; i < late.length; i++) if (late[i]) cells[i] = late[i];
  const bp = it.basePicture;
  let visual: Uint8Array | null = null;
  if (bp) {
    visual = new Uint8Array(320 * 200);
    for (let y = 0; y < PIC_H && picTop + y < 200; y++)
      for (let x = 0; x < PIC_W; x++) visual[(picTop + y) * 320 + x * 2] = visual[(picTop + y) * 320 + x * 2 + 1] = bp.vis[y * PIC_W + x];
  }
  return composeToRgb(
    {
      frame: scr.pixels,
      owner: scr.owner,
      placements: it.placements,
      forced: forcedMask(scr.windowRect ? [scr.windowRect] : [], new Uint8Array(320 * 200)),
      base: bp && visual ? { nr: bp.nr, mirrored: false, visual } : null,
      picTop,
      picH: PIC_H,
      useArt: true,
      text: (out) => agiText(cells, out),
    },
    aiDir,
  );
}
