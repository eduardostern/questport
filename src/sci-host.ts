// Browser host for the SCI0 engine: Web Audio, localStorage, keyboard and mouse.

import { SciEngine, SciEngineHost } from './sci/engine';
import type { SciAudioHost } from './sci/kernel/sound';
import type { SciSoundRender } from './sci/sound';
import type { GameFiles } from './resources';

const ALT_SCAN: Record<string, number> = {
  Q: 16, W: 17, E: 18, R: 19, T: 20, Y: 21, U: 22, I: 23, O: 24, P: 25, A: 30, S: 31, D: 32,
  F: 33, G: 34, H: 35, J: 36, K: 37, L: 38, Z: 44, X: 45, C: 46, V: 47, B: 48, N: 49, M: 50,
};
const SPECIAL: Record<string, number> = {
  ArrowUp: 72 << 8, ArrowDown: 80 << 8, ArrowLeft: 75 << 8, ArrowRight: 77 << 8,
  Home: 71 << 8, PageUp: 73 << 8, End: 79 << 8, PageDown: 81 << 8, Clear: 76 << 8,
  Insert: 82 << 8, Delete: 83 << 8, Enter: 13, Escape: 27, Backspace: 8, Tab: 9,
};
const NUMPAD: Record<string, number> = {
  Numpad8: 72 << 8, Numpad2: 80 << 8, Numpad4: 75 << 8, Numpad6: 77 << 8, Numpad7: 71 << 8,
  Numpad9: 73 << 8, Numpad1: 79 << 8, Numpad3: 81 << 8, Numpad5: 76 << 8,
};

function modifiers(e: KeyboardEvent | MouseEvent): number {
  return (e.shiftKey ? 3 : 0) | (e.ctrlKey ? 4 : 0) | (e.altKey ? 8 : 0);
}

/** Maps a browser key to an SCI key message (ASCII, or scancode << 8). */
function sciKey(e: KeyboardEvent): number | null {
  if (e.metaKey) return null;
  if (e.code in NUMPAD) return NUMPAD[e.code];
  const f = /^F(\d+)$/.exec(e.key);
  if (f && Number(f[1]) <= 10) return (58 + Number(f[1]) + (e.shiftKey ? 25 : 0)) << 8;
  if (e.key === 'Tab' && e.shiftKey) return 15 << 8;
  if (e.key in SPECIAL) return SPECIAL[e.key];
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
  if (e.altKey && letter) return ALT_SCAN[letter] << 8;
  if (e.ctrlKey && letter) return letter.charCodeAt(0) - 64;
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) return e.key.charCodeAt(0) & 0xff;
  return null;
}

class WebAudioHost implements SciAudioHost {
  private sources = new Map<number, AudioBufferSourceNode>();
  private gain: GainNode;
  private next = 1;
  constructor(private ac: AudioContext) {
    this.gain = ac.createGain();
    this.gain.connect(ac.destination);
  }
  play(r: SciSoundRender, loop: boolean): number {
    const buf = this.ac.createBuffer(1, Math.max(1, r.pcm.length), r.sampleRate);
    buf.copyToChannel(r.pcm as Float32Array<ArrayBuffer>, 0);
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    if (loop) {
      src.loop = true;
      src.loopStart = r.loopStart;
      src.loopEnd = r.duration;
    }
    src.connect(this.gain);
    src.start();
    const id = this.next++;
    this.sources.set(id, src);
    src.onended = () => this.sources.delete(id);
    return id;
  }
  stop(id: number): void {
    const s = this.sources.get(id);
    if (!s) return;
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
    this.sources.delete(id);
  }
  setVolume(v: number): void {
    this.gain.gain.value = v;
  }
  time(): number {
    return this.ac.currentTime;
  }
}

export function startSciGame(
  files: GameFiles,
  gameId: string,
  canvas: HTMLCanvasElement,
  present: (px: Uint8Array) => void,
  onStop: (msg: string) => void,
): SciEngine {
  const ac = new AudioContext();
  void ac.resume();
  const host: SciEngineHost = {
    now: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    present,
    audio: new WebAudioHost(ac),
    storage: {
      get: (k) => {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => localStorage.setItem(k, v),
    },
    stopped: onStop,
  };
  const engine = new SciEngine(files, host, gameId);
  (window as unknown as { sci: SciEngine }).sci = engine;

  window.addEventListener('keydown', (e) => {
    const k = sciKey(e);
    if (k === null) return;
    e.preventDefault();
    engine.pushKey(k, modifiers(e));
  });
  const toScreen = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(319, Math.floor(((e.clientX - r.left) / r.width) * 320))),
      y: Math.max(0, Math.min(199, Math.floor(((e.clientY - r.top) / r.height) * 200))),
    };
  };
  canvas.style.cursor = 'none';
  canvas.addEventListener('mousemove', (e) => {
    const p = toScreen(e);
    engine.moveMouse(p.x, p.y);
  });
  canvas.addEventListener('mousedown', (e) => {
    const p = toScreen(e);
    engine.moveMouse(p.x, p.y);
    engine.pushMouse(true, p.x, p.y, modifiers(e) | (e.button === 2 ? 3 : 0));
  });
  canvas.addEventListener('mouseup', (e) => {
    const p = toScreen(e);
    engine.pushMouse(false, p.x, p.y, modifiers(e));
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  void engine.run();
  return engine;
}
