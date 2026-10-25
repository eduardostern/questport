// Files (a tiny virtual file system) and save games, stored by the host (localStorage in the browser).

import type { SciContext } from '../context';
import { offOf, s16, num, mk, segOf } from '../vm';

export interface SciStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const MAX_SAVE_NAME = 36;
const VIRTUAL_ID_START = 100;

export interface SaveExtras {
  /** Extra state to store with a save (sound slots, etc.). */
  collect(): unknown;
  /** Called after the heap is restored, before the game is replayed. */
  apply(extra: unknown): void;
}

export class SciFiles {
  private open = new Map<number, { name: string; lines: string[]; pos: number; write: boolean }>();
  private nextHandle = 1;
  private lastVirtualId = -1;
  private lastNewId = -1;
  extras: SaveExtras | null = null;

  constructor(private ctx: SciContext, private storage: SciStorage, private gameId: string) {}

  private fileKey(name: string): string {
    return `sci-${this.gameId}-file-${name.toLowerCase()}`;
  }
  private saveKey(id: number): string {
    return `sci-${this.gameId}-save-${id}`;
  }

  /** Lists saves as {id, name}, most recent first like Sierra's dialogs. */
  listSaves(): { id: number; name: string; time: number }[] {
    const idx = this.storage.get(`sci-${this.gameId}-saves`);
    const ids: number[] = idx ? JSON.parse(idx) : [];
    const out: { id: number; name: string; time: number }[] = [];
    for (const id of ids) {
      const raw = this.storage.get(this.saveKey(id));
      if (!raw) continue;
      try {
        const s = JSON.parse(raw);
        out.push({ id, name: s.description, time: s.time ?? 0 });
      } catch {
        /* skip damaged */
      }
    }
    return out.sort((a, b) => b.time - a.time);
  }

  register(): void {
    const k = this.ctx.vm.kernelImpl;

    k.set('FOpen', (vm, a) => {
      const name = vm.getString(a[0]);
      const mode = offOf(a[1]);
      const existing = this.storage.get(this.fileKey(name));
      // mode 0: open or create (append), 1: open or fail, 2: create
      if (mode === 1 && existing === null) return 0;
      const lines = mode === 2 || existing === null ? [] : existing.split('\n');
      const h = this.nextHandle++;
      this.open.set(h, { name, lines, pos: 0, write: mode !== 1 });
      return h;
    });
    k.set('FPuts', (vm, a) => {
      const f = this.open.get(offOf(a[0]));
      if (!f) return 0;
      const text = vm.getString(a[1]);
      const all = f.lines.join('\n') + text;
      f.lines = all.split('\n');
      return 1;
    });
    k.set('FGets', (vm, a) => {
      const f = this.open.get(offOf(a[2]));
      const max = offOf(a[1]);
      if (!f || f.pos >= f.lines.length) return 0;
      const line = f.lines[f.pos++].slice(0, Math.max(0, max - 1));
      vm.setString(a[0], line + (f.pos < f.lines.length ? '\n' : ''));
      return a[0];
    });
    k.set('FClose', (_vm, a) => {
      const h = offOf(a[0]);
      const f = this.open.get(h);
      if (f?.write) this.storage.set(this.fileKey(f.name), f.lines.join('\n'));
      this.open.delete(h);
    });

    k.set('GetSaveFiles', (vm, a) => {
      this.lastVirtualId = VIRTUAL_ID_START;
      const saves = this.listSaves().slice(0, 20);
      for (let i = 0; i < saves.length; i++) {
        const name = saves[i].name.slice(0, MAX_SAVE_NAME - 1);
        vm.setString(mk(segOf(a[1]), offOf(a[1]) + i * MAX_SAVE_NAME), name);
        vm.writeWord(mk(segOf(a[2]), offOf(a[2]) + i * 2), saves[i].id + VIRTUAL_ID_START);
      }
      vm.writeByte(mk(segOf(a[1]), offOf(a[1]) + saves.length * MAX_SAVE_NAME), 0);
      return saves.length;
    });
    k.set('CheckSaveGame', (_vm, a) => {
      const v = offOf(a[1]);
      if (v < VIRTUAL_ID_START) return 0;
      return this.storage.get(this.saveKey(v - VIRTUAL_ID_START)) ? 1 : 0;
    });
    k.set('SaveGame', (vm, a) => {
      const virtualId = s16(a[1]);
      const description = vm.getString(a[2]);
      const saves = this.listSaves();
      let id: number;
      if (virtualId >= VIRTUAL_ID_START) id = virtualId - VIRTUAL_ID_START;
      else if (virtualId === this.lastVirtualId && this.lastNewId > 0) id = this.lastNewId;
      else {
        id = 1;
        while (saves.some((s) => s.id === id)) id++;
      }
      this.lastVirtualId = virtualId;
      this.lastNewId = id;
      const state = {
        description,
        time: Date.now(),
        heap: vm.serialize(),
        extra: this.extras?.collect() ?? null,
      };
      try {
        this.storage.set(this.saveKey(id), JSON.stringify(state));
        const ids = new Set(saves.map((s) => s.id));
        ids.add(id);
        this.storage.set(`sci-${this.gameId}-saves`, JSON.stringify([...ids]));
      } catch (e) {
        console.error('Save failed', e);
        return 0;
      }
      return 1;
    });
    k.set('RestoreGame', (vm, a) => {
      const v = s16(a[1]);
      if (v < VIRTUAL_ID_START) return 1;
      const raw = this.storage.get(this.saveKey(v - VIRTUAL_ID_START));
      if (!raw) return 1;
      const state = JSON.parse(raw);
      vm.deserialize(state.heap);
      this.extras?.apply(state.extra);
      vm.abort = 'restore';
      return 0;
    });
    k.set('RestartGame', (vm) => {
      vm.abort = 'restart';
      return num(0);
    });
  }
}
