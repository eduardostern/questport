// kDoSound for SCI0: one song plays at a time (by priority); scripts follow progress
// through the `signal`, `state` and `loop` selectors, updated whenever GetEvent runs.

import type { SciContext } from '../context';
import { offOf, num, s16 } from '../vm';
import { ResType } from '../resource';
import { renderSci0Sound, SciSoundRender, SciSoundDevice } from '../sound';

/** Audio output provided by the host (Web Audio in the browser, a no-op in tests). */
export interface SciAudioHost {
  /** Starts playback; returns an id. loop=true repeats [loopStart, duration). */
  play(r: SciSoundRender, loop: boolean): number;
  stop(id: number): void;
  setVolume(v: number): void; // 0..1
  /** Current audio clock in seconds. */
  time(): number;
}

const STATE_STOPPED = 0;
const STATE_INITIALIZED = 1;
const STATE_PAUSED = 2;
const STATE_PLAYING = 3;
const SIGNAL_END = 0xffff;

interface Slot {
  obj: number;
  resNr: number;
  render: SciSoundRender | null;
  loop: number; // remaining loops (16-bit; 0xffff = forever)
  priority: number;
  status: 'stopped' | 'playing' | 'paused';
  queued: boolean; // waiting for a higher-priority song to finish
  audioId: number;
  passStart: number; // audio time at which the current pass started (pass 0 starts at song time 0)
  passFrom: number; // song time where this pass started (0, or loopStart for repeats)
  cueIndex: number;
  pending: number[];
  pausedAt: number;
  fade: { start: number } | null;
}

export class SciSound {
  private slots: Slot[] = [];
  private renders = new Map<number, SciSoundRender>();
  private soundOn = true;
  private masterVolume = 15;
  device: SciSoundDevice = 'adlib';

  constructor(private ctx: SciContext, private audio: SciAudioHost) {}

  private renderFor(nr: number): SciSoundRender | null {
    const cached = this.renders.get(nr);
    if (cached) return cached;
    const data = this.ctx.vm.res.get(ResType.Sound, nr);
    if (!data) return null;
    const patch = this.ctx.vm.res.get(ResType.Patch, 3) ?? undefined;
    const r = renderSci0Sound(data, { device: this.device, adlibPatch: patch });
    this.renders.set(nr, r);
    return r;
  }

  private slot(obj: number): Slot | undefined {
    return this.slots.find((s) => s.obj === obj);
  }

  private resNr(obj: number): number {
    return offOf(this.ctx.vm.getSel(obj, 'number'));
  }

  register(): void {
    this.ctx.vm.kernelImpl.set('DoSound', (vm, a) => {
      const sub = offOf(a[0]);
      const obj = a[1] ?? 0;
      switch (sub) {
        case 0: this.init(obj); break;
        case 1: this.play(obj); break;
        case 2: break; // restore (nothing to do)
        case 3: this.dispose(obj); break;
        case 4: {
          const prev = this.soundOn ? 1 : 0;
          if (a.length > 1) {
            this.soundOn = offOf(a[1]) !== 0;
            this.applyVolume();
          }
          return prev;
        }
        case 5: this.stop(obj); break;
        case 6: this.pause(offOf(a[1] ?? 0)); return 0;
        case 7: break; // resume after restore
        case 8: {
          const prev = this.masterVolume;
          if (a.length > 1) {
            this.masterVolume = Math.max(0, Math.min(15, s16(a[1])));
            this.applyVolume();
          }
          return prev;
        }
        case 9: {
          const s = this.slot(obj);
          if (s) {
            s.loop = offOf(vm.getSel(obj, 'loop'));
            s.priority = offOf(vm.getSel(obj, 'priority'));
          }
          break;
        }
        case 10: this.fade(obj); break;
        case 11: return 9; // polyphony
        case 12: for (const s of [...this.slots]) this.stop(s.obj); break;
      }
      return undefined;
    });
  }

  private applyVolume(): void {
    this.audio.setVolume(this.soundOn ? this.masterVolume / 15 : 0);
  }

  private init(obj: number): void {
    const vm = this.ctx.vm;
    const old = this.slot(obj);
    if (old) this.kill(old);
    const resNr = this.resNr(obj);
    const s: Slot = {
      obj, resNr, render: null, loop: offOf(vm.getSel(obj, 'loop')), priority: offOf(vm.getSel(obj, 'priority')),
      status: 'stopped', queued: false, audioId: 0, passStart: 0, passFrom: 0, cueIndex: 0, pending: [], pausedAt: 0, fade: null,
    };
    this.slots.push(s);
    if (vm.res.exists(ResType.Sound, resNr)) vm.setSel(obj, 'state', STATE_INITIALIZED);
  }

  private play(obj: number): void {
    const vm = this.ctx.vm;
    let s = this.slot(obj);
    if (!s) {
      this.init(obj);
      s = this.slot(obj)!;
    }
    const nr = this.resNr(obj);
    if (s.resNr !== nr) {
      this.kill(s);
      this.init(obj);
      s = this.slot(obj)!;
    }
    vm.setSel(obj, 'handle', obj);
    vm.setSel(obj, 'state', STATE_PLAYING);
    s.loop = offOf(vm.getSel(obj, 'loop'));
    s.priority = offOf(vm.getSel(obj, 'priority'));
    s.pending = [];
    s.render = this.renderFor(s.resNr);

    // SCI0 plays one song at a time: a lower/equal priority song waits for the current one.
    const current = this.slots.find((x) => x !== s && x.status === 'playing');
    if (current) {
      if (s.priority > current.priority) {
        this.audio.stop(current.audioId);
        current.status = 'paused';
        current.pausedAt = this.audio.time();
      } else {
        s.status = 'paused';
        s.queued = true;
        return;
      }
    }
    this.start(s);
  }

  private start(s: Slot): void {
    s.status = 'playing';
    s.queued = false;
    s.passStart = this.audio.time();
    s.passFrom = 0;
    s.cueIndex = 0;
    s.fade = null;
    if (s.render && s.render.duration > 0) {
      const repeats = s.loop !== 1;
      s.audioId = this.audio.play(s.render, repeats);
    } else {
      // nothing to play on this device: finish immediately
      s.pending.push(SIGNAL_END);
    }
  }

  private stop(obj: number): void {
    const s = this.slot(obj);
    if (!s) return;
    this.ctx.vm.setSel(obj, 'state', STATE_STOPPED);
    this.audio.stop(s.audioId);
    s.status = 'stopped';
    s.queued = false;
    s.pending = [];
    const playing = this.slots.find((x) => x.status === 'playing');
    if (playing) this.ctx.vm.setSel(playing.obj, 'state', STATE_PLAYING);
  }

  private kill(s: Slot): void {
    this.audio.stop(s.audioId);
    this.slots = this.slots.filter((x) => x !== s);
  }

  private dispose(obj: number): void {
    const s = this.slot(obj);
    if (s) {
      this.stop(obj);
      this.kill(s);
    }
    this.ctx.vm.setSel(obj, 'state', STATE_STOPPED);
  }

  private pause(value: number): void {
    const s = this.slots.find((x) => x.status === 'playing');
    if (value === 1 && s) {
      this.audio.stop(s.audioId);
      s.status = 'paused';
      s.pausedAt = this.audio.time();
      this.ctx.vm.setSel(s.obj, 'state', STATE_PAUSED);
    } else if (value === 0) {
      const p = this.slots.find((x) => x.status === 'paused' && !x.queued);
      if (p) this.start(p);
    }
  }

  private fade(obj: number): void {
    const s = this.slot(obj);
    if (!s) return;
    if (s.status !== 'playing') {
      this.ctx.vm.setSel(obj, 'signal', SIGNAL_END);
      return;
    }
    s.fade = { start: this.audio.time() };
  }

  /** Called on every kGetEvent: advances cues/loops and writes signal/state/loop selectors. */
  update(): void {
    const vm = this.ctx.vm;
    const now = this.audio.time();
    let anyPlaying = false;
    let waiting: Slot | null = null;
    for (const s of [...this.slots]) {
      if (s.queued) {
        waiting ??= s;
        continue;
      }
      if (s.status === 'playing') {
        anyPlaying = true;
        this.advance(s, now);
      }
      if (!s.pending.length && s.status !== 'playing') continue;
      if (s.pending.length) {
        const sig = s.pending.shift()!;
        vm.setSel(s.obj, 'signal', num(sig));
        if (sig === SIGNAL_END) this.stop(s.obj);
      }
      vm.setSel(s.obj, 'loop', num(s.loop));
    }
    if (!anyPlaying && waiting) this.start(waiting);
  }

  private advance(s: Slot, now: number): void {
    const r = s.render;
    if (!r) return;
    if (s.fade && now - s.fade.start > 1.5) {
      s.fade = null;
      s.pending.push(SIGNAL_END);
      this.audio.stop(s.audioId);
      s.status = 'stopped';
      return;
    }
    const passLen = r.duration - s.passFrom;
    for (let guard = 0; guard < 100; guard++) {
      const t = s.passFrom + (now - s.passStart);
      while (s.cueIndex < r.cues.length && r.cues[s.cueIndex].time <= Math.min(t, r.duration)) {
        const c = r.cues[s.cueIndex++];
        if (c.time >= s.passFrom) s.pending.push(c.value);
      }
      if (t < r.duration) return;
      // end of a pass
      s.loop = (s.loop - 1) & 0xffff;
      if (s.loop !== 0) {
        s.passStart += passLen > 0 ? passLen : r.duration;
        s.passFrom = r.loopStart;
        s.cueIndex = r.cues.findIndex((c) => c.time >= r.loopStart);
        if (s.cueIndex < 0) s.cueIndex = r.cues.length;
        if (passLen <= 0) return;
      } else {
        this.audio.stop(s.audioId);
        s.status = 'stopped';
        s.pending.push(SIGNAL_END);
        return;
      }
    }
  }

  /** Stops everything (restart/restore). */
  reset(): void {
    for (const s of this.slots) this.audio.stop(s.audioId);
    this.slots = [];
  }
}
