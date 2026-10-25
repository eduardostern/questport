// Events (keyboard/mouse) and the text parser kernel functions.

import type { SciContext } from '../context';
import { mk, segOf, offOf, num } from '../vm';
import { SciParser, SAID_FULL_MATCH, SAID_NO_MATCH } from '../parser';

export const EV_NONE = 0;
export const EV_MOUSE_DOWN = 1;
export const EV_MOUSE_UP = 2;
export const EV_KEY_DOWN = 4;
export const EV_KEY_UP = 8;
export const EV_DIRECTION = 0x40;
export const EV_PEEK = 0x8000;

export interface SciEvent {
  type: number;
  message: number; // key code (ASCII, or scancode << 8 for special keys)
  modifiers: number;
  x: number;
  y: number;
}

// Scancode-based key messages (SCI uses scancode << 8 for non-ASCII keys)
const KEY_TO_DIR = new Map<number, number>([
  [72 << 8, 1], [73 << 8, 2], [77 << 8, 3], [81 << 8, 4], [80 << 8, 5], [79 << 8, 6], [75 << 8, 7], [71 << 8, 8], [76 << 8, 0],
]);

export class SciInput {
  queue: SciEvent[] = [];
  parser: SciParser;
  /** Event object the last kParse ran for; kSaid checks/claims it. */
  private parserEvent = 0;
  private parserPtr = 0;

  constructor(private ctx: SciContext) {
    this.parser = new SciParser(ctx.vm.res);
  }

  push(ev: SciEvent): void {
    if (ev.type & (EV_MOUSE_DOWN | EV_MOUSE_UP)) {
      this.ctx.mouse.x = ev.x;
      this.ctx.mouse.y = ev.y;
    }
    if (this.queue.length < 64) this.queue.push(ev);
  }

  /** Removes (or peeks) the first queued event matching the mask. */
  take(mask: number): SciEvent | null {
    const i = this.queue.findIndex((e) => (e.type & mask) !== 0);
    if (i < 0) return null;
    const e = this.queue[i];
    if (!(mask & EV_PEEK)) this.queue.splice(i, 1);
    return e;
  }

  register(): void {
    const { vm } = this.ctx;
    const k = vm.kernelImpl;
    this.parserPtr = vm.allocDynMem(256, 'parser');

    k.set('GetEvent', (vm, a) => {
      const mask = offOf(a[0]);
      const obj = a[1];
      const ev = this.take(mask);
      this.parserEvent = 0;
      vm.setSel(obj, 'x', num(this.ctx.mouse.x));
      vm.setSel(obj, 'y', num(this.ctx.mouse.y));
      const mods = ((ev?.modifiers ?? 0) | 0x0200) & 0xffff;
      let result = 0;
      if (ev && (ev.type === EV_KEY_DOWN || ev.type === EV_KEY_UP)) {
        vm.setSel(obj, 'type', ev.type);
        vm.setSel(obj, 'message', num(ev.message));
        vm.setSel(obj, 'modifiers', mods);
        result = 1;
      } else if (ev && (ev.type === EV_MOUSE_DOWN || ev.type === EV_MOUSE_UP)) {
        vm.setSel(obj, 'type', ev.type);
        vm.setSel(obj, 'message', 0);
        vm.setSel(obj, 'modifiers', mods);
        vm.setSel(obj, 'x', num(ev.x));
        vm.setSel(obj, 'y', num(ev.y));
        result = 1;
      } else {
        vm.setSel(obj, 'type', EV_NONE);
        vm.setSel(obj, 'message', 0);
        vm.setSel(obj, 'modifiers', mods);
      }
      this.onPoll?.();
      return result;
    });

    k.set('MapKeyToDir', (vm, a) => {
      const obj = a[0];
      if (vm.getSel(obj, 'type') !== EV_KEY_DOWN) return undefined;
      const dir = KEY_TO_DIR.get(offOf(vm.getSel(obj, 'message')));
      if (dir === undefined) return 0;
      vm.setSel(obj, 'type', EV_DIRECTION);
      vm.setSel(obj, 'message', dir);
      return 1;
    });

    k.set('Parse', (vm, a) => {
      const strPtr = a[0];
      const event = a[1];
      this.parserEvent = event;
      const r = this.parser.parseInput(vm.getString(strPtr));
      switch (r.kind) {
        case 'ok':
          vm.setSel(event, 'claimed', 0);
          return 1;
        case 'syntaxFail':
          vm.setSel(event, 'claimed', 1);
          vm.invoke(vm.gameObject, 'syntaxFail', this.parserPtr, strPtr);
          return 1;
        case 'wordFail':
          vm.setString(this.parserPtr, r.word);
          vm.setSel(event, 'claimed', 1);
          vm.invoke(vm.gameObject, 'wordFail', this.parserPtr, strPtr);
          return 1;
        default:
          vm.setSel(event, 'claimed', 1);
          return 0;
      }
    });

    k.set('Said', (vm, a) => {
      const spec = a[0];
      const ev = this.parserEvent;
      if (!ev || !this.parser.lastParseValid || vm.getSel(ev, 'claimed')) return 0;
      const seg = vm.segments[segOf(spec)];
      if (!seg || seg.type !== 'script') return 0;
      const m = this.parser.saidMatch(seg.script.buf, offOf(spec));
      if (m === SAID_NO_MATCH) return 0;
      if (m === SAID_FULL_MATCH) vm.setSel(ev, 'claimed', 1);
      return 1;
    });

    k.set('SetSynonyms', (vm, a) => {
      this.parser.clearSynonyms();
      let p = vm.list(a[0])?.first ?? 0;
      while (p) {
        const n = vm.node(p);
        if (!n) break;
        const obj = vm.getObject(n.value);
        if (obj) for (const s of obj.script.synonyms) this.parser.addSynonym(s);
        p = n.succ;
      }
    });
    void mk;
  }

  /** Matches a said spec (script pointer) against the last parse (used by kMenuSelect). */
  saidAt(spec: number): boolean {
    const seg = this.ctx.vm.segments[segOf(spec)];
    if (!seg || seg.type !== 'script' || !this.parser.lastParseValid) return false;
    return this.parser.saidMatch(seg.script.buf, offOf(spec)) !== SAID_NO_MATCH;
  }

  /** Called on every kGetEvent (sound cues are updated here, like Sierra's SCI0). */
  onPoll?: () => void;

  /** Clears parser state after restore/restart. */
  reset(): void {
    this.parserEvent = 0;
    this.parser.invalidate();
    this.queue.length = 0;
  }
}
