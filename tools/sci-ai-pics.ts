// Repaints SCI0 room pictures with xAI's image editor (Grok Imagine) for the "AI images" mode.
// Usage: tsx tools/sci-ai-pics.ts [pic numbers...]   (no numbers = every picture)
// Env: GAME=dir (default public/games/sq3), FORCE=1 to redo existing images, JOBS=n parallel requests.
// Reads XAI_API_KEY from .env.local. Writes <GAME>/ai/pic<N>.(png|jpg) plus the EGA source in <GAME>/ai/src.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SciResources, ResType } from '../src/sci/resource';
import { SciScreen } from '../src/sci/screen';
import { drawSciPicture } from '../src/sci/picture';
import { writePng, loadGameDir } from './png';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const KEY = process.env.XAI_API_KEY ?? env.XAI_API_KEY;
if (!KEY) throw new Error('XAI_API_KEY missing (put it in .env.local)');

const gameDir = process.env.GAME ?? 'public/games/sq3';
const outDir = `${gameDir}/ai`;
mkdirSync(`${outDir}/src`, { recursive: true });
const res = new SciResources(loadGameDir(gameDir));

export const PROMPT =
  'Repaint this 1989 EGA computer game background (Space Quest III, a comedic sci-fi adventure) as a richly detailed, ' +
  'full-color hand-painted illustration in the style of early-1990s Sierra VGA backgrounds. ' +
  'Keep the EXACT same composition, framing, camera angle and perspective: every wall, floor edge, doorway, platform, ' +
  'machine and object must stay in the same position with the same size and outline, so the new image lines up with ' +
  'the original when laid on top of it. Replace the dithering and flat colors with smooth gradients, lighting, ' +
  'shading and surface texture, keeping the original color scheme. Do not add people, characters, text or new objects. ' +
  'Every part of the image must be fully repainted: no pixel art, jagged pixel edges or dithering patterns may remain. ' +
  'Do not crop, zoom, pan or add borders.';

/** For mostly empty pictures (space, black screens, displays): keep empty areas empty. */
export const STRICT_PROMPT =
  'Redraw this 1989 EGA computer game image (Space Quest III) in high quality full color WITHOUT changing its content. ' +
  'Large empty areas of a single flat color must stay completely empty and keep that same color: do not add any scenery, ' +
  'rooms, machines, objects, planets or details in them. Only redraw the existing drawn elements (lines, stars, shapes, ' +
  'grids, lettering) more smoothly and with subtle glow or shading, at exactly the same positions and sizes. ' +
  'Do not crop, zoom, pan or add borders.';

/** Renders a picture's visual layer (the 320x190 picture window) and saves it upscaled 5x6 (4:3 display aspect). */
function renderSource(nr: number): string {
  const s = new SciScreen();
  s.clearRect(0, 10, 320, 200, 15);
  drawSciPicture(res.get(ResType.Pic, nr)!, s, { top: 10, left: 0, rect: { top: 0, left: 0, bottom: 190, right: 320 } });
  const path = `${outDir}/src/pic${nr}.png`;
  writePng(path, s.visual.subarray(320 * 10), 320, 190, 5, 6);
  return path;
}

async function repaint(nr: number): Promise<void> {
  const done = readdirSync(outDir).find((f) => f.startsWith(`pic${nr}.`));
  if (done && !process.env.FORCE) return console.log(`pic ${nr}: exists`);
  const src = renderSource(nr);
  const b64 = readFileSync(src).toString('base64');
  for (let attempt = 1; ; attempt++) {
    const r = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: process.env.MODEL ?? 'grok-imagine-image-2.0',
        prompt: process.env.STRICT ? STRICT_PROMPT : PROMPT,
        image: { url: `data:image/png;base64,${b64}`, type: 'image_url' },
        ...(process.env.RES ? { resolution: process.env.RES } : {}),
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      if (attempt < 3 && (r.status === 429 || r.status >= 500)) {
        await new Promise((ok) => setTimeout(ok, 5000 * attempt));
        continue;
      }
      throw new Error(`pic ${nr}: HTTP ${r.status} ${text.slice(0, 400)}`);
    }
    const j = JSON.parse(text);
    const item = j.data?.[0] ?? j;
    let bytes: Buffer;
    if (item.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else if (item.url) bytes = Buffer.from(await (await fetch(item.url)).arrayBuffer());
    else throw new Error(`pic ${nr}: unexpected response ${text.slice(0, 400)}`);
    const ext = bytes[0] === 0x89 ? 'png' : bytes[0] === 0xff ? 'jpg' : 'webp';
    // Keep the browser download reasonable: high-quality JPEG, at most 1920 pixels wide (macOS sips).
    const raw = `${outDir}/src/pic${nr}-ai.${ext}`;
    writeFileSync(raw, bytes);
    for (const f of readdirSync(outDir)) if (f.startsWith(`pic${nr}.`)) unlinkSync(`${outDir}/${f}`);
    const dest = `${outDir}/pic${nr}.jpg`;
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', '--resampleWidth', '1920', raw, '--out', dest], { stdio: 'ignore' });
    console.log(`pic ${nr}: saved (${Math.round(statSync(dest).size / 1024)} KB)`);
    return;
  }
}

const wanted = process.argv.slice(2).map(Number);
const queue = (wanted.length ? wanted : res.list(ResType.Pic)).filter((n) => res.exists(ResType.Pic, n));
const jobs = Number(process.env.JOBS ?? 3);
const failures: string[] = [];
await Promise.all(
  Array.from({ length: jobs }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      try {
        await repaint(n);
      } catch (e) {
        failures.push((e as Error).message);
        console.error((e as Error).message);
      }
    }
  }),
);
// Index for the browser: which pictures have repaints (views are added by sci-ai-views.ts).
const indexPath = `${outDir}/index.json`;
const old = (() => {
  try {
    return JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return {};
  }
})();
const pics = Object.fromEntries(
  readdirSync(outDir)
    .map((f) => /^pic(\d+)\.(png|jpg|webp)$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[0]]),
);
const index = pics;
writeFileSync(indexPath, JSON.stringify({ pics, views: old.views ?? {} }));
console.log(`${Object.keys(index).length} AI pictures indexed${failures.length ? `, ${failures.length} failed` : ''}`);
process.exit(failures.length ? 1 : 0);
