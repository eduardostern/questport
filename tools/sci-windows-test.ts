// Focused visual test for the windows/text/controls/menu kernel functions (src/sci/kernel/windows.ts).
// Calls the kernel functions directly with fake arguments on SQ3's resources and writes PNGs.
// Usage: npx tsx tools/sci-windows-test.ts [outdir]   (GAME=dir to use another SCI0 game)
import { mkdirSync } from 'node:fs';
import { SciResources, ResType } from '../src/sci/resource';
import { SciVM, mk, segOf, offOf, num } from '../src/sci/vm';
import { SciGfx } from '../src/sci/gfx';
import type { SciContext } from '../src/sci/context';
import { registerCore } from '../src/sci/kernel/core';
import { registerWindows } from '../src/sci/kernel/windows';
import { loadGameDir, writePng } from './png';

const out = process.argv[2] ?? '/tmp/sci-windows-test';
mkdirSync(out, { recursive: true });
let fakeNow = 0;
const res = new SciResources(loadGameDir(process.env.GAME ?? 'public/games/sq3'));
const vm = new SciVM(res, { now: () => fakeNow });
const gfx = new SciGfx(res);
gfx.allocHandle = (v) => vm.newHunk(v);
gfx.freeHandle = (h) => vm.freeHunk(h);
const queued: { type: number; message: number; modifiers: number; x: number; y: number }[] = [];
const ctx: SciContext = {
  vm, gfx, now: () => fakeNow, hooks: {},
  mouse: { x: 160, y: 100, visible: true, view: 0, loop: 0, cel: 0 },
  waitInput: () => queued.shift() ?? null,
};
registerCore(ctx);
const win = registerWindows(ctx);

let failures = 0;
const check = (cond: boolean, what: string) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) failures++;
};
const K = (name: string, ...args: number[]) => {
  const f = vm.kernelImpl.get(name);
  if (!f) throw new Error(`kernel ${name} missing`);
  const r = f(vm, args);
  return typeof r === 'number' ? r : vm.acc;
};
const str = (s: string) => {
  const p = vm.allocDynMem(Math.max(s.length + 1, 64), 'test string');
  vm.setString(p, s);
  return p;
};
const shot = (name: string) => writePng(`${out}/${name}.png`, gfx.screen.output, 320, 200, 2, 2);
const snapshot = () => gfx.screen.output.slice();
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Finds a class object by name (loads its script). */
function findClass(name: string): number {
  for (let i = 0; i < vm.classTable.length; i++) {
    try {
      const a = vm.getClassAddress(i);
      if (vm.objectName(a) === name) return a;
    } catch {
      /* missing script */
    }
  }
  throw new Error(`class ${name} not found`);
}
const newObj = (cls: string, props: Record<string, number>) => {
  const o = vm.clone(findClass(cls));
  for (const [k, v] of Object.entries(props)) vm.setSel(o, k, num(v));
  return o;
};

// ---------------------------------------------------------------- background picture + status line
const picNr = [1, 2, 10, 13, 20, 100].find((n) => res.get(ResType.Pic, n));
gfx.setPort(gfx.picWind);
if (picNr !== undefined) gfx.drawPicture(picNr, false, false, 0);
gfx.screen.copyToOutput(0, 0, 320, 200);
K('DrawStatus', str(' Score: 0 of 738                 Space Quest ]I['), 0, 15);
shot('01-status');
const base = snapshot();

// ---------------------------------------------------------------- menu bar
K('AddMenu', str(' \x01 '), str('About game`^a:Help`#1'));
K('AddMenu', str(' File '), str('Save Game`#5:Restore Game`#7:--!:Restart Game`#9:Quit`^q'));
K('AddMenu', str(' Action '), str('Pause Game`^p:Inventory`^I:Retype`#3:--!:Boss Key`^b'));
K('AddMenu', str(' Speed '), str('Change...`^s:--!:Faster`+:Normal`=:Slower`-'));
K('SetMenu', 0x0204, 0x70, 0); // disable File/Restart Game
check(K('GetMenu', 0x0204, 0x70) === 0, 'GetMenu enabled attr reflects SetMenu');
check(K('GetMenu', 0x0205, 0x6f) === 'q'.charCodeAt(0), 'Quit has ctrl-q keypress');
check(K('GetMenu', 0x0201, 0x6f) === 63 << 8, 'Save Game has F5 keypress');
K('DrawMenuBar', 1);
shot('02-menubar');

const ev = newObj('Event', { type: 4, message: 17, modifiers: 4 }); // ctrl-q (message 17 = ^Q)
check(K('MenuSelect', ev) === 0x0205, 'MenuSelect maps Ctrl-Q to File/Quit');
check(vm.getSel(ev, 'claimed') === 1, 'MenuSelect claims the shortcut event');
vm.setSel(ev, 'claimed', 0);
vm.setSel(ev, 'message', 61 << 8); // F3
vm.setSel(ev, 'modifiers', 0);
check(K('MenuSelect', ev) === 0x0303, 'MenuSelect maps F3 to Action/Retype');

// Interactive keyboard menu: Esc, Right, Down, Down (skips separator? no: Restore), then snapshot mid-way.
vm.setSel(ev, 'message', 27);
vm.setSel(ev, 'claimed', 0);
queued.push({ type: 4, message: 77 << 8, modifiers: 0, x: 0, y: 0 }, { type: 4, message: 80 << 8, modifiers: 0, x: 0, y: 0 });
check(K('MenuSelect', ev) === 0, 'MenuSelect with Esc and no Enter queued returns 0 (menu stays open)');
check(win.menu.isOpen(), 'menu is open waiting for input');
shot('03-menu-open');
win.menu.feed({ type: 4, message: 80 << 8, modifiers: 0, x: 0, y: 0 }); // down: separator skipped -> Restart (disabled)
shot('04-menu-sep-skip');
win.menu.feed({ type: 4, message: 72 << 8, modifiers: 0, x: 0, y: 0 }); // up -> Restore Game
win.menu.feed({ type: 4, message: 13, modifiers: 0, x: 0, y: 0 }); // enter
check(!win.menu.isOpen(), 'menu closed after Enter');
vm.setSel(ev, 'type', 4);
vm.setSel(ev, 'message', 0);
vm.setSel(ev, 'claimed', 0);
check(K('MenuSelect', ev) === 0x0202, 'pending selection (File/Restore) delivered on next MenuSelect');
const afterMenu = snapshot();
K('DrawStatus', str(' Score: 0 of 738                 Space Quest ]I['), 0, 15);
check(same(snapshot(), base), 'screen restored after menu closed (status redrawn)');
void afterMenu;

// Fully synchronous interactive path: Esc + queued Right, Enter.
vm.setSel(ev, 'message', 27);
vm.setSel(ev, 'claimed', 0);
queued.push({ type: 4, message: 77 << 8, modifiers: 0, x: 0, y: 0 }, { type: 4, message: 13, modifiers: 0, x: 0, y: 0 });
check(K('MenuSelect', ev) === 0x0301, 'Esc, Right, Enter (queued) selects Action/Pause synchronously');

// Mouse: press on "Speed", drag to "Faster", release.
const speedX = 8 + [' \x01 ', ' File ', ' Action '].reduce((a, s) => a + gfx.stringWidth(s, 0), 0) + 3;
vm.setSel(ev, 'type', 1);
vm.setSel(ev, 'x', speedX);
vm.setSel(ev, 'y', 3);
vm.setSel(ev, 'claimed', 0);
queued.push({ type: 0, message: 0, modifiers: 0, x: speedX + 5, y: 10 + 8 * 2 + 3 });
check(K('MenuSelect', ev) === 0, 'mouse press on bar opens menu (tracking)');
shot('05-menu-mouse');
win.menu.feed({ type: 2, message: 0, modifiers: 0, x: speedX + 5, y: 10 + 8 * 2 + 3 });
vm.setSel(ev, 'type', 4);
vm.setSel(ev, 'message', 0);
check(K('MenuSelect', ev) === 0x0403, 'mouse release selects Speed/Faster');

K('DrawStatus', str(' Score: 0 of 738                 Space Quest ]I['), 0, 15);
const base2 = snapshot();

// ---------------------------------------------------------------- window with title, text, controls
const oldPort = K('GetPort');
check(oldPort === 2, 'GetPort initially returns picWind (2)');
const wid = K('NewWindow', 40, 30, 150, 290, str('Space Quest ]I['), 4, 15, 0, 15);
check(wid === 3, 'NewWindow returns id 3');
check(K('GetPort') === 3, 'NewWindow makes the window the current port');
K('Display',
  str('You are standing in the bowels of a garbage freighter. Everything around you is junk, junk, and more junk.'),
  100, 4, 2, 106, 252);
const size = vm.allocDynMem(8, 'rect');
K('TextSize', size, str('Hello there, Roger Wilco!'), 0, 0);
const h = vm.readWord(size + 4), w = vm.readWord(size + 6);
check(h === 8 && w === gfx.stringWidth('Hello there, Roger Wilco!', 0), `TextSize single line = ${w}x${h}`);
K('TextSize', size, str('You are standing in the bowels of a garbage freighter. Everything around you is junk.'), 0, 100);
check(vm.readWord(size + 4) > 8 && vm.readWord(size + 6) === 100, `TextSize wrapped at 100 = ${vm.readWord(size + 6)}x${vm.readWord(size + 4)}`);
// centered / right aligned text lines
K('Display', str('centered'), 100, 4, 36, 101, 1, 106, 252);
K('Display', str('right, red'), 100, 4, 46, 101, 0xffff, 106, 252, 102, 4);
K('Display', str('greyed, on yellow'), 100, 4, 56, 104, 1, 103, 14);

const button = newObj('DButton', { type: 1, state: 1 | 8, nsLeft: 10, nsTop: 80, nsRight: 70, nsBottom: 90, font: 0 });
vm.setSel(button, 'text', str('Okay'));
K('DrawControl', button);
const button2 = newObj('DButton', { type: 1, state: 0, nsLeft: 80, nsTop: 80, nsRight: 140, nsBottom: 90, font: 0 });
vm.setSel(button2, 'text', str('Disabled'));
K('DrawControl', button2);
const editText = str('look');
const edit = newObj('DEdit', { type: 3, state: 8, nsLeft: 150, nsTop: 82, nsRight: 250, nsBottom: 90, font: 0, max: 30, cursor: 4 });
vm.setSel(edit, 'text', editText);
K('DrawControl', edit);
const txt = newObj('DText', { type: 2, state: 0, nsLeft: 10, nsTop: 66, nsRight: 250, nsBottom: 74, font: 0, mode: 1 });
vm.setSel(txt, 'text', str('A DText control, centered (mode 1)'));
K('DrawControl', txt);
shot('06-window');

const kev = newObj('Event', { type: 4, message: 32, modifiers: 0 });
for (const c of ' at junk') {
  vm.setSel(kev, 'message', c.charCodeAt(0));
  K('EditControl', edit, kev);
}
vm.setSel(kev, 'message', 8); // backspace
K('EditControl', edit, kev);
vm.setSel(kev, 'message', 75 << 8); // left
K('EditControl', edit, kev);
check(vm.getString(editText) === 'look at jun', `EditControl edits text: "${vm.getString(editText)}"`);
check(vm.getSel(edit, 'cursor') === 10, 'EditControl cursor position');
K('HiliteControl', button);
shot('07-window-edit-hilite');
K('HiliteControl', button);

// Display save-under / restore-under
const hUnder = K('Display', str('Saved under!'), 100, 150, 4, 107, 103, 4, 102, 15);
check(segOf(hUnder) !== 0, 'Display p_save returns a handle');
const beforeRestore = snapshot();
K('Display', str(''), 108, hUnder);
check(!same(snapshot(), beforeRestore), 'Display p_restore changes the screen back');

// kGraph primitives in the window
K('Graph', 4, 100, 10, 106, 250, 1); // blue line
K('Graph', 11, 92, 260, 104, 270, 1, 2); // green box
K('Graph', 12, 92, 0, 108, 280); // update
shot('08-window-graph');

// ---------------------------------------------------------------- dispose and verify restore
K('DisposeWindow', wid, 0);
check(K('GetPort') === 2, 'DisposeWindow switches back to front port');
shot('09-disposed');
check(same(snapshot(), base2), 'screen identical to before the window after DisposeWindow');

// Graph save/restore box round trip in the picture window
const hb = K('Graph', 7, 20, 20, 60, 60, 1);
K('Graph', 11, 20, 20, 60, 60, 1, 4);
K('Graph', 12, 20, 20, 60, 60);
K('Graph', 8, hb);
K('Graph', 12, 20, 20, 60, 60);
check(same(snapshot(), base2), 'Graph SaveBox/FillBox/RestoreBox round-trip');

// Untitled window (style 0) and a no-frame user window (0x81 = user+transparent)
const w2 = K('NewWindow', 60, 60, 100, 260, 0, 0, 15, 0, 15);
K('Display', str('Untitled SCI0 window: white with a black frame and shadow.'), 100, 0, 0, 106, 196);
shot('10-untitled');
K('DisposeWindow', w2, 1);
check(same(snapshot(), base2), 'untitled window disposed (reanimate path) restores screen');

K('DrawMenuBar', 0);
shot('11-menubar-cleared');
console.log(failures ? `${failures} FAILURES` : 'all checks passed', `- PNGs in ${out}`);
void mk;
void offOf;
process.exit(failures ? 1 : 0);
