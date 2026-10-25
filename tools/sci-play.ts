// Headless SCI player using the full engine (input, sound cues, saves) with a simulated clock.
// Usage: tsx tools/sci-play.ts <outdir> [steps...]
//   w<ms>      advance simulated time
//   k<key>     press a key: a single char, or Enter/Esc/Tab/Up/Down/Left/Right/F1..F10/Bksp
//   t<text>    type text and press Enter
//   c<x>,<y>   mouse click at screen coordinates
//   s<name>    save a screenshot (<outdir>/<name>.png)
// Env: GAME=dir (default public/games/sq3), SENDS=1 to trace sends
import { mkdirSync } from 'node:fs';
import { SciEngine } from '../src/sci/engine';
import { writePng, writePngRgb, loadGameDir } from './png';
import { aiComposite } from './ai-composite';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
let now = 0;
const sleepers: { at: number; resolve: () => void }[] = [];
const store = new Map<string, string>();
let lastFrame = new Uint8Array(320 * 200);
let stoppedMsg = '';
const engine = new SciEngine(
  loadGameDir(process.env.GAME ?? 'public/games/sq3'),
  {
    now: () => now,
    // Running a VM slice takes real time in a browser; charge at least 4 ms per yield.
    sleep: (ms) => new Promise<void>((resolve) => sleepers.push({ at: now + Math.max(ms, 4), resolve })),
    present: (px) => {
      lastFrame = px.slice();
    },
    audio: {
      play: () => 1,
      stop: () => undefined,
      setVolume: () => undefined,
      time: () => now / 1000,
    },
    storage: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) },
    stopped: (m) => {
      stoppedMsg = m;
      console.log('STOPPED:', m);
    },
  },
  'sq3',
);
engine.vm.traceSends = !!process.env.SENDS;
if (process.env.WRAP) {
  // Start the 16-bit address counters near their limit to exercise wrap-around.
  const v = engine.vm as unknown as Record<string, number>;
  for (const k of ['nextClone', 'nextList', 'nextNode', 'nextHunk']) v[k] = 0xffff - 50;
}
engine.vm.stubMissing = !!process.env.STUB;
engine.sound.device = (process.env.DEVICE as 'adlib' | 'pcjr' | 'speaker') ?? 'speaker'; // cheap to render; audio isn't played headless

const KEYS: Record<string, number> = {
  Enter: 13, Esc: 27, Tab: 9, Bksp: 8, Up: 72 << 8, Down: 80 << 8, Left: 75 << 8, Right: 77 << 8, Space: 32,
};
for (let i = 1; i <= 10; i++) KEYS[`F${i}`] = (58 + i) << 8;

let lastRoom: number | undefined;
const tick = () => new Promise((r) => setImmediate(r));

/** Advances simulated time, letting the engine run whenever its sleep expires. */
async function advance(ms: number): Promise<void> {
  const end = now + ms;
  for (let guard = 0; guard < 1e6 && !stoppedMsg; guard++) {
    await tick();
    sleepers.sort((a, b) => a.at - b.at);
    const next = sleepers[0];
    if (!next || next.at > end) {
      if (process.env.DEBUG) console.log(`  advance stop at ${now}: next=${next ? next.at : 'none'} end=${end} sleepers=${sleepers.length}`);
      break;
    }
    sleepers.shift();
    now = Math.max(now, next.at);
    next.resolve();
    const room = engine.vm.globalsScript?.locals[11];
    if (room !== lastRoom) {
      console.log(`  [${Math.round(now)} ms] room ${lastRoom} -> ${room}`);
      if (process.env.GLOBALS) console.log('    globals 0-120:', Array.from(engine.vm.globalsScript?.locals.slice(0, 120) ?? []).join(','));
      lastRoom = room;
    }
  }
  now = Math.max(now, end);
}

void engine.run();
(async () => {
  for (const step of process.argv.slice(3)) {
    const c = step[0];
    const arg = step.slice(1);
    if (c === 'w') await advance(Number(arg));
    else if (c === 'k') {
      engine.pushKey(KEYS[arg] ?? arg.charCodeAt(0));
      await advance(50);
    } else if (c === 't') {
      for (const ch of arg) {
        engine.pushKey(ch.charCodeAt(0));
        await advance(30);
      }
      engine.pushKey(13);
      console.log(`  > ${arg}`);
      await advance(300);
    } else if (c === 'c') {
      const [x, y] = arg.split(',').map(Number);
      engine.moveMouse(x, y);
      engine.pushMouse(true, x, y);
      await advance(30);
      engine.pushMouse(false, x, y);
      await advance(100);
    } else if (c === 's') {
      writePng(`${out}/${arg}.png`, lastFrame, 320, 200, 1, 1);
      if (process.env.VIEWS) {
        const vs = new Set([...engine.gfx.screen.placements.values()].map((p) => `${p.view}:${p.loop}`));
        console.log('    views on screen:', [...vs].join(' '));
      }
      if (process.env.AI) {
        const c = aiComposite(engine, lastFrame, `${process.env.GAME ?? 'public/games/sq3'}/ai`);
        if (c) writePngRgb(`${out}/${arg}-ai.png`, c, 1280, 800);
      }
      console.log(`  shot ${arg} at ${Math.round(now)} ms, room ${engine.vm.globalsScript?.locals[11] ?? '?'}`);
    }
    if (stoppedMsg) break;
  }
  process.exit(0);
})();
