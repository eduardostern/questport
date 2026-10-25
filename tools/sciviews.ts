import { mkdirSync } from 'node:fs';
import { SciResources } from '../src/sci/resource';
import { SciGfx } from '../src/sci/gfx';
import { writePng, loadGameDir } from './png';
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const g = new SciGfx(new SciResources(loadGameDir('public/games/sq3')));
const scr = g.screen;
scr.clearRect(0, 0, 320, 200, 1);
// draw a few views across the screen on top of picture-less background, plus text
let x = 20;
for (const v of (process.argv.slice(3).map(Number))) {
  const view = g.view(v);
  let y = 40;
  for (let l = 0; l < view.loops.length && l < 4; l++) {
    const c = g.cel(v, l, 0);
    g.drawCel(v, l, 0, g.celRect(v, l, 0, x, y, 0), 15);
    y += c.height + 4;
  }
  x += 50;
}
g.curPort.curTop = 2; g.curPort.curLeft = 4; g.curPort.penClr = 15;
g.drawString('Space Quest III - font 0 test 0123');
g.setFont(1); g.curPort.curTop = 14; g.curPort.curLeft = 4; g.drawString('Font 1: Roger Wilco');
writePng(`${out}/views.png`, scr.visual, 320, 200, 1, 1);
for (const n of [0,1,2,3,4,5,6,7,8,9]) { try { const f = g.font(n); console.log('font', n, 'chars', f.numChars, 'height', f.height); } catch {} }
