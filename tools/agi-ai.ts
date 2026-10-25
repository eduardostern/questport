// Repaints AGI pictures and views with xAI's image editor for the "AI images" mode.
// Usage: tsx tools/agi-ai.ts pics [numbers...] | views [numbers...]
// Env: GAME=dir (default public/games/sq2), TITLE="Space Quest II", FORCE=1, JOBS=n, RES=2k, STRICT=1
// Pictures with mostly one flat color are repainted with the strict prompt automatically.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ResourceManager } from '../src/resources';
import { PictureBuffer, drawPicture, PIC_W, PIC_H } from '../src/picture';
import { decodeView } from '../src/view';
import { EGA } from '../src/palette';
import type { ViewSheetManifest } from '../src/sci/ai-compose';
import { writePngRgb, loadGameDir } from './png';
import { editImage } from './xai';

const gameDir = process.env.GAME ?? 'public/games/sq2';
const title = process.env.TITLE ?? 'Space Quest II (a comedic sci-fi adventure)';
const aiDir = `${gameDir}/ai`;
mkdirSync(`${aiDir}/src`, { recursive: true });
mkdirSync(`${aiDir}/views/src`, { recursive: true });
const res = new ResourceManager(loadGameDir(gameDir));

const PIC_PROMPT =
  `Repaint this 1988 EGA computer game background (${title}) as a richly detailed, full-color hand-painted ` +
  'illustration in the style of early-1990s Sierra VGA backgrounds. Keep the EXACT same composition, framing, camera ' +
  'angle and perspective: every wall, floor edge, doorway, path, plant, machine and object must stay in the same ' +
  'position with the same size and outline, so the new image lines up with the original when laid on top of it. ' +
  'Replace the blocky pixels and flat colors with smooth gradients, lighting, shading and surface texture, keeping the ' +
  'original color scheme. Every part of the image must be fully repainted: no pixel art or jagged pixel edges may remain. ' +
  'Do not add people, characters, text or new objects. Do not crop, zoom, pan or add borders.';

const STRICT_PROMPT =
  `Redraw this 1988 EGA computer game image (${title}) in high quality full color WITHOUT changing its content. ` +
  'Large empty areas of a single flat color must stay completely empty and keep that same color: do not add any scenery, ' +
  'rooms, machines, objects, planets or details in them. Only redraw the existing drawn elements (lines, stars, shapes, ' +
  'lettering) more smoothly and with subtle shading, at exactly the same positions and sizes. ' +
  'Do not crop, zoom, pan or add borders.';

const VIEW_PROMPT =
  `This is a sprite sheet from the 1988 EGA computer game ${title}. Each figure on the flat gray background is a ` +
  'separate sprite: an animation frame of a character or an object. Repaint every sprite in place as a richly detailed, ' +
  'full-color hand-painted sprite in the style of early-1990s Sierra VGA games, with smooth shading, lighting and ' +
  'texture instead of blocky pixels and flat colors, keeping the original colors. Every sprite must keep EXACTLY its ' +
  'position, size, pose and silhouette so it lines up with the original. A character must look the same in every frame. ' +
  'Keep the background flat gray. Do not add, remove or merge sprites, and do not add text, borders or shadows.';

function toJpeg(src: string, dest: string, w: number, h: number): void {
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', '-z', String(h), String(w), src, '--out', dest], { stdio: 'ignore' });
}

function saveRaw(bytes: Buffer, base: string): string {
  const ext = bytes[0] === 0x89 ? 'png' : bytes[0] === 0xff ? 'jpg' : 'webp';
  const p = `${base}.${ext}`;
  writeFileSync(p, bytes);
  return p;
}

// ---------------------------------------------------------------- pictures

async function repaintPic(nr: number): Promise<void> {
  const dest = `${aiDir}/pic${nr}.jpg`;
  if (existsSync(dest) && !process.env.FORCE) return console.log(`pic ${nr}: exists`);
  const b = new PictureBuffer();
  drawPicture(res.load('picture', nr), b, true);
  // Mostly one flat color: keep empty areas empty.
  const hist = new Array(16).fill(0);
  for (const c of b.vis) hist[c & 15]++;
  const strict = !!process.env.STRICT || Math.max(...hist) / b.vis.length > 0.8;
  // Each AGI pixel is two screen pixels wide; 5x6 per screen pixel gives the 4:3 display aspect.
  const W = PIC_W * 10;
  const H = PIC_H * 6;
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) rgb.set(EGA[b.vis[Math.floor(y / 6) * PIC_W + Math.floor(x / 10)] & 15], (y * W + x) * 3);
  }
  const src = `${aiDir}/src/pic${nr}.png`;
  writePngRgb(src, rgb, W, H);
  const raw = saveRaw(await editImage(readFileSync(src), strict ? STRICT_PROMPT : PIC_PROMPT), `${aiDir}/src/pic${nr}-ai`);
  toJpeg(raw, dest, 1920, Math.round((1920 * PIC_H * 6) / (PIC_W * 10)));
  console.log(`pic ${nr}: saved${strict ? ' (strict)' : ''}`);
}

// ---------------------------------------------------------------- views

const PAD = 3;
const BG = [119, 119, 119];

interface Cell {
  loop: number;
  cel: number;
  w: number;
  h: number;
  x: number;
  y: number;
  sheet: number;
}

function pack(cells: Cell[], maxW: number, maxH: number): { w: number; h: number }[] {
  const sheets: { w: number; h: number }[] = [];
  let sheet = -1;
  let x = 0;
  let y = 0;
  let rowH = 0;
  let lastLoop = -1;
  const newSheet = () => {
    sheets.push({ w: 0, h: 0 });
    sheet = sheets.length - 1;
    x = PAD;
    y = PAD;
    rowH = 0;
  };
  for (const c of cells) {
    if (sheet < 0) newSheet();
    if ((c.loop !== lastLoop && x > PAD) || x + c.w + PAD > maxW) {
      x = PAD;
      y += rowH + PAD;
      rowH = 0;
    }
    if (y + c.h + PAD > maxH && y > PAD) newSheet();
    lastLoop = c.loop;
    Object.assign(c, { x, y, sheet });
    x += c.w + PAD;
    rowH = Math.max(rowH, c.h);
    const s = sheets[sheet];
    s.w = Math.max(s.w, x);
    s.h = Math.max(s.h, y + rowH + PAD);
  }
  return sheets;
}

/** Mirrored loop -> source loop (AGI marks mirrored cels with the loop they belong to). */
function mirrorSources(d: Uint8Array): Record<string, number> {
  const out: Record<string, number> = {};
  const loops = d[2];
  for (let l = 0; l < loops; l++) {
    const lo = d[5 + l * 2] | (d[6 + l * 2] << 8);
    if (!d[lo]) continue;
    const co = lo + (d[lo + 1] | (d[lo + 2] << 8));
    const tm = d[co + 2];
    if (tm & 0x80 && ((tm >> 4) & 7) !== l) out[l] = (tm >> 4) & 7;
  }
  return out;
}

async function repaintView(nr: number): Promise<void> {
  const manifestPath = `${aiDir}/views/v${nr}.json`;
  if (existsSync(manifestPath) && !process.env.FORCE) return console.log(`view ${nr}: exists`);
  const raw = res.load('view', nr);
  const view = decodeView(raw);
  const mirrors = mirrorSources(raw);
  const cells: Cell[] = [];
  view.loops.forEach((loop, l) => {
    if (mirrors[l] !== undefined) return;
    loop.cels.forEach((c, i) => {
      if (c.width > 0 && c.height > 0) cells.push({ loop: l, cel: i, w: c.width, h: c.height, x: 0, y: 0, sheet: 0 });
    });
  });
  if (!cells.length) return;
  // Flat one- or two-color views (silhouettes, effects) are better left original.
  const colors = new Set<number>();
  view.loops.forEach((loop) => loop.cels.forEach((c) => c.pixels.forEach((p) => p !== c.transparent && colors.add(p))));
  if (colors.size <= 2) return console.log(`view ${nr}: skipped (flat colors)`);
  // Each AGI pixel is 2 screen pixels wide: 10x6 per pixel at m=1 (4:3 aspect).
  let m = 1;
  let sheets = pack(cells, Math.floor(2000 / 10), Math.floor(2000 / 6));
  for (const tryM of [4, 3, 2]) {
    const s = pack(cells, Math.floor(2000 / (10 * tryM)), Math.floor(2000 / (6 * tryM)));
    if (s.length === 1) {
      m = tryM;
      sheets = s;
      break;
    }
  }
  if (m === 1) sheets = pack(cells, Math.floor(2000 / 10), Math.floor(2000 / 6));
  const sx = 10 * m;
  const sy = 6 * m;
  const manifest: ViewSheetManifest = { sheets: [], cels: {}, mirrors, xs: 2 };
  for (let si = 0; si < sheets.length; si++) {
    const { w, h } = sheets[si];
    const W = w * sx;
    const H = h * sy;
    const rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) rgb.set(BG, i * 3);
    for (const c of cells.filter((c) => c.sheet === si)) {
      const cel = view.loops[c.loop].cels[c.cel];
      for (let y = 0; y < c.h; y++) {
        for (let x = 0; x < c.w; x++) {
          const v = cel.pixels[y * c.w + x];
          if (v === cel.transparent) continue;
          const col = EGA[v & 15];
          for (let yy = 0; yy < sy; yy++) for (let xx = 0; xx < sx; xx++) rgb.set(col, (((c.y + y) * sy + yy) * W + (c.x + x) * sx + xx) * 3);
        }
      }
    }
    const src = `${aiDir}/views/src/v${nr}-s${si}.png`;
    writePngRgb(src, rgb, W, H);
    const rawOut = saveRaw(await editImage(readFileSync(src), VIEW_PROMPT), `${aiDir}/views/src/v${nr}-s${si}-ai`);
    const file = `v${nr}-s${si}.jpg`;
    // Stored at 4x screen pixels (8x4 per AGI pixel), which is what the game samples.
    toJpeg(rawOut, `${aiDir}/views/${file}`, w * 8, h * 4);
    manifest.sheets.push({ file: `views/${file}`, w, h });
  }
  for (const c of cells) manifest.cels[`${c.loop},${c.cel}`] = { sheet: c.sheet, x: c.x, y: c.y, w: c.w, h: c.h };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`view ${nr}: ${cells.length} cels on ${sheets.length} sheet(s)`);
}

// ---------------------------------------------------------------- main

function writeIndex(): void {
  const pics = Object.fromEntries(
    readdirSync(aiDir)
      .map((f) => /^pic(\d+)\.jpg$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1], m[0]]),
  );
  const views = Object.fromEntries(
    readdirSync(`${aiDir}/views`)
      .map((f) => /^v(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1], `views/${m[0]}`]),
  );
  writeFileSync(`${aiDir}/index.json`, JSON.stringify({ pics, views }));
  console.log(`${Object.keys(pics).length} pictures, ${Object.keys(views).length} views indexed`);
}

const [kind, ...nums] = process.argv.slice(2);
const type = kind === 'views' ? 'view' : 'picture';
const all: number[] = [];
for (let i = 0; i < res.count(type); i++) if (res.exists(type, i)) all.push(i);
const queue = nums.length ? nums.map(Number) : all;
const failures: string[] = [];
await Promise.all(
  Array.from({ length: Number(process.env.JOBS ?? 4) }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      try {
        await (kind === 'views' ? repaintView(n) : repaintPic(n));
      } catch (e) {
        failures.push(`${kind} ${n}: ${(e as Error).message}`);
        console.error(`${kind} ${n}: ${(e as Error).message}`);
      }
    }
  }),
);
writeIndex();
void unlinkSync;
process.exit(failures.length ? 1 : 0);
