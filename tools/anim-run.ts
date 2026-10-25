// Headless SCI runner for development (animation module testing variant of sci-run.ts).
// Env: GAME=dir  STUB=1 (stub missing kernel calls)  SENDS=1 (trace sends)  TRACE=1  MS=<simulated ms to run>
//      SHOT=<outdir> (writes output screen PNGs every SHOTEVERY ms, default 2000)  KEYS="ms:key,..." (e.g. "5000:13")
import { mkdirSync } from 'node:fs';
import { SciResources } from '../src/sci/resource';
import { SciVM, SciError } from '../src/sci/vm';
import { SciGfx } from '../src/sci/gfx';
import type { SciContext } from '../src/sci/context';
import { registerCore } from '../src/sci/kernel/core';
import { registerWindows } from '../src/sci/kernel/windows';
import { registerAnimation } from '../src/sci/kernel/animate';
import { SciInput } from '../src/sci/kernel/input';
import { SciSound } from '../src/sci/kernel/sound';
import { loadGameDir, writePng } from './png';

let fakeNow = 0;
// Make the wall clock (kGetTime 1/2/3, used by Script `seconds`) follow the simulated clock.
{
  const RealDate = Date;
  const base = RealDate.now();
  class SimDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [number]));
      else super(base + fakeNow);
    }
    static now(): number {
      return base + fakeNow;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = SimDate as DateConstructor;
}
const res = new SciResources(loadGameDir(process.env.GAME ?? 'public/games/sq3'));
const vm = new SciVM(res, { now: () => fakeNow });
const gfx = new SciGfx(res);
gfx.allocHandle = (v) => vm.newHunk(v);
gfx.freeHandle = (h) => vm.freeHunk(h);
const ctx: SciContext = {
  vm, gfx, now: () => fakeNow, hooks: {},
  mouse: { x: 160, y: 100, visible: true, view: 997, loop: 0, cel: 0 },
};
registerCore(ctx);
registerWindows(ctx);
registerAnimation(ctx);
const input = new SciInput(ctx);
input.register();
let audioId = 1;
const sound = new SciSound(ctx, { play: () => audioId++, stop: () => undefined, setVolume: () => undefined, time: () => fakeNow / 1000 });
sound.register();
input.onPoll = () => sound.update();
ctx.waitInput = () => input.take(0x7fff);
ctx.said = (spec) => input.saidAt(spec);
// KEYS="ms:key,..." pushes key-down events at simulated times
const keys = (process.env.KEYS ?? '').split(',').filter(Boolean).map((s) => s.split(':').map(Number));
// (anim-run: advances picture transitions every simulated frame)
(globalThis as any).__sciCtx = ctx;
vm.stubMissing = !!process.env.STUB;
vm.traceSends = !!process.env.SENDS;
vm.trace = !!process.env.TRACE;
if (process.env.KCOUNT) {
  const counts = new Map<string, number>();
  for (const name of vm.kernelNames) {
    const f = vm.kernelImpl.get(name);
    if (!f) continue;
    vm.kernelImpl.set(name, (v, a) => {
      if (fakeNow >= Number(process.env.KCOUNT)) counts.set(name, (counts.get(name) ?? 0) + 1);
      return f(v, a);
    });
  }
  process.on('exit', () => console.log([...counts].map(([k, n]) => `${k}:${n}`).join(' ')));
}
vm.bindKernel();

const shotDir = process.env.SHOT;
if (shotDir) mkdirSync(shotDir, { recursive: true });
const montage: Uint8Array[] = [];
const shotEvery = Number(process.env.SHOTEVERY ?? 2000);
const endMs = Number(process.env.MS ?? 10000);
let nextShot = shotEvery;
try {
  vm.startGame();
  let guard = 0;
  while (vm.running && fakeNow < endMs && !vm.abort) {
    vm.yieldRequested = false;
    while (keys.length && keys[0][0] <= fakeNow) {
      const [, key] = keys.shift()!;
      input.push({ type: 4, message: key, modifiers: 0, x: ctx.mouse.x, y: ctx.mouse.y });
    }
    vm.runVM(0, Number(process.env.BUDGET ?? 200_000));
    if (vm.yieldRequested) {
      const target = Math.max(fakeNow + 1, vm.waitUntil);
      // Present picture transitions frame by frame while the VM waits.
      while (gfx.screen.pendingTransition && fakeNow < target) {
        fakeNow = Math.min(target, fakeNow + 16);
        gfx.screen.advanceTransition(fakeNow);
        if (shotDir && process.env.TRANSSHOTS && gfx.screen.outputDirty) {
          writePng(`${shotDir}/tr${String(fakeNow).padStart(6, '0')}.png`, gfx.screen.output, 320, 200, 1, 1);
        }
      }
      fakeNow = target;
    } else fakeNow += 16;
    if (shotDir && fakeNow >= nextShot) {
      writePng(`${shotDir}/t${String(nextShot).padStart(6, '0')}.png`, gfx.screen.output, 320, 200, 1, 1);
      montage.push(gfx.screen.output.slice());
      nextShot += shotEvery;
    }
    if (process.env.DUMP && fakeNow >= Number(process.env.DUMP)) {
      process.env.DUMP = '';
      const g = (vm as any).globalsScript.locals as number[];
      console.log('globals 0..20:', g.slice(0, 20).map((v) => v.toString(16)).join(' '));
      for (const gi of [5, 2, 1]) {
        const lst = vm.getSel(g[gi], 'elements');
        console.log(`global ${gi} = ${vm.objectName(g[gi])}`);
        void lst;
      }
      const room = g[2];
      console.log('room', vm.objectName(room), 'script', vm.objectName(vm.getSel(room, 'script')), 'state', vm.getSel(vm.getSel(room, 'script'), 'state'), 'cycles', vm.getSel(vm.getSel(room, 'script'), 'cycles'), 'seconds', vm.getSel(vm.getSel(room, 'script'), 'seconds'));
      const cast = g[5];
      let n = vm.list(vm.getSel(cast, 'elements'))?.first ?? 0;
      while (n) {
        const nd = vm.node(n)!;
        const o = nd.value;
        console.log(' cast', vm.objectName(o), ['view', 'loop', 'cel', 'x', 'y', 'z', 'priority', 'signal', 'cycler', 'mover', 'script'].map((k) => `${k}=${vm.getSel(o, k).toString(16)}`).join(' '));
        n = nd.succ;
      }
    }
    if (++guard > 1e6) break;
  }
  console.log(`stopped at ${fakeNow} ms; instructions ${vm.instructionCount}; frames ${vm.frames.length}`);
} catch (e) {
  console.log('ERROR:', (e as Error).message);
  if (!(e instanceof SciError)) console.log((e as Error).stack);
  console.log(`at ${fakeNow} ms, instructions ${vm.instructionCount}`);
  console.log(vm.backtrace());
}
if (shotDir) writePng(`${shotDir}/final.png`, gfx.screen.output, 320, 200, 1, 1);
// Contact sheets: 4x4 frames (with a 2px grey gap) per image.
if (shotDir) {
  const cols = 4;
  const rows = 4;
  const W = cols * 322;
  const H = rows * 202;
  for (let p = 0; p * 16 < montage.length; p++) {
    const img = new Uint8Array(W * H).fill(8);
    for (let i = 0; i < 16 && p * 16 + i < montage.length; i++) {
      const f = montage[p * 16 + i];
      const ox = (i % cols) * 322;
      const oy = Math.floor(i / cols) * 202;
      for (let y = 0; y < 200; y++) img.set(f.subarray(y * 320, y * 320 + 320), (oy + y) * W + ox);
    }
    writePng(`${shotDir}/sheet${String(p).padStart(2, '0')}.png`, img, W, H, 1, 1);
  }
}
