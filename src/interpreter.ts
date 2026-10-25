// The AGI virtual machine: game state, the main cycle, object motion/animation and all logic commands.

import { ResourceManager, GameFiles } from './resources';
import { PictureBuffer, drawPicture, PIC_W, PIC_H } from './picture';
import { decodeView, View, Cel } from './view';
import { decodeLogic, Logic, TEST_OPS, ACTION_OPS, applyVersionQuirks, detectVersion } from './logic';
import { Dictionary, ParsedWord, UNKNOWN_WORD } from './words';
import { decodeObjects } from './objects';
import { renderSound, SAMPLE_RATE } from './sound';
import { Screen, wrapText, TextWindow } from './screen';

export interface KeyPress {
  ascii: number;
  scan: number;
}

export interface Host {
  present(pixels: Uint8Array): void;
  playSound(pcm: Float32Array): void;
  stopSound(): void;
  shake(times: number): void;
  load(key: string): string | null;
  save(key: string, value: string): void;
  quit(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

// Screen object flags
const ANIMATED = 0x1;
const DRAWN = 0x2;
const UPDATE = 0x4;
const CYCLING = 0x8;
const FIX_LOOP = 0x10;
const FIXED_PRI = 0x20;
const IGNORE_BLOCKS = 0x40;
const IGNORE_HORIZON = 0x80;
const IGNORE_OBJS = 0x100;
const ON_WATER = 0x200;
const ON_LAND = 0x400;
const UPDATE_POS = 0x800;
const DIDNT_MOVE = 0x1000;

const enum Motion {
  Normal,
  Wander,
  Follow,
  MoveTo,
  EgoWalk, // click-to-walk (not part of original AGI)
}
const enum CycleType {
  Normal,
  EndOfLoop,
  RevLoop,
  Reverse,
}

// Well-known variables and flags
const V_ROOM = 0, V_PREV_ROOM = 1, V_EGO_BORDER = 2, V_SCORE = 3, V_BORDER_OBJ = 4, V_BORDER_CODE = 5;
const V_EGO_DIR = 6, V_MAX_SCORE = 7, V_FREE_MEM = 8, V_UNKNOWN_WORD = 9, V_CYCLE_DELAY = 10;
const V_SECONDS = 11, V_MINUTES = 12, V_HOURS = 13, V_DAYS = 14, V_EGO_VIEW = 16, V_KEY = 19;
const V_COMPUTER = 20, V_WINDOW_TIMER = 21, V_SOUND_TYPE = 22, V_INPUT_LEN = 24, V_INV_SELECT = 25, V_MONITOR = 26;
const F_EGO_WATER = 0, F_EGO_TRIGGER = 3, F_ENTERED = 2, F_SAID_OK = 4, F_NEW_ROOM = 5, F_RESTART = 6;
const F_SOUND = 9, F_LOGIC0_FIRST = 11, F_RESTORED = 12, F_INV_SELECT = 13, F_MENU = 14, F_NONBLOCK_PRINT = 15;

const DX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
const DY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
const LOOP_TABLE_2 = [4, 4, 0, 0, 0, 4, 1, 1, 1];
const LOOP_TABLE_4 = [4, 3, 0, 0, 0, 2, 1, 1, 1];

// PC scan codes for arrows / keypad -> AGI direction
const DIR_KEYS: Record<number, number> = { 72: 1, 73: 2, 77: 3, 81: 4, 80: 5, 79: 6, 75: 7, 71: 8, 76: 0 };

class ScreenObj {
  flags = 0;
  x = 0;
  y = 0;
  prevX = 0;
  prevY = 0;
  viewNum = 0;
  view: View | null = null;
  loop = 0;
  cel = 0;
  width = 0;
  height = 0;
  stepTime = 1;
  stepTimeCount = 1;
  stepSize = 1;
  cycleTime = 1;
  cycleTimeCount = 1;
  direction = 0;
  motion = Motion.Normal;
  cycle = CycleType.Normal;
  priority = 0;
  moveX = 0;
  moveY = 0;
  moveStepSize = 0;
  moveFlag = 0;
  followStepSize = 0;
  followFlag = 0;
  followCount = 0;
  wanderCount = 0;
  loopFlag = 0;

  constructor(public num: number) {}

  get celData(): Cel | null {
    return this.view?.loops[this.loop]?.cels[this.cel] ?? null;
  }
  get loopCount(): number {
    return this.view?.loops.length ?? 0;
  }
  get celCount(): number {
    return this.view?.loops[this.loop]?.cels.length ?? 0;
  }

  serialize(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const [k, v] of Object.entries(this)) if (typeof v === 'number') o[k] = v;
    return o;
  }
}

type ScriptEntry = [string, ...number[]];

interface Menu {
  name: string;
  col: number;
  items: { text: string; controller: number; enabled: boolean }[];
}

export interface InterpreterOptions {
  version?: number; // hex interpreter version, e.g. 0x2917; detected when omitted
  gameId?: string; // used to keep save games apart
}

const priorityFromY = (y: number) => (y < 48 ? 4 : Math.min(15, Math.floor(y / 12) + 1));
const priorityToY = (p: number) => (p - 5) * 12 + 48;

export class Interpreter {
  readonly res: ResourceManager;
  readonly dict: Dictionary;
  readonly screen = new Screen();
  private itemNames: string[];
  private itemStartRooms: number[];
  readonly version: number;
  private gameId: string;
  private menus: Menu[] = [];
  private menuPending = false;

  // Game state
  vars = new Uint8Array(256);
  flags = new Uint8Array(256);
  strings: string[] = new Array(24).fill('');
  itemRooms: number[] = [];
  objs: ScreenObj[] = [];
  private logics = new Map<number, Logic>();
  private scanStart = new Map<number, number>(); // set.scan.start entry points
  private views = new Map<number, View>();
  private pics = new Map<number, Uint8Array>();
  private soundCache = new Map<number, Float32Array>();
  pic = new PictureBuffer();
  private picShown = false;
  private frameVis = new Uint8Array(PIC_W * PIC_H);
  private framePri = new Uint8Array(PIC_W * PIC_H);
  // What drew each picture pixel, for the AI images mode: 0 = room picture, > 0 = cel placement, -1 = other.
  private picOwner = new Int32Array(PIC_W * PIC_H);
  private frameOwner = new Int32Array(PIC_W * PIC_H);
  /** Cels drawn on screen (screen coordinates of their top-left corner, double-wide pixels). */
  readonly placements = new Map<number, { view: number; loop: number; cel: number; left: number; top: number }>();
  private placementKeys = new Map<string, number>();
  private nextPlacement = 1;
  /** The last room picture drawn with draw.pic, as drawn (before overlays and added views). */
  basePicture: { nr: number; vis: Uint8Array } | null = null;
  private showObjCel: Cel | null = null;
  private nonBlockingWindow: TextWindow | null = null;
  private horizon = 36;
  private block = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
  playerControl = true;
  private keymap: { code: number; controller: number }[] = [];
  private controllers = new Uint8Array(256);
  private egoWords: ParsedWord[] = [];
  private acceptInput = false;
  inputText = '';
  private lastInput = '';
  private cursorChar = '_';
  private textFg = 15;
  private textBg = 0;
  private statusLineOn = false;
  private inputRow = 22;
  private statusRow = 0;
  private scriptBuffer: ScriptEntry[] = [];
  private exitAll = false;
  private restartRequested = false;
  quitRequested = false;
  private sound: { flag: number; end: number } | null = null;
  private keyQueue: KeyPress[] = [];
  private keyWaiter: ((k: KeyPress) => void) | null = null;
  private haveKey = false;
  private clockLast = 0;
  private clockAcc = 0;
  private rand = Math.random;
  trace = false;
  cycleCount = 0;

  constructor(files: GameFiles, private host: Host, opts: InterpreterOptions = {}) {
    this.res = new ResourceManager(files);
    if (opts.version) {
      this.version = opts.version;
      applyVersionQuirks(opts.version);
    } else {
      const all: Logic[] = [];
      for (let i = 0; i < this.res.count('logic'); i++) {
        if (this.res.exists('logic', i)) all.push(decodeLogic(this.res.load('logic', i)));
      }
      this.version = detectVersion(all);
    }
    this.gameId = opts.gameId ?? 'game';
    this.dict = new Dictionary(this.res.file('WORDS.TOK'));
    const o = decodeObjects(this.res.file('OBJECT'));
    this.itemNames = o.items.map((i) => i.name);
    this.itemStartRooms = o.items.map((i) => i.room);
    this.reset();
  }

  // ---------------------------------------------------------------- setup

  private reset(restart = false): void {
    const soundOn = this.flags[F_SOUND];
    this.vars.fill(0);
    this.flags.fill(0);
    this.strings.fill('');
    this.itemRooms = [...this.itemStartRooms];
    this.objs = [];
    for (let i = 0; i < 256; i++) this.objs.push(new ScreenObj(i));
    this.logics.clear();
    this.scanStart.clear();
    this.views.clear();
    this.pics.clear();
    this.pic.clear();
    this.picShown = false;
    this.frameVis.fill(0);
    this.horizon = 36;
    this.block.active = false;
    this.playerControl = true;
    this.keymap = [];
    this.controllers.fill(0);
    this.egoWords = [];
    this.acceptInput = false;
    this.inputText = '';
    this.lastInput = '';
    this.cursorChar = '_';
    this.textFg = 15;
    this.textBg = 0;
    this.statusLineOn = false;
    this.screen.picRow = 1;
    this.inputRow = 22;
    this.statusRow = 0;
    this.screen.textMode = false;
    this.screen.window = null;
    this.screen.modal = null;
    this.screen.resetTextLayer();
    this.scriptBuffer = [];
    this.menus = [];
    this.menuPending = false;
    this.stopSound();
    this.vars[V_COMPUTER] = 0;
    this.vars[V_SOUND_TYPE] = 3;
    this.vars[V_MONITOR] = 3;
    this.vars[V_INPUT_LEN] = 41;
    this.vars[V_FREE_MEM] = 255;
    this.flags[F_SOUND] = restart ? soundOn : 1;
    this.flags[F_LOGIC0_FIRST] = 1;
    this.flags[F_NEW_ROOM] = 1; // the interpreter "enters" room 0 at startup
    if (restart) this.flags[F_RESTART] = 1;
    this.restartRequested = false;
    this.exitAll = false;
  }

  // ---------------------------------------------------------------- input from host

  pushKey(k: KeyPress): void {
    if (this.keyWaiter) {
      const w = this.keyWaiter;
      this.keyWaiter = null;
      w(k);
    } else if (this.keyQueue.length < 32) {
      this.keyQueue.push(k);
    }
  }

  get waitingForKey(): boolean {
    return this.keyWaiter !== null;
  }

  /** Waits for a key. flush discards keys typed before the wait began (used when a new window opens). */
  private waitKey(timeoutMs = 0, flush = true): Promise<KeyPress | null> {
    if (flush) this.keyQueue.length = 0;
    else if (this.keyQueue.length) return Promise.resolve(this.keyQueue.shift()!);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.keyWaiter = (k) => {
        if (timer) clearTimeout(timer);
        resolve(k);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.keyWaiter = null;
          resolve(null);
        }, timeoutMs);
      }
    });
  }

  // ---------------------------------------------------------------- resources

  private getLogic(n: number): Logic {
    let l = this.logics.get(n);
    if (!l) {
      l = decodeLogic(this.res.load('logic', n));
      this.logics.set(n, l);
    }
    return l;
  }

  private getView(n: number): View {
    let v = this.views.get(n);
    if (!v) {
      v = decodeView(this.res.load('view', n));
      this.views.set(n, v);
    }
    return v;
  }

  private getPic(n: number): Uint8Array {
    let p = this.pics.get(n);
    if (!p) {
      p = this.res.load('picture', n);
      this.pics.set(n, p);
    }
    return p;
  }

  // ---------------------------------------------------------------- main loop

  async run(): Promise<void> {
    let next = this.host.now();
    this.clockLast = next;
    while (!this.quitRequested) {
      const delay = Math.max(1, this.vars[V_CYCLE_DELAY]) * 50;
      next += delay;
      const now = this.host.now();
      if (next < now - 500) next = now; // fell behind (e.g. waiting on a dialog)
      if (next > now) await this.host.sleep(next - now);
      await this.cycle();
      if (this.restartRequested) {
        this.reset(true);
      }
    }
  }

  async cycle(): Promise<void> {
    this.cycleCount++;
    this.updateClock();
    this.checkSound();
    if (this.menuPending) {
      this.menuPending = false;
      await this.runMenu();
    }
    this.processKeys();

    const ego = this.objs[0];
    if (!this.playerControl) this.vars[V_EGO_DIR] = ego.direction;
    else ego.direction = this.vars[V_EGO_DIR];
    this.checkAllMotions();

    const oldScore = this.vars[V_SCORE];
    const oldSound = this.flags[F_SOUND];
    this.exitAll = false;
    while (!(await this.runLogic(0))) {
      if (this.quitRequested || this.restartRequested) return;
      this.vars[V_UNKNOWN_WORD] = 0;
      this.vars[V_BORDER_OBJ] = 0;
      this.vars[V_BORDER_CODE] = 0;
      this.flags[F_ENTERED] = 0;
      this.exitAll = false;
      this.controllers.fill(0);
    }
    this.controllers.fill(0);
    ego.direction = this.vars[V_EGO_DIR];
    if (this.vars[V_SCORE] !== oldScore || this.flags[F_SOUND] !== oldSound) this.drawStatus();
    if (!this.flags[F_SOUND] && this.sound) this.stopSound();
    this.vars[V_BORDER_OBJ] = 0;
    this.vars[V_BORDER_CODE] = 0;
    this.flags[F_NEW_ROOM] = 0;
    this.flags[F_RESTART] = 0;
    this.flags[F_RESTORED] = 0;
    this.updateObjects();
    this.flags[F_ENTERED] = 0;
    this.flags[F_SAID_OK] = 0;
    this.render();
  }

  private updateClock(): void {
    const now = this.host.now();
    this.clockAcc += now - this.clockLast;
    this.clockLast = now;
    while (this.clockAcc >= 1000) {
      this.clockAcc -= 1000;
      if (++this.vars[V_SECONDS] >= 60) {
        this.vars[V_SECONDS] = 0;
        if (++this.vars[V_MINUTES] >= 60) {
          this.vars[V_MINUTES] = 0;
          if (++this.vars[V_HOURS] >= 24) {
            this.vars[V_HOURS] = 0;
            this.vars[V_DAYS]++;
          }
        }
      }
    }
  }

  private processKeys(): void {
    this.vars[V_KEY] = 0;
    this.haveKey = false; // have.key only sees keys pressed during this cycle
    while (this.keyQueue.length) {
      const k = this.keyQueue.shift()!;
      this.haveKey = true;
      const code = k.ascii || k.scan << 8;
      const m = this.keymap.find((e) => e.code === code);
      if (m) {
        this.controllers[m.controller] = 1;
        continue;
      }
      if (k.ascii === 0 && k.scan in DIR_KEYS) {
        if (this.playerControl) {
          const d = DIR_KEYS[k.scan];
          if (this.objs[0].motion === Motion.EgoWalk) {
            this.objs[0].motion = Motion.Normal;
            this.objs[0].stepSize = this.objs[0].moveStepSize;
          }
          this.vars[V_EGO_DIR] = this.vars[V_EGO_DIR] === d ? 0 : d;
        }
        continue;
      }
      // A message shown without waiting (flag 15) stays until the script closes it; Enter or Esc also
      // dismisses it when no command is being typed, so it can't get stuck on screen.
      if ((k.ascii === 13 || k.ascii === 27) && !this.inputText && this.screen.window && this.screen.window === this.nonBlockingWindow) {
        this.screen.window = null;
        this.nonBlockingWindow = null;
        this.render();
        continue;
      }
      this.vars[V_KEY] = k.ascii;
      if (!this.acceptInput) continue;
      if (k.ascii === 8) {
        this.inputText = this.inputText.slice(0, -1);
        this.drawPrompt();
      } else if (k.ascii === 13) {
        if (this.inputText.trim()) {
          this.lastInput = this.inputText;
          this.parseInput(this.inputText);
          this.inputText = '';
          this.drawPrompt();
          break; // handle one command per cycle
        }
      } else if (k.ascii >= 32 && k.ascii < 127) {
        const max = Math.min(this.vars[V_INPUT_LEN] || 40, 39 - this.strings[0].length);
        if (this.inputText.length < max) {
          this.inputText += String.fromCharCode(k.ascii);
          this.drawPrompt();
        }
      }
    }
  }

  private parseInput(text: string): void {
    const { words, unknownAt } = this.dict.parse(text);
    this.egoWords = words;
    this.vars[V_UNKNOWN_WORD] = unknownAt;
    if (words.length) {
      this.flags[F_ENTERED] = 1;
      this.flags[F_SAID_OK] = 0;
    }
  }

  // ---------------------------------------------------------------- logic execution

  private async runLogic(n: number): Promise<boolean> {
    const logic = this.getLogic(n);
    const c = logic.code;
    let p = this.scanStart.get(n) ?? 0;
    while (p < c.length) {
      const op = c[p++];
      if (op === 0xff) {
        const r = this.evalConditions(c, p);
        p = r.p;
        const size = c[p] | (c[p + 1] << 8);
        p += 2;
        if (!r.result) p += size;
      } else if (op === 0xfe) {
        const off = ((c[p] | (c[p + 1] << 8)) << 16) >> 16;
        p += 2 + off;
      } else if (op === 0) {
        return true;
      } else {
        const info = ACTION_OPS[op];
        if (!info) throw new Error(`Unknown action ${op} in logic ${n} at ${p - 1}`);
        const args: number[] = [];
        for (let i = 0; i < info.args.length; i++) args.push(c[p++]);
        if (this.trace) console.log(`[${n}] ${info.name}(${args.join(',')})`);
        if (op === 145) {
          this.scanStart.set(n, p); // next call starts after this command
          continue;
        }
        if (op === 146) {
          this.scanStart.delete(n);
          continue;
        }
        const r = this.action(op, args, logic);
        if (r) await r;
        if (this.exitAll) return false;
      }
    }
    return true;
  }

  private evalConditions(c: Uint8Array, p: number): { result: boolean; p: number } {
    let result = true;
    const test = (evaluate: boolean): boolean => {
      let t = c[p++];
      let not = false;
      if (t === 0xfd) {
        not = true;
        t = c[p++];
      }
      let r: boolean;
      if (t === 0x0e) {
        const n = c[p++];
        const words: number[] = [];
        for (let i = 0; i < n; i++, p += 2) words.push(c[p] | (c[p + 1] << 8));
        if (!evaluate) return false;
        r = this.said(words);
      } else {
        const info = TEST_OPS[t];
        if (!info) throw new Error(`Unknown test ${t}`);
        const args: number[] = [];
        for (let i = 0; i < info.args.length; i++) args.push(c[p++]);
        if (!evaluate) return false;
        r = this.test(t, args);
      }
      return not ? !r : r;
    };
    for (;;) {
      const b = c[p];
      if (b === 0xff) {
        p++;
        break;
      }
      if (b === 0xfc) {
        p++;
        let orResult = false;
        while (c[p] !== 0xfc) {
          if (test(result && !orResult)) orResult = true;
        }
        p++;
        if (!orResult) result = false;
      } else if (!test(result)) {
        result = false;
      }
    }
    return { result, p };
  }

  private said(words: number[]): boolean {
    if (this.flags[F_SAID_OK] || !this.flags[F_ENTERED]) return false;
    const ego = this.egoWords;
    let c = 0;
    let z = 0;
    let n = words.length;
    let i = 0;
    while (n) {
      if (c >= ego.length) return false;
      z = words[i++];
      if (z === 9999) n = 1; // rest of line
      else if (z !== 1 && ego[c].id !== z) return false; // 1 = any word
      c++;
      n--;
    }
    if (c < ego.length && z !== 9999) return false;
    this.flags[F_SAID_OK] = 1;
    return true;
  }

  private test(t: number, a: number[]): boolean {
    const v = this.vars;
    switch (t) {
      case 0x00: return false;
      case 0x01: return v[a[0]] === a[1];
      case 0x02: return v[a[0]] === v[a[1]];
      case 0x03: return v[a[0]] < a[1];
      case 0x04: return v[a[0]] < v[a[1]];
      case 0x05: return v[a[0]] > a[1];
      case 0x06: return v[a[0]] > v[a[1]];
      case 0x07: return !!this.flags[a[0]];
      case 0x08: return !!this.flags[v[a[0]]];
      case 0x09: return this.itemRooms[a[0]] === 255;
      case 0x0a: return this.itemRooms[a[0]] === v[a[1]];
      case 0x0b: {
        const o = this.objs[a[0]];
        return o.x >= a[1] && o.y >= a[2] && o.x <= a[3] && o.y <= a[4];
      }
      case 0x0c: return !!this.controllers[a[0]];
      case 0x0d: {
        const k = this.haveKey || this.keyQueue.length > 0;
        this.haveKey = false;
        this.keyQueue.length = 0;
        return k;
      }
      case 0x0f: {
        const norm = (s: string) => s.toLowerCase().replace(/[\s\t.,;:'!-]/g, '');
        return norm(this.strings[a[0]]) === norm(this.strings[a[1]]);
      }
      case 0x10: {
        const o = this.objs[a[0]];
        return o.x >= a[1] && o.y >= a[2] && o.x + o.width - 1 <= a[3] && o.y <= a[4];
      }
      case 0x11: {
        const o = this.objs[a[0]];
        const x = o.x + (o.width >> 1);
        return x >= a[1] && o.y >= a[2] && x <= a[3] && o.y <= a[4];
      }
      case 0x12: {
        const o = this.objs[a[0]];
        const x = o.x + o.width - 1;
        return x >= a[1] && o.y >= a[2] && x <= a[3] && o.y <= a[4];
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- actions

  private action(op: number, a: number[], logic: Logic): void | Promise<unknown> {
    const v = this.vars;
    const f = this.flags;
    const o = this.objs[a[0]];
    switch (op) {
      case 1: if (v[a[0]] < 255) v[a[0]]++; return;
      case 2: if (v[a[0]] > 0) v[a[0]]--; return;
      case 3: v[a[0]] = a[1]; return;
      case 4: v[a[0]] = v[a[1]]; return;
      case 5: v[a[0]] += a[1]; return;
      case 6: v[a[0]] += v[a[1]]; return;
      case 7: v[a[0]] -= a[1]; return;
      case 8: v[a[0]] -= v[a[1]]; return;
      case 9: v[v[a[0]]] = v[a[1]]; return;
      case 10: v[a[0]] = v[v[a[1]]]; return;
      case 11: v[v[a[0]]] = a[1]; return;
      case 12: f[a[0]] = 1; return;
      case 13: f[a[0]] = 0; return;
      case 14: f[a[0]] ^= 1; return;
      case 15: f[v[a[0]]] = 1; return;
      case 16: f[v[a[0]]] = 0; return;
      case 17: f[v[a[0]]] ^= 1; return;
      case 18: return this.newRoom(a[0]);
      case 19: return this.newRoom(v[a[0]]);
      case 20: this.getLogic(a[0]); return;
      case 21: this.getLogic(v[a[0]]); return;
      case 22: return this.callLogic(a[0]);
      case 23: return this.callLogic(v[a[0]]);
      case 24: this.getPic(v[a[0]]); return;
      case 25: return this.drawPic(v[a[0]], true);
      case 26: return this.showPic();
      case 27: return;
      case 28: return this.drawPic(v[a[0]], false);
      case 29: return this.showPriScreen();
      case 30: this.getView(a[0]); return;
      case 31: this.getView(v[a[0]]); return;
      case 32: return;
      case 33:
        if (!(o.flags & ANIMATED)) {
          o.flags = ANIMATED | UPDATE | CYCLING;
          o.motion = Motion.Normal;
          o.cycle = CycleType.Normal;
          o.direction = 0;
        }
        return;
      case 34:
        for (const x of this.objs) x.flags &= ~(ANIMATED | DRAWN);
        return;
      case 35: return this.drawObj(o);
      case 36: o.flags &= ~DRAWN; return;
      case 37:
        o.x = o.prevX = a[1];
        o.y = o.prevY = a[2];
        return;
      case 38:
        o.x = o.prevX = v[a[1]];
        o.y = o.prevY = v[a[2]];
        return;
      case 39: v[a[1]] = o.x; v[a[2]] = o.y; return;
      case 40: {
        const dx = (v[a[1]] << 24) >> 24;
        const dy = (v[a[2]] << 24) >> 24;
        o.flags |= UPDATE_POS;
        o.x = dx < 0 && o.x < -dx ? 0 : o.x + dx;
        o.y = dy < 0 && o.y < -dy ? 0 : o.y + dy;
        this.fixPosition(o);
        return;
      }
      case 41: return this.setView(o, a[1]);
      case 42: return this.setView(o, v[a[1]]);
      case 43: return this.setLoop(o, a[1]);
      case 44: return this.setLoop(o, v[a[1]]);
      case 45: o.flags |= FIX_LOOP; return;
      case 46: o.flags &= ~FIX_LOOP; return;
      case 47: return this.setCel(o, a[1]);
      case 48: return this.setCel(o, v[a[1]]);
      case 49: v[a[1]] = Math.max(0, o.celCount - 1); return;
      case 50: v[a[1]] = o.cel; return;
      case 51: v[a[1]] = o.loop; return;
      case 52: v[a[1]] = o.viewNum; return;
      case 53: v[a[1]] = o.loopCount; return;
      case 54: o.priority = a[1]; o.flags |= FIXED_PRI; return;
      case 55: o.priority = v[a[1]]; o.flags |= FIXED_PRI; return;
      case 56: o.flags &= ~FIXED_PRI; return;
      case 57: v[a[1]] = o.priority; return;
      case 58: o.flags &= ~UPDATE; return;
      case 59: o.flags |= UPDATE; return;
      case 60: return;
      case 61: o.flags |= IGNORE_HORIZON; return;
      case 62: o.flags &= ~IGNORE_HORIZON; return;
      case 63: this.horizon = a[0]; return;
      case 64: o.flags = (o.flags | ON_WATER) & ~ON_LAND; return;
      case 65: o.flags = (o.flags | ON_LAND) & ~ON_WATER; return;
      case 66: o.flags &= ~(ON_WATER | ON_LAND); return;
      case 67: o.flags |= IGNORE_OBJS; return;
      case 68: o.flags &= ~IGNORE_OBJS; return;
      case 69: {
        const o2 = this.objs[a[1]];
        let d = 255;
        if (o.flags & DRAWN && o2.flags & DRAWN) {
          d = Math.abs(o.x + (o.width >> 1) - (o2.x + (o2.width >> 1))) + Math.abs(o.y - o2.y);
          if (d > 254) d = 254;
        }
        v[a[2]] = d;
        return;
      }
      case 70: o.flags &= ~CYCLING; return;
      case 71: o.flags |= CYCLING; return;
      case 72: o.cycle = CycleType.Normal; o.flags |= CYCLING; return;
      case 73:
        o.cycle = CycleType.EndOfLoop;
        o.flags |= UPDATE | CYCLING;
        o.loopFlag = a[1];
        f[a[1]] = 0;
        return;
      case 74: o.cycle = CycleType.Reverse; o.flags |= CYCLING; return;
      case 75:
        o.cycle = CycleType.RevLoop;
        o.flags |= UPDATE | CYCLING;
        o.loopFlag = a[1];
        f[a[1]] = 0;
        return;
      case 76: o.cycleTime = o.cycleTimeCount = v[a[1]]; return;
      case 77:
        o.direction = 0;
        o.motion = Motion.Normal;
        if (o.num === 0) {
          v[V_EGO_DIR] = 0;
          this.playerControl = false;
        }
        return;
      case 78:
        o.motion = Motion.Normal;
        if (o.num === 0) {
          v[V_EGO_DIR] = 0;
          this.playerControl = true;
        }
        return;
      case 79: o.stepSize = v[a[1]]; return;
      case 80: o.stepTime = o.stepTimeCount = v[a[1]]; return;
      case 81: return this.moveObj(o, a[1], a[2], a[3], a[4]);
      case 82: return this.moveObj(o, v[a[1]], v[a[2]], v[a[3]], a[4]);
      case 83:
        o.motion = Motion.Follow;
        o.followStepSize = a[1] <= o.stepSize ? o.stepSize : a[1];
        o.followFlag = a[2];
        o.followCount = 255;
        f[a[2]] = 0;
        o.flags |= UPDATE;
        return;
      case 84:
        o.motion = Motion.Wander;
        o.flags |= UPDATE;
        if (o.num === 0) this.playerControl = false;
        return;
      case 85: o.motion = Motion.Normal; return;
      case 86: o.direction = v[a[1]]; return;
      case 87: v[a[1]] = o.direction; return;
      case 88: o.flags |= IGNORE_BLOCKS; return;
      case 89: o.flags &= ~IGNORE_BLOCKS; return;
      case 90: this.block = { active: true, x1: a[0], y1: a[1], x2: a[2], y2: a[3] }; return;
      case 91: this.block.active = false; return;
      case 92: this.itemRooms[a[0]] = 255; return;
      case 93: this.itemRooms[v[a[0]]] = 255; return;
      case 94: this.itemRooms[a[0]] = 0; return;
      case 95: this.itemRooms[a[0]] = v[a[1]]; return;
      case 96: this.itemRooms[v[a[0]]] = v[a[1]]; return;
      case 97: v[a[1]] = this.itemRooms[v[a[0]]] ?? 0; return;
      case 98: return;
      case 99: return this.playSound(a[0], a[1]);
      case 100: return this.stopSound();
      case 101: return this.print(this.msg(logic, a[0]));
      case 102: return this.print(this.msg(logic, v[a[0]]));
      case 103: return this.display(a[0], a[1], this.msg(logic, a[2]));
      case 104: return this.display(v[a[0]], v[a[1]], this.msg(logic, v[a[2]]));
      case 105: {
        const color = this.screen.textMode ? a[2] : a[2] ? 15 : 0;
        this.screen.clearRows(a[0], a[1], color);
        return;
      }
      case 106:
        this.screen.textMode = true;
        this.screen.textModeBg = this.textBg;
        this.screen.text.fill(this.textBg);
        this.screen.cells(this.screen.text).fill(0);
        this.screen.window = null;
        return;
      case 107:
        this.screen.textMode = false;
        this.screen.resetTextLayer();
        this.drawStatus();
        this.drawPrompt();
        return;
      case 108: this.cursorChar = (logic.messages[a[0]] ?? '_')[0] ?? '_'; return;
      case 109: this.textFg = a[0]; this.textBg = a[1]; return;
      case 110: return this.shake(a[0]);
      case 111:
        this.screen.picRow = a[0];
        this.inputRow = a[1];
        this.statusRow = a[2];
        this.screen.resetTextLayer();
        return;
      case 112: this.statusLineOn = true; this.drawStatus(); return;
      case 113:
        this.statusLineOn = false;
        this.screen.clearRows(this.statusRow, this.statusRow, 0);
        return;
      case 114: this.strings[a[0]] = logic.messages[a[1]] ?? ''; return;
      case 115: return this.getString(a[0], this.msg(logic, a[1]), a[2], a[3], a[4]);
      case 116: this.strings[a[0]] = this.egoWords[a[1] - 1]?.word ?? ''; return;
      case 117: this.parseInput(this.strings[a[0]]); return;
      case 118: return this.getNum(this.msg(logic, a[0]), a[1]);
      case 119:
        this.acceptInput = false;
        this.screen.clearRows(this.inputRow, this.inputRow, 0);
        return;
      case 120: this.acceptInput = true; this.drawPrompt(); return;
      case 121: this.keymap.push({ code: a[0] | (a[1] << 8), controller: a[2] }); return;
      case 122: return this.addToPic(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
      case 123: return this.addToPic(v[a[0]], v[a[1]], v[a[2]], v[a[3]], v[a[4]], v[a[5]], v[a[6]]);
      case 124: return this.inventory();
      case 125: return this.saveGame();
      case 126: return this.restoreGame();
      case 127: return;
      case 128: return this.restartGame();
      case 129: return this.showObj(a[0]);
      case 130: v[a[2]] = a[0] + Math.floor(this.rand() * (a[1] - a[0] + 1)); return;
      case 131: this.playerControl = false; return;
      case 132:
        this.playerControl = true;
        this.objs[0].motion = Motion.Normal;
        return;
      case 133: {
        const s = this.objs[v[a[0]]];
        return this.print(`Object ${s.num}: x=${s.x} y=${s.y} pri=${s.priority} view=${s.viewNum} loop=${s.loop} cel=${s.cel} step=${s.stepSize}`);
      }
      case 134: return this.quit(this.version > 0x2089 ? a[0] : 1);
      case 135: return this.print('Memory: plenty (this is a web browser).');
      case 136: return this.print('      Game paused.\nPress Enter to continue.');
      case 137:
        if (this.lastInput.length > this.inputText.length) {
          this.inputText = this.lastInput;
          this.drawPrompt();
        }
        return;
      case 138: this.inputText = ''; this.drawPrompt(); return;
      case 139: case 140: return;
      case 141: return this.print('Adventure Game Interpreter\n      Version 2.089\n\n  (web reimplementation)');
      case 142: case 143: case 144: case 145: case 146: return;
      case 147:
        o.x = a[1];
        o.y = a[2];
        o.flags |= UPDATE_POS;
        this.fixPosition(o);
        return;
      case 148:
        o.x = v[a[1]];
        o.y = v[a[2]];
        o.flags |= UPDATE_POS;
        this.fixPosition(o);
        return;
      case 149: case 150: return;
      case 151: return this.print(this.msg(logic, a[0]), a[1], a[2], a[3]);
      case 152: return this.print(this.msg(logic, v[a[0]]), a[1], a[2], a[3]);
      case 153: return;
      case 154: {
        const color = this.screen.textMode ? a[4] : a[4] ? 15 : 0;
        this.screen.clearRect(a[0], a[1], a[2], a[3], color);
        return;
      }
      case 155: return;
      case 156:
        this.menus.push({
          name: logic.messages[a[0]] ?? '',
          col: this.menus.reduce((c, m) => c + m.name.length + 1, 1),
          items: [],
        });
        return;
      case 157:
        this.menus[this.menus.length - 1]?.items.push({ text: logic.messages[a[0]] ?? '', controller: a[1], enabled: true });
        return;
      case 158: return;
      case 159: case 160:
        for (const m of this.menus) for (const it of m.items) if (it.controller === a[0]) it.enabled = op === 159;
        return;
      case 161:
        if (this.flags[F_MENU] && this.menus.length) this.menuPending = true;
        return;
      case 162: return this.showObj(v[a[0]]);
      case 163: case 164: return;
      case 165: v[a[0]] *= a[1]; return;
      case 166: v[a[0]] *= v[a[1]]; return;
      case 167: if (a[1]) v[a[0]] = Math.floor(v[a[0]] / a[1]); return;
      case 168: if (v[a[1]]) v[a[0]] = Math.floor(v[a[0]] / v[a[1]]); return;
      case 169: this.screen.window = null; this.render(); return;
    }
    console.warn(`Unimplemented action ${ACTION_OPS[op]?.name ?? op}`);
  }

  private async callLogic(n: number): Promise<void> {
    await this.runLogic(n);
  }

  // ---------------------------------------------------------------- rooms

  private newRoom(n: number): void {
    for (const o of this.objs) {
      o.flags &= ~(ANIMATED | DRAWN);
      o.flags |= UPDATE;
      o.stepTime = o.stepTimeCount = 1;
      o.cycleTime = o.cycleTimeCount = 1;
      o.stepSize = 1;
    }
    this.scriptBuffer = [];
    for (const k of [...this.scanStart.keys()]) if (k !== 0) this.scanStart.delete(k);
    this.playerControl = true;
    this.block.active = false;
    this.horizon = 36;
    this.vars[V_PREV_ROOM] = this.vars[V_ROOM];
    this.vars[V_ROOM] = n;
    this.vars[V_BORDER_OBJ] = 0;
    this.vars[V_BORDER_CODE] = 0;
    this.vars[V_UNKNOWN_WORD] = 0;
    this.vars[V_EGO_VIEW] = this.objs[0].viewNum;
    this.getLogic(n);
    const ego = this.objs[0];
    switch (this.vars[V_EGO_BORDER]) {
      case 1: ego.y = PIC_H - 1; break;
      case 2: ego.x = 0; break;
      case 3: ego.y = this.horizon + 1; break;
      case 4: ego.x = PIC_W - ego.width; break;
    }
    this.vars[V_EGO_BORDER] = 0;
    this.flags[F_NEW_ROOM] = 1;
    this.flags[F_ENTERED] = 0;
    this.keyQueue.length = 0;
    this.screen.window = null;
    this.exitAll = true;
    this.drawStatus();
    this.drawPrompt();
  }

  // ---------------------------------------------------------------- pictures

  private drawPic(n: number, clear: boolean): void {
    const before = clear ? null : this.pic.vis.slice();
    drawPicture(this.getPic(n), this.pic, clear);
    if (clear) {
      this.picOwner.fill(0);
      this.basePicture = { nr: n, vis: this.pic.vis.slice() };
      this.placements.clear();
      this.placementKeys.clear();
    } else {
      // Overlay pictures stay original art where they changed something.
      for (let i = 0; i < before!.length; i++) if (this.pic.vis[i] !== before![i]) this.picOwner[i] = -1;
    }
    this.scriptBuffer.push([clear ? 'draw.pic' : 'overlay.pic', n]);
    this.picShown = false;
  }

  private showPic(): void {
    this.screen.window = null;
    this.screen.clearPicAreaText();
    this.picShown = true;
    this.render();
  }

  private async showPriScreen(): Promise<void> {
    const saved = this.frameVis.slice();
    this.frameVis.set(this.pic.pri);
    this.host.present(this.screen.compose(this.frameVis));
    await this.waitKey();
    this.frameVis.set(saved);
    this.render();
  }

  private addToPic(view: number, loop: number, cel: number, x: number, y: number, pri: number, margin: number): void {
    const vw = this.getView(view);
    const l = vw.loops[Math.min(loop, vw.loops.length - 1)];
    const c = l.cels[Math.min(cel, l.cels.length - 1)];
    if (x + c.width > PIC_W) x = PIC_W - c.width;
    if (y - c.height < -1) y = c.height - 1;
    if (y >= PIC_H) y = PIC_H - 1;
    const priority = pri === 0 ? priorityFromY(y) : pri;
    this.drawCel(c, x, y, priority, this.pic.vis, this.pic.pri, this.picOwner, this.placementId(view, loop, cel, c, x, y));
    if (margin < 4) this.drawPriorityBox(x, y, c.width, c.height, margin);
    this.scriptBuffer.push(['add.to.pic', view, loop, cel, x, y, pri, margin]);
  }

  /** Adds a control "box" around the bottom of an added picture so ego can't walk through it. */
  private drawPriorityBox(x: number, y: number, w: number, h: number, ctl: number): void {
    const base = priorityFromY(y);
    let ph = 0;
    for (let cy = y; cy >= 0 && priorityFromY(cy) >= base; cy--) ph++;
    if (ph > h) ph = h;
    const put = (px: number, py: number) => {
      if (px >= 0 && px < PIC_W && py >= 0 && py < PIC_H) this.pic.pri[py * PIC_W + px] = ctl;
    };
    for (let i = 0; i < w; i++) put(x + i, y);
    if (ph > 1) {
      for (let i = 1; i < ph; i++) {
        put(x, y - i);
        put(x + w - 1, y - i);
      }
      for (let i = 0; i < w; i++) put(x + i, y - (ph - 1));
    }
  }

  private placementId(view: number, loop: number, cel: number, c: Cel, x: number, y: number): number {
    const left = x * 2;
    const top = y - c.height + 1 + this.screen.picRow * 8;
    const key = `${view},${loop},${cel},${left},${top}`;
    let id = this.placementKeys.get(key);
    if (id === undefined) {
      id = this.nextPlacement++;
      this.placementKeys.set(key, id);
      this.placements.set(id, { view, loop, cel, left, top });
    }
    return id;
  }

  private drawCel(c: Cel, x: number, y: number, priority: number, vis: Uint8Array, pri: Uint8Array, owner?: Int32Array, ownerId = -1): void {
    const top = y - c.height + 1;
    for (let cy = 0; cy < c.height; cy++) {
      const py = top + cy;
      if (py < 0 || py >= PIC_H) continue;
      for (let cx = 0; cx < c.width; cx++) {
        const color = c.pixels[cy * c.width + cx];
        if (color === c.transparent) continue;
        const px = x + cx;
        if (px < 0 || px >= PIC_W) continue;
        const i = py * PIC_W + px;
        let sp = pri[i];
        if (sp <= 2) {
          // Control line: use the priority of the first real priority pixel below it.
          let yy = py + 1;
          sp = 15;
          while (yy < PIC_H) {
            const q = pri[yy * PIC_W + px];
            if (q > 2) {
              sp = q;
              break;
            }
            yy++;
          }
          if (yy >= PIC_H) sp = 0;
        }
        if (sp <= priority) {
          vis[i] = color;
          pri[i] = priority;
          if (owner) owner[i] = ownerId;
        }
      }
    }
  }

  // ---------------------------------------------------------------- views & objects

  private setView(o: ScreenObj, n: number): void {
    o.view = this.getView(n);
    o.viewNum = n;
    this.setLoop(o, o.loop >= o.loopCount ? 0 : o.loop);
  }

  private setLoop(o: ScreenObj, l: number): void {
    if (!o.view) return;
    if (l >= o.loopCount) l = o.loopCount - 1;
    o.loop = l;
    if (o.cel >= o.celCount) o.cel = 0;
    this.setCel(o, o.cel);
  }

  private setCel(o: ScreenObj, c: number): void {
    if (!o.view) return;
    if (c >= o.celCount) c = o.celCount - 1;
    o.cel = Math.max(0, c);
    const cel = o.celData;
    o.width = cel?.width ?? 0;
    o.height = cel?.height ?? 0;
    if (o.x + o.width > PIC_W) {
      o.flags |= UPDATE_POS;
      o.x = PIC_W - o.width;
    }
    if (o.y - o.height < -1) {
      o.flags |= UPDATE_POS;
      o.y = o.height - 1;
    }
    if (o.y <= this.horizon && !(o.flags & IGNORE_HORIZON)) {
      o.flags |= UPDATE_POS;
      o.y = this.horizon + 1;
    }
  }

  private drawObj(o: ScreenObj): void {
    if (o.flags & DRAWN || !o.view) return;
    o.flags |= UPDATE;
    this.fixPosition(o);
    o.prevX = o.x;
    o.prevY = o.y;
    o.flags |= DRAWN;
  }

  private moveObj(o: ScreenObj, x: number, y: number, step: number, flag: number): void {
    o.motion = Motion.MoveTo;
    o.moveX = x;
    o.moveY = y;
    o.moveStepSize = o.stepSize;
    o.moveFlag = flag;
    if (step) o.stepSize = step;
    this.flags[flag] = 0;
    o.flags |= UPDATE;
    if (o.num === 0) this.playerControl = false;
    this.motionMoveObj(o);
  }

  /** Click-to-walk: moves ego toward a point in picture coordinates while the player has control. */
  walkTo(x: number, y: number): void {
    if (y < 0 && y >= -8 && this.flags[F_MENU] && this.menus.length && !this.waitingForKey) {
      this.menuPending = true;
      return;
    }
    const ego = this.objs[0];
    if (!this.playerControl || !(ego.flags & DRAWN) || this.waitingForKey || y < 0 || y >= PIC_H) return;
    if (ego.motion !== Motion.EgoWalk) ego.moveStepSize = ego.stepSize;
    ego.motion = Motion.EgoWalk;
    ego.moveX = Math.max(0, Math.min(PIC_W - ego.width, x - (ego.width >> 1)));
    ego.moveY = y;
    ego.flags &= ~DIDNT_MOVE;
  }

  private checkPosition(o: ScreenObj): boolean {
    return !(
      o.x < 0 ||
      o.x + o.width > PIC_W ||
      o.y - o.height < -1 ||
      o.y >= PIC_H ||
      (!(o.flags & IGNORE_HORIZON) && o.y <= this.horizon)
    );
  }

  private checkCollision(o: ScreenObj): boolean {
    if (o.flags & IGNORE_OBJS) return false;
    for (const u of this.objs) {
      if (u === o || (u.flags & (ANIMATED | DRAWN)) !== (ANIMATED | DRAWN) || u.flags & IGNORE_OBJS) continue;
      if (o.x + o.width < u.x || o.x > u.x + u.width) continue;
      if (o.y === u.y) return true;
      if ((o.y > u.y && o.prevY < u.prevY) || (o.y < u.y && o.prevY > u.prevY)) return true;
    }
    return false;
  }

  private checkPriority(o: ScreenObj): boolean {
    if (!(o.flags & FIXED_PRI)) o.priority = priorityFromY(o.y);
    let pass = true;
    let water = false;
    let trigger = false;
    if (o.priority !== 15) {
      water = true;
      const row = o.y * PIC_W;
      for (let i = 0; i < o.width; i++) {
        const p = this.pic.pri[row + o.x + i];
        if (p === 0) {
          pass = false;
          break;
        }
        if (p === 3) continue;
        water = false;
        if (p === 1) {
          if (o.flags & IGNORE_BLOCKS) continue;
          pass = false;
          break;
        }
        if (p === 2) trigger = true;
      }
      if (pass) {
        if (!water && o.flags & ON_WATER) pass = false;
        if (water && o.flags & ON_LAND) pass = false;
      }
    }
    if (o.num === 0) {
      this.flags[F_EGO_TRIGGER] = trigger ? 1 : 0;
      this.flags[F_EGO_WATER] = water ? 1 : 0;
    }
    return pass;
  }

  private fixPosition(o: ScreenObj): void {
    if (!(o.flags & IGNORE_HORIZON) && o.y <= this.horizon) o.y = this.horizon + 1;
    let dir = 0;
    let count = 1;
    let size = 1;
    for (let guard = 0; guard < 20000; guard++) {
      if (this.checkPosition(o) && !this.checkCollision(o) && this.checkPriority(o)) return;
      switch (dir) {
        case 0:
          o.x--;
          if (--count) continue;
          dir = 1;
          break;
        case 1:
          o.y++;
          if (--count) continue;
          dir = 2;
          size++;
          break;
        case 2:
          o.x++;
          if (--count) continue;
          dir = 3;
          break;
        case 3:
          o.y--;
          if (--count) continue;
          dir = 0;
          size++;
          break;
      }
      count = size;
    }
  }

  private getDirection(x: number, y: number, dx: number, dy: number, step: number): number {
    const table = [8, 1, 2, 7, 0, 3, 6, 5, 4];
    const chk = (d: number) => (-step >= d ? 0 : step <= d ? 2 : 1);
    return table[chk(dx - x) + 3 * chk(dy - y)];
  }

  private motionMoveObj(o: ScreenObj): void {
    o.direction = this.getDirection(o.x, o.y, o.moveX, o.moveY, o.stepSize);
    if (o.num === 0) this.vars[V_EGO_DIR] = o.direction;
    if (o.direction === 0) this.motionMoveObjStop(o);
  }

  private motionMoveObjStop(o: ScreenObj): void {
    o.stepSize = o.moveStepSize;
    if (o.motion !== Motion.EgoWalk) this.flags[o.moveFlag] = 1;
    o.motion = Motion.Normal;
    if (o.num === 0) {
      this.playerControl = true;
      this.vars[V_EGO_DIR] = 0;
    }
  }

  private randInt(max: number): number {
    return Math.floor(this.rand() * (max + 1));
  }

  private checkAllMotions(): void {
    for (const o of this.objs) {
      if ((o.flags & (ANIMATED | UPDATE | DRAWN)) !== (ANIMATED | UPDATE | DRAWN) || o.stepTimeCount !== 1) continue;
      switch (o.motion) {
        case Motion.Wander: {
          const orig = o.wanderCount;
          o.wanderCount = (o.wanderCount - 1) & 0xff;
          if (orig === 0 || o.flags & DIDNT_MOVE) {
            o.direction = this.randInt(8);
            if (o.num === 0) this.vars[V_EGO_DIR] = o.direction;
            while (o.wanderCount < 6) o.wanderCount = this.randInt(50);
          }
          break;
        }
        case Motion.Follow: {
          const ego = this.objs[0];
          const ex = ego.x + (ego.width >> 1);
          const ey = ego.y;
          const ox = o.x + (o.width >> 1);
          const dir = this.getDirection(ox, o.y, ex, ey, o.followStepSize);
          if (dir === 0) {
            o.direction = 0;
            o.motion = Motion.Normal;
            this.flags[o.followFlag] = 1;
            break;
          }
          if (o.followCount === 255) {
            o.followCount = 0;
          } else if (o.flags & DIDNT_MOVE) {
            do o.direction = this.randInt(8);
            while (o.direction === 0);
            const d = (Math.abs(ey - o.y) + Math.abs(ex - ox)) >> 1;
            if (d < o.stepSize) {
              o.followCount = o.stepSize;
              break;
            }
            do o.followCount = this.randInt(d);
            while (o.followCount < o.stepSize);
            break;
          }
          if (o.followCount !== 0) {
            o.followCount = Math.max(0, o.followCount - o.stepSize);
          } else {
            o.direction = dir;
          }
          break;
        }
        case Motion.MoveTo:
          this.motionMoveObj(o);
          break;
        case Motion.EgoWalk:
          if (o.flags & DIDNT_MOVE && o.direction) this.motionMoveObjStop(o);
          else this.motionMoveObj(o);
          break;
      }
      if (this.block.active && !(o.flags & IGNORE_BLOCKS) && o.direction) {
        const inside = this.insideBlock(o.x, o.y);
        const nx = o.x + o.stepSize * DX[o.direction];
        const ny = o.y + o.stepSize * DY[o.direction];
        if (this.insideBlock(nx, ny) === inside) o.flags &= ~DIDNT_MOVE;
        else {
          o.flags |= DIDNT_MOVE;
          o.direction = 0;
          if (o.num === 0) this.vars[V_EGO_DIR] = 0;
        }
      }
    }
  }

  private insideBlock(x: number, y: number): boolean {
    const b = this.block;
    return x > b.x1 && x < b.x2 && y > b.y1 && y < b.y2;
  }

  private updateObjects(): void {
    let changed = 0;
    for (const o of this.objs) {
      if ((o.flags & (ANIMATED | UPDATE | DRAWN)) !== (ANIMATED | UPDATE | DRAWN)) continue;
      changed++;
      let loop = 4;
      if (!(o.flags & FIX_LOOP)) {
        if (o.loopCount === 2 || o.loopCount === 3) loop = LOOP_TABLE_2[o.direction];
        else if (o.loopCount === 4) loop = LOOP_TABLE_4[o.direction];
      }
      if (loop !== 4 && loop !== o.loop && o.stepTimeCount === 1) this.setLoop(o, loop);
      if (o.flags & CYCLING && o.cycleTimeCount) {
        if (--o.cycleTimeCount === 0) {
          this.advanceCel(o);
          o.cycleTimeCount = o.cycleTime;
        }
      }
    }
    if (changed) {
      this.updatePositions();
      this.objs[0].flags &= ~(ON_WATER | ON_LAND);
    }
  }

  private advanceCel(o: ScreenObj): void {
    let cel = o.cel;
    const last = o.celCount - 1;
    switch (o.cycle) {
      case CycleType.Normal:
        if (++cel > last) cel = 0;
        break;
      case CycleType.EndOfLoop:
        if (cel < last) {
          if (++cel !== last) break;
        }
        this.flags[o.loopFlag] = 1;
        o.flags &= ~CYCLING;
        o.direction = 0;
        o.cycle = CycleType.Normal;
        break;
      case CycleType.RevLoop:
        if (cel) {
          if (--cel) break;
        }
        this.flags[o.loopFlag] = 1;
        o.flags &= ~CYCLING;
        o.direction = 0;
        o.cycle = CycleType.Normal;
        break;
      case CycleType.Reverse:
        cel = cel === 0 ? last : cel - 1;
        break;
    }
    this.setCel(o, cel);
  }

  private updatePositions(): void {
    this.vars[V_BORDER_CODE] = 0;
    this.vars[V_EGO_BORDER] = 0;
    this.vars[V_BORDER_OBJ] = 0;
    for (const o of this.objs) {
      if ((o.flags & (ANIMATED | UPDATE | DRAWN)) !== (ANIMATED | UPDATE | DRAWN)) continue;
      if (o.stepTimeCount > 1) {
        o.stepTimeCount--;
        continue;
      }
      o.stepTimeCount = o.stepTime;
      const oldX = o.x;
      const oldY = o.y;
      let x = o.x;
      let y = o.y;
      if (!(o.flags & UPDATE_POS)) {
        x += o.stepSize * DX[o.direction];
        y += o.stepSize * DY[o.direction];
      }
      let border = 0;
      if (x < 0) {
        x = 0;
        border = 4;
      } else if (x + o.width > PIC_W) {
        x = PIC_W - o.width;
        border = 2;
      }
      if (y - o.height < -1) {
        y = o.height - 1;
        border = 1;
      } else if (y > PIC_H - 1) {
        y = PIC_H - 1;
        border = 3;
      } else if (!(o.flags & IGNORE_HORIZON) && y <= this.horizon) {
        y = this.horizon + 1;
        border = 1;
      }
      o.x = x;
      o.y = y;
      if (this.checkCollision(o) || !this.checkPriority(o)) {
        o.x = oldX;
        o.y = oldY;
        border = 0;
        this.fixPosition(o);
      }
      if (border) {
        if (o.num === 0) this.vars[V_EGO_BORDER] = border;
        else {
          this.vars[V_BORDER_OBJ] = o.num;
          this.vars[V_BORDER_CODE] = border;
        }
        if (o.motion === Motion.MoveTo || o.motion === Motion.EgoWalk) this.motionMoveObjStop(o);
      }
      o.flags &= ~UPDATE_POS;
    }
    for (const o of this.objs) {
      if (!(o.flags & DRAWN)) continue;
      if (o.x === o.prevX && o.y === o.prevY) o.flags |= DIDNT_MOVE;
      else {
        o.prevX = o.x;
        o.prevY = o.y;
        o.flags &= ~DIDNT_MOVE;
      }
    }
  }

  // ---------------------------------------------------------------- rendering

  render(): void {
    if (this.picShown) {
      this.frameVis.set(this.pic.vis);
      this.framePri.set(this.pic.pri);
      this.frameOwner.set(this.picOwner);
      const drawn = this.objs.filter((o) => (o.flags & (ANIMATED | DRAWN)) === (ANIMATED | DRAWN) && o.celData);
      const key = (o: ScreenObj) => (o.flags & FIXED_PRI ? priorityToY(o.priority) : o.y);
      const byY = (a: ScreenObj, b: ScreenObj) => key(a) - key(b) || a.num - b.num;
      const still = drawn.filter((o) => !(o.flags & UPDATE)).sort(byY);
      const moving = drawn.filter((o) => o.flags & UPDATE).sort(byY);
      for (const o of [...still, ...moving]) {
        if (!(o.flags & FIXED_PRI)) o.priority = priorityFromY(o.y);
        const id = this.placementId(o.viewNum, o.loop, o.cel, o.celData!, o.x, o.y);
        this.drawCel(o.celData!, o.x, o.y, o.priority, this.frameVis, this.framePri, this.frameOwner, id);
      }
      if (this.showObjCel) {
        const c = this.showObjCel;
        this.drawCel(c, (PIC_W - c.width) >> 1, PIC_H - 1, 15, this.frameVis, this.framePri, this.frameOwner, -1);
      }
    } else this.frameOwner.fill(-1);
    this.host.present(this.screen.compose(this.frameVis, this.frameOwner));
  }

  // ---------------------------------------------------------------- text

  private msg(logic: Logic, n: number): string {
    return this.format(logic.messages[n] ?? '', logic);
  }

  /** Expands %v, %m, %o, %w, %s and %g codes in a message. */
  format(s: string, logic: Logic, depth = 0): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (ch !== '%' || depth > 4) {
        out += ch;
        continue;
      }
      const type = s[i + 1];
      let j = i + 2;
      let num = '';
      while (j < s.length && s[j] >= '0' && s[j] <= '9') num += s[j++];
      if (!num || !'vmowsg'.includes(type)) {
        out += ch;
        continue;
      }
      const n = Number(num);
      switch (type) {
        case 'v': {
          let val = String(this.vars[n]);
          if (s[j] === '|') {
            let w = '';
            j++;
            while (j < s.length && s[j] >= '0' && s[j] <= '9') w += s[j++];
            val = val.padStart(Number(w), '0');
          }
          out += val;
          break;
        }
        case 'm': out += this.format(logic.messages[n] ?? '', logic, depth + 1); break;
        case 'o': out += this.itemNames[this.vars[n]] ?? ''; break;
        case 'w': out += this.egoWords[n - 1]?.word ?? ''; break;
        case 's': out += this.format(this.strings[n] ?? '', logic, depth + 1); break;
        case 'g': out += this.format(this.getLogic(0).messages[n] ?? '', logic, depth + 1); break;
      }
      i = j - 1;
    }
    return out;
  }

  private textColors(): [number, number] {
    if (this.screen.textMode) return [this.textFg, this.textBg];
    return this.textBg ? [0, 15] : [this.textFg, 0];
  }

  private display(row: number, col: number, text: string): void {
    const [fg, bg] = this.textColors();
    let r = row;
    let c = col;
    for (const ch of text) {
      if (ch === '\n' || c >= 40) {
        r++;
        c = ch === '\n' ? col : 0;
        if (ch === '\n') continue;
      }
      this.screen.drawChar(this.screen.text, r, c++, ch.charCodeAt(0), fg, bg);
    }
    this.render();
  }

  drawStatus(): void {
    if (!this.statusLineOn || this.screen.textMode) return;
    const r = this.statusRow;
    this.screen.clearRows(r, r, 15);
    this.screen.drawText(r, 0, ` Score:${this.vars[V_SCORE]} of ${String(this.vars[V_MAX_SCORE]).padEnd(3)}`, 0, 15);
    this.screen.drawText(r, 30, `Sound:${this.flags[F_SOUND] ? 'on ' : 'off'}`, 0, 15);
  }

  private drawPrompt(): void {
    if (!this.acceptInput || this.screen.textMode) return;
    const r = this.inputRow;
    this.screen.clearRows(r, r, 0);
    this.screen.drawText(r, 0, this.strings[0] + this.inputText + this.cursorChar, 15, 0);
  }

  /** Opens a message window. Blocks until a key is pressed unless flag 15 (non-blocking) is set. */
  private async print(text: string, row?: number, col?: number, width?: number): Promise<boolean> {
    const maxW = width && width > 0 ? width : 30;
    const lines = wrapText(text, maxW).slice(0, 20);
    const w = Math.max(...lines.map((l) => l.length));
    const h = lines.length;
    const r = row ?? this.screen.picRow + Math.max(0, Math.floor((21 - h) / 2));
    const c = col ?? Math.floor((40 - w) / 2);
    this.screen.window = this.screen.makeWindow(lines, r, c);
    this.render();
    if (this.flags[F_NONBLOCK_PRINT]) {
      this.nonBlockingWindow = this.screen.window;
      return true;
    }
    const timeout = this.vars[V_WINDOW_TIMER] ? this.vars[V_WINDOW_TIMER] * 500 : 0;
    const k = await this.waitKey(timeout);
    this.screen.window = null;
    this.render();
    return !k || k.ascii !== 27;
  }

  /** Line editor used by get.string, get.num and the save dialog. Returns null if Esc was pressed. */
  private async readLine(row: number, col: number, maxLen: number, initial = ''): Promise<string | null> {
    let s = initial;
    const [fg, bg] = this.textColors();
    for (;;) {
      this.screen.drawText(row, col, (s + this.cursorChar).padEnd(maxLen + 1), fg, bg);
      this.render();
      const k = await this.waitKey(0, false);
      if (!k) continue;
      if (k.ascii === 13) return s;
      if (k.ascii === 27) return null;
      if (k.ascii === 8) s = s.slice(0, -1);
      else if (k.ascii >= 32 && k.ascii < 127 && s.length < maxLen) s += String.fromCharCode(k.ascii);
    }
  }

  private async getString(sn: number, prompt: string, row: number, col: number, maxLen: number): Promise<void> {
    const [fg, bg] = this.textColors();
    if (row < 25) this.screen.drawText(row, col, prompt, fg, bg);
    const len = Math.min(maxLen || 40, 40 - col - prompt.length - 1);
    const s = await this.readLine(row < 25 ? row : this.inputRow, col + prompt.length, Math.max(1, len));
    this.strings[sn] = s ?? '';
  }

  private async getNum(prompt: string, vn: number): Promise<void> {
    const lines = wrapText(prompt, 30);
    lines.push('');
    const w = Math.max(...lines.map((l) => l.length), 6);
    const r = this.screen.picRow + Math.floor((21 - lines.length) / 2);
    const c = Math.floor((40 - w) / 2);
    this.screen.window = this.screen.makeWindow(lines.map((l) => l.padEnd(w)), r, c);
    const s = await this.readLineInWindow(r + lines.length - 1, c, 3);
    this.screen.window = null;
    this.vars[vn] = Number(s) & 0xff;
    this.render();
  }

  /** Reads text drawn inside the current window (black on white). */
  private async readLineInWindow(row: number, col: number, maxLen: number): Promise<string | null> {
    const win = this.screen.window!;
    const li = row - win.row;
    let s = '';
    for (;;) {
      win.lines[li] = (s + this.cursorChar).padEnd(Math.max(win.lines[li].length, s.length + 1));
      this.render();
      const k = await this.waitKey(0, false);
      if (!k) continue;
      if (k.ascii === 13) return s;
      if (k.ascii === 27) return null;
      if (k.ascii === 8) s = s.slice(0, -1);
      else if (k.ascii >= 32 && k.ascii < 127 && s.length < maxLen) s += String.fromCharCode(k.ascii);
    }
  }

  private async shake(times: number): Promise<void> {
    this.host.shake(times);
    await this.host.sleep(times * 80);
  }

  private async showObj(n: number): Promise<void> {
    const v = this.getView(n);
    this.showObjCel = v.loops[0]?.cels[0] ?? null;
    await this.print(v.description || 'You see nothing special.');
    this.showObjCel = null;
    this.render();
  }

  // ---------------------------------------------------------------- menus

  /** Shows the menu bar; arrows move, Enter picks an item (firing its controller), Esc closes. */
  private async runMenu(): Promise<void> {
    const layer = this.screen.text;
    const saved = layer.slice();
    const savedCells = this.screen.cells(layer).slice();
    const row = this.statusRow;
    let mi = 0;
    let ii = 0;
    const firstEnabled = (m: Menu, from: number, dir: number) => {
      for (let k = 0; k < m.items.length; k++) {
        const j = (from + dir * k + m.items.length * 2) % m.items.length;
        if (m.items[j].enabled) return j;
      }
      return from;
    };
    ii = firstEnabled(this.menus[0], 0, 1);
    for (;;) {
      layer.set(saved);
      this.screen.cells(layer).set(savedCells);
      this.screen.clearRows(row, row, 15);
      for (const [k, m] of this.menus.entries()) {
        const hi = k === mi;
        this.screen.drawText(row, m.col, m.name, hi ? 15 : 0, hi ? 0 : 15);
      }
      const m = this.menus[mi];
      const w = Math.max(...m.items.map((it) => it.text.length));
      const col = Math.min(m.col, 39 - w);
      const lines = m.items.map((it) => it.text.padEnd(w));
      const box = this.screen.makeWindow(lines, row + 2, col);
      const top = (row + 1) * 8 + 1; // start just below the menu bar
      this.screen.window = { ...box, y: top, h: box.y + box.h - top, lines: [] };
      this.render();
      // Items drawn on top of the window, so the selected one can be inverted and disabled ones dimmed.
      const px = this.screen.pixels;
      m.items.forEach((it, k) => {
        const hi = k === ii;
        const fg = hi ? 15 : it.enabled ? 0 : 8;
        this.screen.drawText(row + 2 + k, col, lines[k], fg, hi ? 0 : 15, px);
      });
      this.host.present(px);
      const key = await this.waitKey(0, false);
      if (!key) continue;
      if (key.ascii === 27) break;
      if (key.ascii === 13) {
        const it = m.items[ii];
        if (it?.enabled) {
          this.controllers[it.controller] = 1;
          break;
        }
      }
      if (key.scan === 75 || key.scan === 77) {
        mi = (mi + (key.scan === 77 ? 1 : this.menus.length - 1)) % this.menus.length;
        ii = firstEnabled(this.menus[mi], 0, 1);
      }
      if (key.scan === 72) ii = firstEnabled(m, ii - 1, -1);
      if (key.scan === 80) ii = firstEnabled(m, ii + 1, 1);
    }
    layer.set(saved);
    this.screen.cells(layer).set(savedCells);
    this.screen.window = null;
    this.drawStatus();
    this.render();
  }

  // ---------------------------------------------------------------- inventory

  private async inventory(): Promise<void> {
    const layer = new Uint8Array(320 * 200).fill(15);
    const carried = this.itemNames.map((name, i) => ({ name, i })).filter((x) => this.itemRooms[x.i] === 255);
    const select = !!this.flags[F_INV_SELECT];
    let sel = 0;
    const draw = () => {
      layer.fill(15);
      this.screen.drawText(0, 11, 'You are carrying:', 0, 15, layer);
      if (!carried.length) this.screen.drawText(2, 16, 'nothing', 0, 15, layer);
      carried.forEach((it, k) => {
        const row = 2 + (k >> 1);
        const col = k & 1 ? 39 - it.name.length : 1;
        const hi = select && k === sel;
        this.screen.drawText(row, col, it.name, hi ? 15 : 0, hi ? 0 : 15, layer);
      });
      const foot = select ? 'Press ENTER to select, ESC to cancel' : 'Press a key to return to the game';
      this.screen.drawText(24, Math.floor((40 - foot.length) / 2), foot, 0, 15, layer);
      this.screen.modal = layer;
      this.render();
    };
    for (;;) {
      draw();
      const k = await this.waitKey();
      if (!k) continue;
      if (!select || !carried.length) break;
      if (k.ascii === 13) {
        this.vars[V_INV_SELECT] = carried[sel].i;
        break;
      }
      if (k.ascii === 27) {
        this.vars[V_INV_SELECT] = 255;
        break;
      }
      if (k.scan === 77) sel = Math.min(carried.length - 1, sel + 1);
      if (k.scan === 75) sel = Math.max(0, sel - 1);
      if (k.scan === 80) sel = Math.min(carried.length - 1, sel + 2);
      if (k.scan === 72) sel = Math.max(0, sel - 2);
    }
    if (!select) this.vars[V_INV_SELECT] = 255;
    this.screen.modal = null;
    this.render();
  }

  // ---------------------------------------------------------------- sound

  private playSound(n: number, flag: number): void {
    this.stopSound();
    this.flags[flag] = 0;
    if (!this.flags[F_SOUND] || !this.res.exists('sound', n)) {
      this.flags[flag] = 1;
      return;
    }
    let pcm = this.soundCache.get(n);
    if (!pcm) {
      pcm = renderSound(this.res.load('sound', n));
      this.soundCache.set(n, pcm);
    }
    this.host.playSound(pcm);
    this.sound = { flag, end: this.host.now() + (pcm.length / SAMPLE_RATE) * 1000 };
  }

  private stopSound(): void {
    if (this.sound) {
      this.flags[this.sound.flag] = 1;
      this.sound = null;
    }
    this.host.stopSound();
  }

  private checkSound(): void {
    if (this.sound && this.host.now() >= this.sound.end) {
      this.flags[this.sound.flag] = 1;
      this.sound = null;
    }
  }

  // ---------------------------------------------------------------- save / restore / restart / quit

  private slotKey(slot: number): string {
    return `agi-${this.gameId}-save-${slot}`;
  }

  private slotList(): string[] {
    const lines: string[] = [];
    for (let s = 1; s <= 9; s++) {
      const raw = this.host.load(this.slotKey(s));
      let desc = '-- empty --';
      if (raw) {
        try {
          desc = JSON.parse(raw).description;
        } catch {
          desc = '(damaged)';
        }
      }
      lines.push(`${s}. ${desc}`.slice(0, 32));
    }
    return lines;
  }

  private async chooseSlot(title: string): Promise<number> {
    const lines = [title, '', ...this.slotList(), '', 'Press 1-9, or ESC to cancel.'];
    const w = Math.max(...lines.map((l) => l.length));
    this.screen.window = this.screen.makeWindow(lines.map((l) => l.padEnd(w)), 3, Math.floor((40 - w) / 2));
    this.render();
    for (;;) {
      const k = await this.waitKey();
      if (!k) continue;
      if (k.ascii === 27) {
        this.screen.window = null;
        this.render();
        return 0;
      }
      if (k.ascii >= 49 && k.ascii <= 57) return k.ascii - 48;
    }
  }

  private async saveGame(): Promise<void> {
    const slot = await this.chooseSlot('Save your game in which slot?');
    if (!slot) return;
    const lines = ['Type a description of this game:', '', ''];
    const w = 32;
    const r = 9;
    const c = Math.floor((40 - w) / 2);
    this.screen.window = this.screen.makeWindow(lines.map((l) => l.padEnd(w)), r, c);
    const desc = await this.readLineInWindow(r + 2, c, 30);
    this.screen.window = null;
    this.render();
    if (desc === null) return;
    const state = {
      description: desc || `Room ${this.vars[V_ROOM]}`,
      vars: Array.from(this.vars),
      flags: Array.from(this.flags),
      strings: this.strings,
      itemRooms: this.itemRooms,
      objs: this.objs.map((o) => o.serialize()),
      horizon: this.horizon,
      block: this.block,
      playerControl: this.playerControl,
      keymap: this.keymap,
      acceptInput: this.acceptInput,
      cursorChar: this.cursorChar,
      textFg: this.textFg,
      textBg: this.textBg,
      statusLineOn: this.statusLineOn,
      picRow: this.screen.picRow,
      inputRow: this.inputRow,
      statusRow: this.statusRow,
      scriptBuffer: this.scriptBuffer,
      lastInput: this.lastInput,
      scanStart: [...this.scanStart],
      menus: this.menus,
    };
    this.host.save(this.slotKey(slot), JSON.stringify(state));
  }

  private async restoreGame(): Promise<void> {
    const slot = await this.chooseSlot('Restore which game?');
    if (!slot) return;
    const raw = this.host.load(this.slotKey(slot));
    this.screen.window = null;
    if (!raw) {
      await this.print('There is no game saved in that slot.');
      return;
    }
    this.loadState(JSON.parse(raw));
  }

  private loadState(s: any): void {
    this.stopSound();
    this.vars.set(s.vars);
    this.flags.set(s.flags);
    this.strings = [...s.strings];
    this.itemRooms = [...s.itemRooms];
    this.objs = s.objs.map((d: Record<string, number>, i: number) => {
      const o = new ScreenObj(i);
      Object.assign(o, d);
      o.view = null;
      return o;
    });
    for (const o of this.objs) {
      if (o.flags & ANIMATED && this.res.exists('view', o.viewNum)) {
        const { loop, cel, x, y } = o;
        o.view = this.getView(o.viewNum);
        o.loop = Math.min(loop, o.loopCount - 1);
        o.cel = Math.min(cel, o.celCount - 1);
        o.width = o.celData?.width ?? 0;
        o.height = o.celData?.height ?? 0;
        o.x = x;
        o.y = y;
      }
    }
    this.horizon = s.horizon;
    this.block = { ...s.block };
    this.playerControl = s.playerControl;
    this.keymap = s.keymap;
    this.acceptInput = s.acceptInput;
    this.cursorChar = s.cursorChar;
    this.textFg = s.textFg;
    this.textBg = s.textBg;
    this.statusLineOn = s.statusLineOn;
    this.screen.picRow = s.picRow;
    this.inputRow = s.inputRow;
    this.statusRow = s.statusRow;
    this.lastInput = s.lastInput ?? '';
    this.scanStart = new Map(s.scanStart ?? []);
    if (s.menus) this.menus = s.menus;
    this.inputText = '';
    this.logics.clear();
    this.getLogic(this.vars[V_ROOM]);
    // Rebuild the picture by replaying the drawing commands since the room was entered.
    this.pic.clear();
    this.scriptBuffer = [];
    for (const e of s.scriptBuffer as ScriptEntry[]) {
      if (e[0] === 'draw.pic' || e[0] === 'overlay.pic') this.drawPic(e[1], e[0] === 'draw.pic');
      else if (e[0] === 'add.to.pic') this.addToPic(e[1], e[2], e[3], e[4], e[5], e[6], e[7]);
    }
    this.screen.textMode = false;
    this.screen.modal = null;
    this.screen.window = null;
    this.screen.resetTextLayer();
    this.picShown = true;
    this.drawStatus();
    this.drawPrompt();
    this.flags[F_RESTORED] = 1;
    this.exitAll = true;
    this.render();
  }

  /** Exposes save state for debugging/tests. */
  get room(): number {
    return this.vars[V_ROOM];
  }

  private async restartGame(): Promise<void> {
    const ok = await this.print('Press ENTER to restart\nthe game.\n\nPress ESC to continue\nthis game.');
    if (ok) {
      this.restartRequested = true;
      this.exitAll = true;
    }
  }

  private async quit(force: number): Promise<void> {
    if (!force && !(await this.print('Press ENTER to quit.\nPress ESC to keep playing.'))) return;
    this.stopSound();
    this.quitRequested = true;
    this.exitAll = true;
    this.screen.window = null;
    this.render();
    this.host.quit();
  }
}
