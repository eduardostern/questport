// Repaints SCI0 views (sprites) with xAI's image editor for the "AI images" mode.
// Each view's cels are packed into one or more sprite sheets so a character stays consistent
// across its animation frames. Mirrored loops reuse their source loop (flipped at draw time).
// Usage: tsx tools/sci-ai-views.ts [view numbers...]   (no numbers = every view)
// Env: GAME=dir (default public/games/sq3), FORCE=1, JOBS=n, RES=2k
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SciResources, ResType } from '../src/sci/resource';
import { SciGfx } from '../src/sci/gfx';
import { EGA } from '../src/palette';
import type { ViewSheetManifest } from '../src/sci/ai-compose';
import { writePngRgb, loadGameDir } from './png';
import { editImage } from './xai';

const gameDir = process.env.GAME ?? 'public/games/sq3';
const aiDir = `${gameDir}/ai`;
const outDir = `${aiDir}/views`;
mkdirSync(`${outDir}/src`, { recursive: true });
const res = new SciResources(loadGameDir(gameDir));
const gfx = new SciGfx(res);

const PROMPT =
  'This is a sprite sheet from the 1989 EGA computer game Space Quest III (a comedic sci-fi adventure). Each figure on ' +
  'the flat gray background is a separate sprite: an animation frame of a character or an object. Repaint every sprite ' +
  'in place as a richly detailed, full-color hand-painted sprite in the style of early-1990s Sierra VGA games, with ' +
  'smooth shading, lighting and texture instead of flat colors and dithering, keeping the original colors. ' +
  'Every sprite must keep EXACTLY its position, size, pose and silhouette so it lines up with the original. ' +
  'A character must look the same in every frame. Keep the background flat gray. ' +
  'Do not add, remove or merge sprites, and do not add text, borders or shadows.';

const PAD = 3; // original pixels between cels
const BG = [119, 119, 119];
const LIMIT_W = 2000;
const LIMIT_H = 2000;

interface Cell {
  loop: number;
  cel: number;
  w: number;
  h: number;
  x: number;
  y: number;
  sheet: number;
}

/** Mirrored loop -> source loop, from the raw view header (mirrored loops share their source's data). */
function mirrorSources(d: Uint8Array): Record<string, number> {
  const loops = d[0];
  const bits = d[2] | (d[3] << 8);
  const offs = Array.from({ length: loops }, (_, l) => d[8 + l * 2] | (d[9 + l * 2] << 8));
  const out: Record<string, number> = {};
  for (let l = 0; l < loops; l++) {
    if (!((bits >> l) & 1)) continue;
    const src = offs.findIndex((o, k) => o === offs[l] && !((bits >> k) & 1));
    if (src >= 0) out[l] = src;
  }
  return out;
}

/** Shelf-packs cells into sheets of at most maxW x maxH original pixels. */
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
    // Each loop starts a new row; wrap when the row is full.
    if ((c.loop !== lastLoop && x > PAD) || x + c.w + PAD > maxW) {
      x = PAD;
      y += rowH + PAD;
      rowH = 0;
    }
    if (y + c.h + PAD > maxH && y > PAD) newSheet();
    lastLoop = c.loop;
    c.x = x;
    c.y = y;
    c.sheet = sheet;
    x += c.w + PAD;
    rowH = Math.max(rowH, c.h);
    const s = sheets[sheet];
    s.w = Math.max(s.w, x);
    s.h = Math.max(s.h, y + rowH + PAD);
  }
  return sheets;
}

async function repaintView(nr: number): Promise<void> {
  const manifestPath = `${outDir}/v${nr}.json`;
  if (existsSync(manifestPath) && !process.env.FORCE) return console.log(`view ${nr}: exists`);
  const raw = res.get(ResType.View, nr);
  if (!raw) return;
  const view = gfx.view(nr);
  const mirrors = mirrorSources(raw);
  const cells: Cell[] = [];
  view.loops.forEach((loop, l) => {
    if (mirrors[l] !== undefined) return;
    loop.cels.forEach((c, i) => {
      if (c.width > 0 && c.height > 0) cells.push({ loop: l, cel: i, w: c.width, h: c.height, x: 0, y: 0, sheet: 0 });
    });
  });
  if (!cells.length) return;
  // Biggest magnification (multiples of 5x6, the 4:3 display aspect) that fits on one sheet.
  let m = 1;
  let sheets = pack(cells, Math.floor(LIMIT_W / 5), Math.floor(LIMIT_H / 6));
  for (const tryM of [4, 3, 2]) {
    const s = pack(cells, Math.floor(LIMIT_W / (5 * tryM)), Math.floor(LIMIT_H / (6 * tryM)));
    if (s.length === 1) {
      m = tryM;
      sheets = s;
      break;
    }
  }
  if (m === 1) sheets = pack(cells, Math.floor(LIMIT_W / 5), Math.floor(LIMIT_H / 6));
  const sx = 5 * m;
  const sy = 6 * m;
  const manifest: ViewSheetManifest = { sheets: [], cels: {}, mirrors };
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
          if (v === cel.clearKey) continue;
          const col = EGA[v & 15];
          for (let yy = 0; yy < sy; yy++) {
            for (let xx = 0; xx < sx; xx++) rgb.set(col, (((c.y + y) * sy + yy) * W + (c.x + x) * sx + xx) * 3);
          }
        }
      }
    }
    const src = `${outDir}/src/v${nr}-s${si}.png`;
    writePngRgb(src, rgb, W, H);
    const bytes = await editImage(readFileSync(src), PROMPT);
    const ext = bytes[0] === 0x89 ? 'png' : bytes[0] === 0xff ? 'jpg' : 'webp';
    const rawOut = `${outDir}/src/v${nr}-s${si}-ai.${ext}`;
    writeFileSync(rawOut, bytes);
    // Store at 4x the original pixel size (what the game samples), as high-quality JPEG.
    const file = `v${nr}-s${si}.jpg`;
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', '-z', String(h * 4), String(w * 4), rawOut, '--out', `${outDir}/${file}`], { stdio: 'ignore' });
    manifest.sheets.push({ file: `views/${file}`, w, h });
  }
  for (const c of cells) manifest.cels[`${c.loop},${c.cel}`] = { sheet: c.sheet, x: c.x, y: c.y, w: c.w, h: c.h };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`view ${nr}: ${cells.length} cels on ${sheets.length} sheet(s), ${sx}x${sy}`);
}

function writeIndex(): void {
  const indexPath = `${aiDir}/index.json`;
  let index: { pics?: Record<string, string>; views?: Record<string, string> } = {};
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    /* new index */
  }
  const views = Object.fromEntries(
    readdirSync(outDir)
      .map((f) => /^v(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1], `views/${m[0]}`]),
  );
  writeFileSync(indexPath, JSON.stringify({ pics: index.pics ?? {}, views }));
  console.log(`${Object.keys(views).length} repainted views indexed`);
}

const wanted = process.argv.slice(2).map(Number);
const queue = (wanted.length ? wanted : res.list(ResType.View)).filter((n) => res.exists(ResType.View, n));
const failures: string[] = [];
await Promise.all(
  Array.from({ length: Number(process.env.JOBS ?? 3) }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      try {
        await repaintView(n);
      } catch (e) {
        failures.push(`view ${n}: ${(e as Error).message}`);
        console.error(`view ${n}: ${(e as Error).message}`);
      }
    }
  }),
);
writeIndex();
process.exit(failures.length ? 1 : 0);
