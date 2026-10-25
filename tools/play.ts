// Headless runner: plays the game with scripted input and saves screenshots.
// Usage: tsx tools/play.ts <outdir> step...   steps: w<cycles> | k<Key> | t<text> | s<name> | trace
import { mkdirSync } from 'node:fs';
import { Interpreter, Host, KeyPress } from '../src/interpreter';
import { writePng, writePngRgb, loadGameDir } from './png';
import { agiAiComposite } from './ai-composite';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
let fakeNow = 0;
const store = new Map<string, string>();
let lastWin = '';
const host: Host = {
  present() {
    const w = interp?.screen.window;
    const t = w ? w.lines.join(' / ') : '';
    if (t && t !== lastWin) console.log(`  [c${interp.cycleCount} room ${interp.room}] WINDOW: ${t}`);
    lastWin = t;
  },
  playSound() {}, stopSound() {}, shake() {},
  load: (k) => store.get(k) ?? null, save(k, v) { store.set(k, v); }, quit() { console.log('QUIT'); },
  now: () => fakeNow,
  sleep: (ms) => { fakeNow += ms; return new Promise((r) => setImmediate(r)); },
};
const interp = new Interpreter(loadGameDir(process.env.GAME ?? 'public/games/sq1'), host, { version: process.env.AGIVER ? parseInt(process.env.AGIVER, 16) : undefined });
const KEYS: Record<string, KeyPress> = {
  Enter: { ascii: 13, scan: 28 }, Esc: { ascii: 27, scan: 1 }, Tab: { ascii: 9, scan: 15 },
  Up: { ascii: 0, scan: 72 }, Down: { ascii: 0, scan: 80 }, Left: { ascii: 0, scan: 75 }, Right: { ascii: 0, scan: 77 },
  F1: { ascii: 0, scan: 59 }, F3: { ascii: 0, scan: 61 }, F5: { ascii: 0, scan: 63 }, F10: { ascii: 0, scan: 68 }, F7: { ascii: 0, scan: 65 },
};
const tick = () => new Promise((r) => setImmediate(r));
interp.run().catch((e) => { console.error('CRASH', e); process.exit(1); });

(async () => {
  for (const step of process.argv.slice(3)) {
    const c = step[0], arg = step.slice(1);
    if (step === 'trace') { interp.trace = !interp.trace; continue; }
    if (c === 'W') {
      // wait without dismissing windows; stops early if the game waits for a key
      const target = interp.cycleCount + Number(arg);
      while (interp.cycleCount < target && !interp.waitingForKey) await tick();
      await tick();
    } else if (c === 'w') {
      const target = interp.cycleCount + Number(arg);
      while (interp.cycleCount < target && !interp.quitRequested) {
        if (interp.waitingForKey) interp.pushKey(KEYS.Enter);
        await tick();
      }
    } else if (c === 'k') {
      interp.pushKey(KEYS[arg] ?? { ascii: arg.charCodeAt(0), scan: 0 });
      await tick(); await tick();
    } else if (c === 't') {
      for (const ch of arg) interp.pushKey({ ascii: ch.charCodeAt(0), scan: 0 });
      interp.pushKey(KEYS.Enter);
      console.log(`  > ${arg}`);
      for (let i = 0; i < 5; i++) await tick();
    } else if (c === 's') {
      writePng(`${out}/${arg}.png`, interp.screen.pixels, 320, 200, 1, 1);
      if (process.env.AI) writePngRgb(`${out}/${arg}-ai.png`, agiAiComposite(interp, `${process.env.GAME ?? 'public/games/sq1'}/ai`), 1280, 800);
      const e = interp.objs[0];
      console.log(`  shot ${arg}: room ${interp.room} ego (${e.x},${e.y}) cycle ${interp.cycleCount}`);
    }
  }
  process.exit(0);
})();
