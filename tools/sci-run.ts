// Headless SCI runner for development.
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
import { loadGameDir, writePng } from './png';

let fakeNow = 0;
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
// Extra registrations a module may export for testing (e.g. events) can go here.
(globalThis as any).__sciCtx = ctx;
vm.stubMissing = !!process.env.STUB;
vm.traceSends = !!process.env.SENDS;
vm.trace = !!process.env.TRACE;
vm.bindKernel();

const shotDir = process.env.SHOT;
if (shotDir) mkdirSync(shotDir, { recursive: true });
const shotEvery = Number(process.env.SHOTEVERY ?? 2000);
const endMs = Number(process.env.MS ?? 10000);
let nextShot = shotEvery;
try {
  vm.startGame();
  let guard = 0;
  while (vm.running && fakeNow < endMs && !vm.abort) {
    vm.yieldRequested = false;
    vm.runVM(0, Number(process.env.BUDGET ?? 200_000));
    if (vm.yieldRequested) fakeNow = Math.max(fakeNow + 1, vm.waitUntil);
    else fakeNow += 16;
    if (shotDir && fakeNow >= nextShot) {
      writePng(`${shotDir}/t${String(nextShot).padStart(6, '0')}.png`, gfx.screen.output, 320, 200, 1, 1);
      nextShot += shotEvery;
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
