import { mkdirSync } from 'node:fs';
import { ResourceManager } from '../src/resources';
import { decodeView } from '../src/view';
import { writePng, loadGameDir } from './png';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const res = new ResourceManager(loadGameDir(process.env.GAME ?? 'public/games/sq1'));
for (const i of process.argv.slice(3).map(Number)) {
  const v = decodeView(res.load('view', i));
  // Sheet: each loop is a row of cels on a gray background.
  const W = 300, rows = v.loops.map(l => Math.max(...l.cels.map(c => c.height)) + 2);
  const H = rows.reduce((a, b) => a + b, 0);
  const img = new Uint8Array(W * H).fill(1);
  let y0 = 0;
  v.loops.forEach((l, li) => {
    let x0 = 0;
    for (const c of l.cels) {
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const p = c.pixels[y * c.width + x];
        if (p !== c.transparent && x0 + x < W) img[(y0 + y) * W + x0 + x] = p;
      }
      x0 += c.width + 2;
    }
    y0 += rows[li];
  });
  writePng(`${out}/view${i}.png`, img, W, H, 2, 2);
  console.log(i, v.loops.length, 'loops', JSON.stringify(v.description));
}
