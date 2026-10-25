// Browser front end: loads game files, renders to a canvas, maps keys and plays sound.

import { Interpreter, Host, KeyPress } from './interpreter';
import { EGA } from './palette';
import { SAMPLE_RATE } from './sound';
import { readFat12 } from './fat12';
import type { GameFiles } from './resources';
import { isSciGame } from './sci/engine';
import { startSciGame } from './sci-host';
import { AiBackdrop } from './sci-ai';
import { AgiAiBackdrop } from './agi-ai';
import type { SciEngine } from './sci/engine';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const frame = document.createElement('canvas');
frame.width = 320;
frame.height = 200;
const fctx = frame.getContext('2d')!;
const image = fctx.createImageData(320, 200);
const pixels32 = new Uint32Array(image.data.buffer);
const PAL32 = EGA.map(([r, g, b]) => (255 << 24) | (b << 16) | (g << 8) | r);
const overlay = document.getElementById('overlay')!;
const overlayText = document.getElementById('overlay-text')!;
const fileInput = document.getElementById('files') as HTMLInputElement;

let audio: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let interp: Interpreter | null = null;
let aiBackdrop: AiBackdrop | AgiAiBackdrop | null = null;
let agiAi: AgiAiBackdrop | null = null;

function resize(): void {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  if (aiBackdrop) aiBackdrop.redraw();
  else draw();
}

function draw(): void {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
}

const host: Host = {
  present(px) {
    if (agiAi) {
      agiAi.present(px);
      return;
    }
    for (let i = 0; i < px.length; i++) pixels32[i] = PAL32[px[i] & 15];
    fctx.putImageData(image, 0, 0);
    draw();
  },
  playSound(pcm) {
    if (!audio) return;
    host.stopSound();
    const buf = audio.createBuffer(1, pcm.length, SAMPLE_RATE);
    buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    source = audio.createBufferSource();
    source.buffer = buf;
    source.connect(audio.destination);
    source.start();
  },
  stopSound() {
    try {
      source?.stop();
    } catch {
      /* already stopped */
    }
    source = null;
  },
  shake(times) {
    canvas.animate(
      Array.from({ length: times * 2 + 1 }, (_, i) => ({
        transform: i === times * 2 ? 'none' : `translate(${i % 2 ? -8 : 8}px, ${i % 2 ? 4 : -4}px)`,
      })),
      { duration: times * 80 },
    );
  },
  load(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  save(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      alert('Could not save: browser storage is unavailable.');
    }
  },
  quit() {
    showOverlay('The game has ended. Reload the page to play again.', false);
  },
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// ---------------------------------------------------------------- keyboard

const ALT_SCAN: Record<string, number> = {
  Q: 16, W: 17, E: 18, R: 19, T: 20, Y: 21, U: 22, I: 23, O: 24, P: 25, A: 30, S: 31, D: 32,
  F: 33, G: 34, H: 35, J: 36, K: 37, L: 38, Z: 44, X: 45, C: 46, V: 47, B: 48, N: 49, M: 50,
};
const SPECIAL: Record<string, KeyPress> = {
  ArrowUp: { ascii: 0, scan: 72 }, ArrowDown: { ascii: 0, scan: 80 },
  ArrowLeft: { ascii: 0, scan: 75 }, ArrowRight: { ascii: 0, scan: 77 },
  Home: { ascii: 0, scan: 71 }, PageUp: { ascii: 0, scan: 73 }, End: { ascii: 0, scan: 79 },
  PageDown: { ascii: 0, scan: 81 }, Clear: { ascii: 0, scan: 76 },
  Enter: { ascii: 13, scan: 28 }, Escape: { ascii: 27, scan: 1 }, Backspace: { ascii: 8, scan: 14 },
  Tab: { ascii: 9, scan: 15 },
};
const NUMPAD: Record<string, number> = {
  Numpad8: 72, Numpad2: 80, Numpad4: 75, Numpad6: 77, Numpad7: 71, Numpad9: 73, Numpad1: 79, Numpad3: 81, Numpad5: 76,
};

function toKey(e: KeyboardEvent): KeyPress | null {
  if (e.metaKey) return null;
  if (e.code in NUMPAD) return { ascii: 0, scan: NUMPAD[e.code] };
  const f = /^F(\d+)$/.exec(e.key);
  if (f && Number(f[1]) <= 10) return { ascii: 0, scan: 58 + Number(f[1]) };
  if (e.key in SPECIAL) return SPECIAL[e.key];
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
  if (e.altKey && letter) return { ascii: 0, scan: ALT_SCAN[letter] };
  if (e.ctrlKey && letter) return { ascii: letter.charCodeAt(0) - 64, scan: ALT_SCAN[letter] };
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) return { ascii: e.key.charCodeAt(0) & 0x7f, scan: 0 };
  return null;
}

window.addEventListener('keydown', (e) => {
  if (!interp) return;
  const k = toKey(e);
  if (!k) return;
  e.preventDefault();
  interp.pushKey(k);
});

canvas.addEventListener('mousedown', (e) => {
  if (!interp) return;
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * 160);
  const y = Math.floor(((e.clientY - r.top) / r.height) * 200) - interp.screen.picRow * 8;
  interp.walkTo(x, y);
});

// ---------------------------------------------------------------- loading

function showOverlay(text: string, showPicker: boolean): void {
  overlay.hidden = false;
  overlayText.textContent = text;
  document.getElementById('picker')!.hidden = !showPicker;
  document.getElementById('games')!.hidden = !showPicker;
}

async function fetchBundled(dir: string): Promise<GameFiles | null> {
  const files: GameFiles = new Map();
  const get = async (name: string) => {
    const r = await fetch(`${dir}/${name}`);
    if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) return null;
    return new Uint8Array(await r.arrayBuffer());
  };
  // SCI games: RESOURCE.MAP + RESOURCE.00n
  const map = await get('RESOURCE.MAP');
  if (map) {
    files.set('RESOURCE.MAP', map);
    for (let i = 1; i < 16; i++) {
      const d = await get(`RESOURCE.${String(i).padStart(3, '0')}`);
      if (!d) break;
      files.set(`RESOURCE.${String(i).padStart(3, '0')}`, d);
    }
    return files;
  }
  for (const name of ['LOGDIR', 'PICDIR', 'VIEWDIR', 'SNDDIR', 'OBJECT', 'WORDS.TOK']) {
    const d = await get(name);
    if (!d) return null;
    files.set(name, d);
  }
  for (let i = 0; i < 16; i++) {
    const d = await get(`VOL.${i}`);
    if (d && d[0] === 0x12 && d[1] === 0x34) files.set(`VOL.${i}`, d);
  }
  return files;
}

async function filesFromUpload(list: FileList): Promise<GameFiles> {
  const files: GameFiles = new Map();
  for (const f of Array.from(list)) {
    const data = new Uint8Array(await f.arrayBuffer());
    const name = f.name.toUpperCase();
    // Raw floppy images: pull the files out of the FAT12 file system.
    if (/\.(IMA|IMG|DSK)$/.test(name) || (data.length % 512 === 0 && data.length >= 163840 && !name.startsWith('VOL'))) {
      const inner = readFat12(data);
      if (inner) {
        for (const [k, v] of inner) if (!files.has(k)) files.set(k, v);
        continue;
      }
    }
    files.set(name, data);
  }
  return files;
}

async function startGame(files: GameFiles, gameId = 'custom', aiDir?: string): Promise<void> {
  if (isSciGame(files)) {
    let engine: SciEngine | undefined;
    let present = (px: Uint8Array) => host.present(px);
    if (aiDir) {
      const ai = new AiBackdrop(aiDir, canvas, () => engine);
      const n = await ai.load();
      console.log(`AI images: ${n} repainted pictures`);
      aiBackdrop = ai;
      present = (px) => ai.present(px);
    }
    overlay.hidden = true;
    engine = startSciGame(files, gameId, canvas, present, (msg) => showOverlay(msg, false));
    return;
  }
  const missing = ['LOGDIR', 'PICDIR', 'VIEWDIR', 'SNDDIR', 'OBJECT', 'WORDS.TOK', 'VOL.0'].filter((n) => !files.has(n));
  if (missing.length) {
    showOverlay(`Missing game files: ${missing.join(', ')}. This player supports AGI v2 games (separate LOGDIR/PICDIR/VIEWDIR/SNDDIR files).`, true);
    return;
  }
  if (aiDir) {
    agiAi = new AgiAiBackdrop(aiDir, canvas, () => interp);
    aiBackdrop = agiAi;
    console.log(`AI images: ${await agiAi.load()} repaints`);
  }
  overlay.hidden = true;
  audio ??= new AudioContext();
  void audio.resume();
  const v = new URLSearchParams(location.search).get('version');
  interp = new Interpreter(files, host, { gameId, version: v ? Number.parseInt(v, 16) : undefined });
  console.log(`AGI interpreter version ${interp.version.toString(16)}`);
  (window as unknown as { agi: Interpreter }).agi = interp;
  interp.run().catch((err) => {
    console.error(err);
    showOverlay(`The interpreter crashed: ${err.message}`, false);
  });
}

fileInput.addEventListener('change', async () => {
  if (fileInput.files?.length) startGame(await filesFromUpload(fileInput.files));
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!interp && e.dataTransfer?.files.length) startGame(await filesFromUpload(e.dataTransfer.files));
});

window.addEventListener('resize', resize);
resize();

function gameButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

(async () => {
  let games: { id: string; title: string; dir?: string; ai?: boolean }[] = [];
  try {
    const r = await fetch('games/games.json');
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) games = await r.json();
  } catch {
    /* no bundled games */
  }
  const list = document.getElementById('games')!;
  for (const g of games) {
    list.append(
      gameButton(g.title, async () => {
        overlayText.textContent = 'Loading…';
        list.hidden = true;
        const dir = g.dir ?? g.id;
        const files = await fetchBundled(`games/${dir}`);
        // Variants of a game share its saved games.
        if (files) await startGame(files, dir, g.ai ? `games/${dir}/ai` : undefined);
        else showOverlay(`Could not load the files in public/games/${dir}.`, true);
      }),
    );
  }
  const wanted = new URLSearchParams(location.search).get('game');
  const auto = games.find((g) => g.id === wanted);
  if (auto) {
    (list.querySelector(`button:nth-child(${games.indexOf(auto) + 1})`) as HTMLButtonElement).click();
    return;
  }
  showOverlay(
    games.length
      ? 'Pick a game. You can also load your own AGI files or drop the original .ima floppy images on this page.'
      : 'Choose your game files (AGI: LOGDIR, VOL.* ...; SCI0: RESOURCE.*), or drop them (or the original .ima floppy images) anywhere on this page. Files stay on your computer.',
    true,
  );
})();
