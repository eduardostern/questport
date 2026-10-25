// SCI0 engine: wires the VM, graphics, kernel modules and the host together and runs the game loop.

import { SciResources, ResType } from './resource';
import type { GameFiles } from '../resources';
import { SciVM, SciError } from './vm';
import { SciGfx } from './gfx';
import { SCREEN_W, SCREEN_H } from './screen';
import type { SciContext } from './context';
import { registerCore } from './kernel/core';
import { registerWindows, SciWindows } from './kernel/windows';
import { registerAnimation } from './kernel/animate';
import { SciInput, SciEvent, EV_KEY_DOWN, EV_MOUSE_DOWN, EV_MOUSE_UP } from './kernel/input';
import { SciSound, SciAudioHost } from './kernel/sound';
import { SciFiles, SciStorage } from './kernel/files';

export interface SciEngineHost {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Called with the 320x200 EGA-indexed frame (cursor already drawn) whenever it changes. */
  present(pixels: Uint8Array): void;
  audio: SciAudioHost;
  storage: SciStorage;
  /** Called when the game ends or crashes. */
  stopped?(reason: string): void;
  /** Shakes the display (kShakeScreen). */
  shake?(count: number, directions: number): void;
}

export function isSciGame(files: GameFiles): boolean {
  return files.has('RESOURCE.MAP') && files.has('RESOURCE.001');
}

export class SciEngine {
  readonly res: SciResources;
  vm!: SciVM;
  gfx!: SciGfx;
  ctx!: SciContext;
  input!: SciInput;
  sound!: SciSound;
  files!: SciFiles;
  windows!: SciWindows;
  private frame = new Uint8Array(SCREEN_W * SCREEN_H);
  /** Pixels covered by the mouse cursor in the last presented frame (1 = cursor). */
  readonly cursorMask = new Uint8Array(SCREEN_W * SCREEN_H);
  private cursorShape: Uint8Array | null = null; // 16x16, 255 = transparent
  private cursorHot = { x: 0, y: 0 };
  private cursorNr = -1;
  private quit = false;

  constructor(files: GameFiles, private host: SciEngineHost, readonly gameId = 'sci') {
    this.res = new SciResources(files);
    this.boot(false);
  }

  private boot(restarting: boolean): void {
    const host = this.host;
    this.vm = new SciVM(this.res, { now: () => host.now() });
    this.gfx = new SciGfx(this.res);
    this.gfx.allocHandle = (v) => this.vm.newHunk(v);
    this.gfx.freeHandle = (h) => this.vm.freeHunk(h);
    this.ctx = {
      vm: this.vm,
      gfx: this.gfx,
      now: () => host.now(),
      hooks: {},
      mouse: this.ctx?.mouse ?? { x: 160, y: 100, visible: true, view: 0, loop: 0, cel: 0 },
    };
    registerCore(this.ctx);
    this.windows = registerWindows(this.ctx);
    this.ctx.hooks.shakeScreen = (count, dirs) => this.host.shake?.(count, dirs);
    registerAnimation(this.ctx);
    this.input = new SciInput(this.ctx);
    this.input.register();
    this.sound?.reset();
    this.sound = new SciSound(this.ctx, host.audio);
    this.sound.register();
    this.input.onPoll = () => this.sound.update();
    this.ctx.waitInput = () => this.input.take(0x7fff);
    this.ctx.said = (spec) => this.input.saidAt(spec);
    this.files = new SciFiles(this.ctx, host.storage, this.gameId);
    this.files.register();
    this.files.extras = { collect: () => null, apply: () => this.sound.reset() };
    this.vm.bindKernel();
    (this.vm as SciVM & { restarting?: boolean }).restarting = restarting;
    this.vm.startGame('play');
  }

  // ---------------------------------------------------------------- input

  pushKey(message: number, modifiers = 0): void {
    this.input.push({ type: EV_KEY_DOWN, message, modifiers, x: this.ctx.mouse.x, y: this.ctx.mouse.y });
  }

  pushMouse(down: boolean, x: number, y: number, modifiers = 0): void {
    const ev: SciEvent = { type: down ? EV_MOUSE_DOWN : EV_MOUSE_UP, message: 0, modifiers, x, y };
    this.input.push(ev);
  }

  moveMouse(x: number, y: number): void {
    this.ctx.mouse.x = x;
    this.ctx.mouse.y = y;
    // An open menu tracks the mouse through "no event" events carrying the position.
    if (this.windows.menu.isOpen()) this.input.push({ type: 0, message: 0, modifiers: 0, x, y });
    this.presentFrame();
  }

  // ---------------------------------------------------------------- loop

  async run(): Promise<void> {
    try {
      while (!this.quit) {
        const vm = this.vm;
        if (this.windows.menu.isOpen()) {
          // Sierra's menu loop blocks the game: feed it input until it closes.
          let closed = false;
          for (let ev = this.input.queue.shift(); ev && !closed; ev = this.input.queue.shift()) {
            closed = this.windows.menu.feed(ev);
          }
          if (closed) this.pushKey(0); // the scripts' next MenuSelect claims the chosen item
          this.presentFrame();
          await this.host.sleep(16);
          continue;
        }
        vm.yieldRequested = false;
        vm.runVM(0, 150_000);
        this.presentFrame();
        if (vm.abort === 'restore') {
          this.windows.reset();
          this.resetWindows();
          this.input.reset();
          vm.startGame('replay');
          continue;
        }
        if (vm.abort === 'restart') {
          this.boot(true);
          continue;
        }
        if (vm.abort === 'quit' || !vm.running) {
          this.host.stopped?.('The game has ended.');
          return;
        }
        // Picture transitions play while the game waits (Sierra drew them while blocking).
        while (this.gfx.screen.pendingTransition && vm.yieldRequested && this.host.now() < vm.waitUntil) {
          this.gfx.screen.advanceTransition(this.host.now());
          this.presentFrame();
          await this.host.sleep(16);
        }
        if (vm.yieldRequested) await this.host.sleep(Math.max(0, vm.waitUntil - this.host.now()));
        else await this.host.sleep(0);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(e, '\n' + this.vm.backtrace());
      this.host.stopped?.(`The interpreter stopped: ${msg}`);
      if (!(e instanceof SciError)) throw e;
    }
  }

  stop(): void {
    this.quit = true;
    this.sound.reset();
  }

  private resetWindows(): void {
    const g = this.gfx;
    g.windowList = [g.wmgrPort, g.picWind];
    g.windowsById.length = 3;
    g.setPort(g.picWind);
  }

  // ---------------------------------------------------------------- output

  private loadCursor(nr: number): void {
    this.cursorNr = nr;
    const d = this.res.get(ResType.Cursor, nr);
    if (!d) {
      this.cursorShape = null;
      return;
    }
    // SCI0 cursor: 2 words hotspot (byte 3 != 0 means centered), 16 words mask A, 16 words mask B
    this.cursorHot = d[3] ? { x: 8, y: 8 } : { x: 0, y: 0 };
    const shape = new Uint8Array(256);
    const colors = [0, 15, 255, 7];
    for (let y = 0; y < 16; y++) {
      const a = d[4 + y * 2] | (d[5 + y * 2] << 8);
      const b = d[36 + y * 2] | (d[37 + y * 2] << 8);
      for (let x = 0; x < 16; x++) {
        const v = (((a << x) & 0x8000) | (((b << x) >> 1) & 0x4000)) >> 14;
        shape[y * 16 + x] = colors[v];
      }
    }
    this.cursorShape = shape;
  }

  /** Presents the visible screen plus the mouse cursor. */
  presentFrame(): void {
    const scr = this.gfx.screen;
    const m = this.ctx.mouse;
    if (m.view !== this.cursorNr) this.loadCursor(m.view);
    this.frame.set(scr.output);
    this.cursorMask.fill(0);
    if (m.visible && this.cursorShape) {
      const ox = m.x - this.cursorHot.x;
      const oy = m.y - this.cursorHot.y;
      for (let y = 0; y < 16; y++) {
        const sy = oy + y;
        if (sy < 0 || sy >= SCREEN_H) continue;
        for (let x = 0; x < 16; x++) {
          const c = this.cursorShape[y * 16 + x];
          const sx = ox + x;
          if (c !== 255 && sx >= 0 && sx < SCREEN_W) {
            this.frame[sy * SCREEN_W + sx] = c;
            this.cursorMask[sy * SCREEN_W + sx] = 1;
          }
        }
      }
    }
    scr.outputDirty = false;
    this.host.present(this.frame);
  }
}
