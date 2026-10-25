import { mkdirSync } from 'node:fs';
import { ResourceManager } from '../src/resources';
import { PictureBuffer, drawPicture, PIC_W, PIC_H } from '../src/picture';
import { writePng, loadGameDir } from './png';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const res = new ResourceManager(loadGameDir(process.env.GAME ?? 'public/games/sq1'));
const which = process.argv.slice(3).map(Number);
let n = 0;
for (let i = 0; i < res.count('picture'); i++) {
  if (!res.exists('picture', i) || (which.length && !which.includes(i))) continue;
  const b = new PictureBuffer();
  const t = performance.now();
  drawPicture(res.load('picture', i), b, true);
  writePng(`${out}/pic${i}.png`, b.vis, PIC_W, PIC_H);
  writePng(`${out}/pri${i}.png`, b.pri, PIC_W, PIC_H);
  n++;
}
console.log(`rendered ${n} pictures`);
