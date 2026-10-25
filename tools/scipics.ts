import { mkdirSync } from 'node:fs';
import { SciResources } from '../src/sci/resource';
import { SciScreen } from '../src/sci/screen';
import { drawSciPicture } from '../src/sci/picture';
import { writePng, loadGameDir } from './png';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const res = new SciResources(loadGameDir(process.env.GAME ?? 'public/games/sq3'));
const which = process.argv.slice(3).map(Number);
const port = { top: 10, left: 0, rect: { top: 0, left: 0, bottom: 190, right: 320 } };
let n = 0, fails: string[] = [];
for (const i of res.list(1)) {
  if (which.length && !which.includes(i)) continue;
  const s = new SciScreen();
  s.clearRect(0, 10, 320, 200, 15);
  try { drawSciPicture(res.get(1, i)!, s, port); } catch (e) { fails.push(`${i}: ${(e as Error).message}`); continue; }
  if (which.length || n < 400) {
    writePng(`${out}/pic${i}.png`, s.visual, 320, 200, 1, 1);
    writePng(`${out}/pri${i}.png`, s.priority, 320, 200, 1, 1);
    writePng(`${out}/ctl${i}.png`, s.control, 320, 200, 1, 1);
  }
  n++;
}
console.log(`rendered ${n}`, fails.slice(0, 5));
