// SCI0 virtual machine: segments, script loading, objects/classes, the bytecode
// interpreter and kernel-call dispatch. Structure follows Sierra's original VM
// (as documented by ScummVM's implementation) so object sends behave identically.

import { SciResources, ResType } from './resource';

// ---------------------------------------------------------------- registers
// A register is either a 16-bit number (segment 0) or a pointer (segment:offset).
export const segOf = (r: number): number => r >>> 16;
export const offOf = (r: number): number => r & 0xffff;
export const mk = (s: number, o: number): number => ((s << 16) | (o & 0xffff)) >>> 0;
export const num = (n: number): number => n & 0xffff;
export const s16 = (r: number): number => ((r & 0xffff) << 16) >> 16;
export const isNum = (r: number): boolean => r >>> 16 === 0;
export const NULL = 0;

export class SciError extends Error {}

// ---------------------------------------------------------------- objects

const INFO_CLASS = 0x8000;
const INFO_CLONE = 0x0001;

export class SciObject {
  vars: number[];
  /** Selector IDs of each variable (only filled for classes). */
  baseVars: number[] = [];
  /** Method table: selector id -> code offset in `script`. */
  methods: { sel: number; off: number }[] = [];

  constructor(public pos: number, public script: Script, vars: number[]) {
    this.vars = vars;
  }

  get species(): number {
    return this.vars[0];
  }
  get superClass(): number {
    return this.vars[1];
  }
  get info(): number {
    return this.vars[2];
  }
  get isClass(): boolean {
    return (this.vars[2] & INFO_CLASS) !== 0;
  }
}

export class Script {
  locals: number[] = [];
  localsSeg = 0;
  exports: number[] = [];
  synonyms: { replaceant: number; replacement: number }[] = [];
  objects = new Map<number, SciObject>(); // offset -> object
  lockers = 1;

  constructor(public nr: number, public seg: number, public buf: Uint8Array) {}

  u16(o: number): number {
    return this.buf[o] | (this.buf[o + 1] << 8);
  }
}

type Segment =
  | { type: 'script'; script: Script }
  | { type: 'locals'; script: Script }
  | { type: 'stack' }
  | { type: 'clones' }
  | { type: 'lists' }
  | { type: 'nodes' }
  | { type: 'hunk' }
  | { type: 'dynmem'; data: Uint8Array; desc: string };

export interface SciList {
  first: number;
  last: number;
}
export interface SciNode {
  pred: number;
  succ: number;
  key: number;
  value: number;
}

// ---------------------------------------------------------------- execution frames

const CALL = 0;
const VARSEL = 1;
const CARRY = -1;

interface Frame {
  objp: number;
  sendp: number;
  pcSeg: number;
  pc: number;
  localSeg: number; // script segment whose locals are used
  sp: number;
  fp: number;
  argc: number;
  argp: number; // stack index of argc
  tempCount: number;
  type: number;
  varObj: number;
  varIndex: number;
  selector: number;
  origin: number;
}

// Operand formats (see original opcode table). Codes: n none, b byte, B signed byte,
// w word, v variable-width unsigned, V variable-width signed, R relative (signed var width)
export const FORMATS: string[] = [
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', // 00-0f
  '', '', '', '', '', '', '', 'R', 'R', 'R', 'V', '', 'V', '', '', 'v', // 10-1f
  'Rb', 'vb', 'vb', 'vVb', '', 'b', 'x', 'x', 'v', 'x', 'b', 'vb', 'V', 'Vv', '', 'x', // 20-2f
  '', 'v', 'v', 'v', 'v', 'v', 'v', 'v', 'v', 'R', 'R', '', '', '', '', 'w', // 30-3f
];
for (let i = 0x40; i < 0x80; i++) FORMATS[i] = 'v';

export const OPCODE_NAMES = [
  'bnot', 'add', 'sub', 'mul', 'div', 'mod', 'shr', 'shl', 'xor', 'and', 'or', 'neg', 'not', 'eq?', 'ne?', 'gt?',
  'ge?', 'lt?', 'le?', 'ugt?', 'uge?', 'ult?', 'ule?', 'bt', 'bnt', 'jmp', 'ldi', 'push', 'pushi', 'toss', 'dup', 'link',
  'call', 'callk', 'callb', 'calle', 'ret', 'send', 'info', 'superP', 'class', 'dummy', 'self', 'super', '&rest', 'lea', 'selfID', 'dummy',
  'pprev', 'pToa', 'aTop', 'pTos', 'sTop', 'ipToa', 'dpToa', 'ipTos', 'dpTos', 'lofsa', 'lofss', 'push0', 'push1', 'push2', 'pushSelf', 'line',
];

export type KernelFn = (vm: SciVM, args: number[]) => number | void;

export interface SciHost {
  now(): number;
}

const STACK_SIZE = 0x1000;

export class SciVM {
  readonly res: SciResources;
  segments: (Segment | null)[] = [null]; // segment 0 = numbers
  scriptsByNr = new Map<number, Script>();
  objects = new Map<number, SciObject>(); // reg -> object (scripts objects and clones)
  classTable: { script: number; reg: number }[] = [];
  selectorNames: string[] = [];
  private selectorIds = new Map<string, number>();
  kernelNames: string[] = [];
  kernel: (KernelFn | null)[] = [];
  kernelImpl = new Map<string, KernelFn>();

  // stack
  stack = new Array<number>(STACK_SIZE).fill(0);
  stackSeg: number;
  frames: Frame[] = [];
  acc = 0;
  prev = 0;
  private rest = 0;

  // dynamic segments
  private cloneSeg: number;
  listSeg: number;
  nodeSeg: number;
  hunkSeg: number;
  private nextClone = 1;
  lists = new Map<number, SciList>();
  nodes = new Map<number, SciNode>();
  private nextList = 1;
  private nextNode = 1;
  hunks = new Map<number, unknown>();
  private nextHunk = 1;

  gameObject = 0;
  globalsScript!: Script;

  // execution control
  /** Set by kernel functions (e.g. Wait) to ask the top-level runner to yield. */
  yieldRequested = false;
  waitUntil = 0;
  instructionCount = 0;
  trace = false;
  traceSends = false;
  abort: null | 'restart' | 'quit' | 'restore' = null;
  private runDepth = 0;
  /** Development aid: unimplemented kernel calls return 0 instead of throwing. */
  stubMissing = false;
  private warnedKernel = new Set<string>();

  constructor(res: SciResources, public host: SciHost) {
    this.res = res;
    this.stackSeg = this.allocSeg({ type: 'stack' });
    this.cloneSeg = this.allocSeg({ type: 'clones' });
    this.listSeg = this.allocSeg({ type: 'lists' });
    this.nodeSeg = this.allocSeg({ type: 'nodes' });
    this.hunkSeg = this.allocSeg({ type: 'hunk' });
    this.loadVocabularies();
  }

  // ---------------------------------------------------------------- vocabularies

  private static readNameTable(d: Uint8Array): string[] {
    const count = d[0] | (d[1] << 8);
    const out: string[] = [];
    for (let i = 0; i <= count; i++) {
      const o = d[2 + i * 2] | (d[3 + i * 2] << 8);
      if (o + 1 >= d.length) break;
      const len = d[o] | (d[o + 1] << 8);
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(d[o + 2 + k]);
      out.push(s);
    }
    return out;
  }

  private loadVocabularies(): void {
    const sel = this.res.get(ResType.Vocab, 997);
    const ker = this.res.get(ResType.Vocab, 999);
    const cls = this.res.get(ResType.Vocab, 996);
    if (!sel || !ker || !cls) throw new SciError('Missing vocabulary resources (996/997/999)');
    this.selectorNames = SciVM.readNameTable(sel);
    this.selectorNames.forEach((n, i) => {
      if (!this.selectorIds.has(n)) this.selectorIds.set(n, i);
    });
    // The kernel name table has a valid prefix; stop at the first non-identifier name.
    const kn = SciVM.readNameTable(ker);
    this.kernelNames = [];
    for (const n of kn) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(n)) break;
      this.kernelNames.push(n);
    }
    // The name after Graph is unreadable in some games' tables; Sierra's list has Joystick there.
    if (this.kernelNames[this.kernelNames.length - 1] === 'Graph') this.kernelNames.push('Joystick');
    for (let i = 0; i + 3 < cls.length; i += 4) this.classTable.push({ script: cls[i + 2] | (cls[i + 3] << 8), reg: 0 });
  }

  /** Binds implemented kernel functions to the game's kernel call numbers. */
  bindKernel(): void {
    this.kernel = this.kernelNames.map((n) => this.kernelImpl.get(n) ?? null);
  }

  sel(name: string): number {
    const id = this.selectorIds.get(name);
    if (id === undefined) return -1;
    return id;
  }

  // ---------------------------------------------------------------- segments & memory

  allocSeg(s: Segment): number {
    for (let i = 1; i < this.segments.length; i++) {
      if (!this.segments[i]) {
        this.segments[i] = s;
        return i;
      }
    }
    this.segments.push(s);
    return this.segments.length - 1;
  }

  /** Allocates a byte buffer addressable by scripts (used for kernel-made strings, saved bits, etc.). */
  allocDynMem(size: number, desc: string): number {
    return mk(this.allocSeg({ type: 'dynmem', data: new Uint8Array(size), desc }), 0);
  }

  freeSeg(seg: number): void {
    this.segments[seg] = null;
  }

  private regArray(seg: number): number[] | null {
    const s = this.segments[seg];
    if (!s) return null;
    if (s.type === 'stack') return this.stack;
    if (s.type === 'locals') return s.script.locals;
    return null;
  }

  readByte(ptr: number): number {
    const seg = segOf(ptr);
    const off = offOf(ptr);
    const s = this.segments[seg];
    if (!s) return 0;
    if (s.type === 'script') return s.script.buf[off] ?? 0;
    if (s.type === 'dynmem') return s.data[off] ?? 0;
    const arr = this.regArray(seg);
    if (arr) {
      const v = arr[off >> 1] ?? 0;
      return off & 1 ? (v >> 8) & 0xff : v & 0xff;
    }
    return 0;
  }

  writeByte(ptr: number, b: number): void {
    const seg = segOf(ptr);
    const off = offOf(ptr);
    const s = this.segments[seg];
    if (!s) return;
    if (s.type === 'script') {
      if (off < s.script.buf.length) s.script.buf[off] = b;
      return;
    }
    if (s.type === 'dynmem') {
      if (off < s.data.length) s.data[off] = b;
      return;
    }
    const arr = this.regArray(seg);
    if (arr) {
      const i = off >> 1;
      const v = offOf(arr[i] ?? 0);
      arr[i] = off & 1 ? (v & 0x00ff) | ((b & 0xff) << 8) : (v & 0xff00) | (b & 0xff);
    }
  }

  /** Reads a 16-bit word through a pointer (script data words, or register slots). */
  readWord(ptr: number): number {
    const seg = segOf(ptr);
    const arr = this.regArray(seg);
    if (arr) return arr[offOf(ptr) >> 1] ?? 0;
    return this.readByte(ptr) | (this.readByte(mk(seg, offOf(ptr) + 1)) << 8);
  }

  writeWord(ptr: number, v: number): void {
    const seg = segOf(ptr);
    const arr = this.regArray(seg);
    if (arr) {
      arr[offOf(ptr) >> 1] = v;
      return;
    }
    this.writeByte(ptr, v & 0xff);
    this.writeByte(mk(seg, offOf(ptr) + 1), (v >> 8) & 0xff);
  }

  getString(ptr: number): string {
    if (!ptr) return '';
    let s = '';
    for (let i = 0; i < 4096; i++) {
      const b = this.readByte(mk(segOf(ptr), offOf(ptr) + i));
      if (!b) break;
      s += String.fromCharCode(b);
    }
    return s;
  }

  setString(ptr: number, s: string): void {
    for (let i = 0; i < s.length; i++) this.writeByte(mk(segOf(ptr), offOf(ptr) + i), s.charCodeAt(i) & 0xff);
    this.writeByte(mk(segOf(ptr), offOf(ptr) + s.length), 0);
  }

  // ---------------------------------------------------------------- scripts

  getScript(nr: number): Script {
    const loaded = this.scriptsByNr.get(nr);
    if (loaded) return loaded;
    return this.loadScript(nr);
  }

  private loadScript(nr: number): Script {
    const data = this.res.get(ResType.Script, nr);
    if (!data) throw new SciError(`Script ${nr} not found`);
    const seg = this.allocSeg({ type: 'script', script: null as unknown as Script });
    const scr = new Script(nr, seg, data.slice());
    (this.segments[seg] as { type: 'script'; script: Script }).script = scr;
    this.scriptsByNr.set(nr, scr);
    const buf = scr.buf;

    // Pass 1: exports, synonyms, locals
    const relocations: number[] = [];
    for (let p = 0; p + 4 <= buf.length; ) {
      const type = scr.u16(p);
      if (type === 0) break;
      const size = scr.u16(p + 2);
      if (size < 4) break;
      if (type === 7) {
        const n = scr.u16(p + 4);
        scr.exports = [];
        for (let i = 0; i < n; i++) scr.exports.push(scr.u16(p + 6 + i * 2));
      } else if (type === 5) {
        for (let q = p + 4; q + 3 < p + size; q += 4) scr.synonyms.push({ replaceant: scr.u16(q), replacement: scr.u16(q + 2) });
      } else if (type === 10) {
        const count = (size - 4) >> 1;
        scr.locals = [];
        for (let i = 0; i < count; i++) scr.locals.push(scr.u16(p + 4 + i * 2));
        (scr as Script & { localsOffset: number }).localsOffset = p + 4;
        scr.localsSeg = this.allocSeg({ type: 'locals', script: scr });
      } else if (type === 8) {
        const n = scr.u16(p + 4);
        for (let i = 0; i < n; i++) relocations.push(scr.u16(p + 6 + i * 2));
      }
      p += size;
    }

    // Pass 2: objects and classes
    for (let p = 0; p + 4 <= buf.length; ) {
      const type = scr.u16(p);
      if (type === 0) break;
      const size = scr.u16(p + 2);
      if (size < 4) break;
      if (type === 1 || type === 6) {
        const pos = p + 12;
        if (type === 6) {
          const species = scr.u16(pos);
          while (this.classTable.length <= species) this.classTable.push({ script: nr, reg: 0 });
          this.classTable[species].reg = mk(seg, pos);
          this.classTable[species].script = nr;
        }
        this.initObject(scr, pos);
      }
      p += size;
    }

    // Relocate pointers in locals and object variables.
    const localsOffset = (scr as Script & { localsOffset?: number }).localsOffset ?? -1;
    for (const loc of relocations) {
      if (localsOffset >= 0 && loc >= localsOffset && loc < localsOffset + scr.locals.length * 2) {
        const i = (loc - localsOffset) >> 1;
        scr.locals[i] = mk(seg, scr.locals[i]);
        continue;
      }
      for (const [opos, obj] of scr.objects) {
        if (loc >= opos && loc < opos + obj.vars.length * 2 && !((loc - opos) & 1)) {
          const i = (loc - opos) >> 1;
          obj.vars[i] = mk(seg, offOf(obj.vars[i]));
          break;
        }
      }
    }
    return scr;
  }

  private initObject(scr: Script, pos: number): void {
    const varCount = scr.u16(pos - 2);
    const funcArea = scr.u16(pos - 4);
    const vars: number[] = [];
    for (let i = 0; i < varCount; i++) vars.push(scr.u16(pos + i * 2));
    const obj = new SciObject(mk(scr.seg, pos), scr, vars);
    if (vars[2] & INFO_CLASS) {
      for (let i = 0; i < varCount; i++) obj.baseVars.push(scr.u16(pos + varCount * 2 + i * 2));
    }
    const mb = pos + funcArea - 2;
    const count = scr.u16(mb);
    for (let i = 0; i < count; i++) {
      obj.methods.push({ sel: scr.u16(mb + 2 + i * 2), off: scr.u16(mb + 2 + (count + 1) * 2 + i * 2) });
    }
    scr.objects.set(pos, obj);
    this.objects.set(obj.pos, obj);
    // species & superclass: class numbers -> class addresses
    const species = vars[0];
    obj.vars[0] = species === 0xffff ? 0 : this.getClassAddress(species);
    const base = this.objects.get(obj.vars[0]);
    if (base && base !== obj) {
      // instances take their variable count from the class
      while (obj.vars.length < base.vars.length) obj.vars.push(0);
      obj.vars.length = base.vars.length;
    }
    const sup = vars[1];
    obj.vars[1] = sup === 0xffff ? 0 : this.getClassAddress(sup);
  }

  getClassAddress(species: number): number {
    const c = this.classTable[species];
    if (!c) throw new SciError(`Unknown class ${species}`);
    if (!c.reg) {
      this.getScript(c.script);
      if (!c.reg) throw new SciError(`Class ${species} not found in script ${c.script}`);
    }
    return c.reg;
  }

  disposeScript(nr: number): void {
    const scr = this.scriptsByNr.get(nr);
    if (!scr || nr === 0) return;
    for (const c of this.classTable) if (segOf(c.reg) === scr.seg) c.reg = 0;
    this.scriptsByNr.delete(nr);
    // A script whose code is still running (a room disposing itself) stays in memory until it returns;
    // it is forgotten either way, so loading it again gives fresh locals and objects.
    if (this.frames.some((f) => f.pcSeg === scr.seg || f.localSeg === scr.seg)) return;
    for (const obj of scr.objects.values()) this.objects.delete(obj.pos);
    this.segments[scr.seg] = null;
    if (scr.localsSeg) this.segments[scr.localsSeg] = null;
    this.scriptsByNr.delete(nr);
  }

  exportAddress(nr: number, index: number): number {
    const scr = this.getScript(nr);
    const off = scr.exports[index];
    if (off === undefined) throw new SciError(`Script ${nr} has no export ${index}`);
    return mk(scr.seg, off);
  }

  // ---------------------------------------------------------------- objects

  getObject(r: number): SciObject | undefined {
    return this.objects.get(r);
  }

  isObject(r: number): boolean {
    return this.objects.has(r);
  }

  private classOf(obj: SciObject): SciObject | undefined {
    return obj.isClass ? obj : this.objects.get(obj.superClass);
  }

  varIndex(obj: SciObject, sel: number): number {
    const cls = this.classOf(obj);
    if (!cls) return -1;
    return cls.baseVars.indexOf(sel);
  }

  /** Finds a method: returns [script, offset] or null. */
  findMethod(obj: SciObject, sel: number): { script: Script; off: number } | null {
    let o: SciObject | undefined = obj;
    for (let guard = 0; o && guard < 64; guard++) {
      const m = o.methods.find((x) => x.sel === sel);
      if (m) return { script: o.script, off: m.off };
      o = this.objects.get(o.superClass);
    }
    return null;
  }

  objectName(r: number): string {
    const o = this.objects.get(r);
    if (!o) return `<${segOf(r).toString(16)}:${offOf(r).toString(16)}>`;
    return this.getString(o.vars[3]) || '<anon>';
  }

  /** Reads a property by selector name (returns 0 if absent). */
  getSel(obj: number, name: string): number {
    const o = this.objects.get(obj);
    const id = this.sel(name);
    if (!o || id < 0) return 0;
    const i = this.varIndex(o, id);
    return i >= 0 ? o.vars[i] ?? 0 : 0;
  }

  setSel(obj: number, name: string, value: number): void {
    const o = this.objects.get(obj);
    const id = this.sel(name);
    if (!o || id < 0) return;
    const i = this.varIndex(o, id);
    if (i >= 0) o.vars[i] = value;
  }

  hasSel(obj: number, name: string): boolean {
    const o = this.objects.get(obj);
    const id = this.sel(name);
    if (!o || id < 0) return false;
    return this.varIndex(o, id) >= 0 || this.findMethod(o, id) !== null;
  }

  clone(r: number): number {
    const src = this.objects.get(r);
    if (!src) throw new SciError('Clone of non-object');
    // Offsets are 16-bit: wrap around and reuse freed ones (one Event clone is made every cycle).
    let pos = 0;
    for (let tries = 0; ; tries++) {
      if (tries > 0xffff) throw new SciError('Out of clone memory');
      const id = this.nextClone;
      this.nextClone = id >= 0xffff ? 1 : id + 1;
      pos = mk(this.cloneSeg, id);
      if (!this.objects.has(pos)) break;
    }
    const o = new SciObject(pos, src.script, src.vars.slice());
    o.methods = src.methods;
    o.baseVars = [];
    // A clone's species is the object it was cloned from if that was a class.
    o.vars[2] = (o.vars[2] & ~INFO_CLASS) | INFO_CLONE;
    o.vars[0] = src.pos; // species = what it was cloned from
    if (src.isClass) o.vars[1] = src.pos;
    this.objects.set(pos, o);
    return pos;
  }

  disposeClone(r: number): void {
    const o = this.objects.get(r);
    if (o && segOf(r) === this.cloneSeg && o.info & INFO_CLONE) this.objects.delete(r);
  }

  // ---------------------------------------------------------------- lists

  /** Next free 16-bit id in `map`, wrapping around. */
  private allocId(map: Map<number, unknown>, counter: 'nextList' | 'nextNode' | 'nextHunk'): number {
    for (let tries = 0; tries <= 0xffff; tries++) {
      const id = this[counter];
      this[counter] = id >= 0xffff ? 1 : id + 1;
      if (!map.has(id)) return id;
    }
    throw new SciError(`Out of memory (${counter})`);
  }

  freeNode(r: number): void {
    if (segOf(r) === this.nodeSeg) this.nodes.delete(offOf(r));
  }

  freeList(r: number): void {
    const l = this.list(r);
    if (!l) return;
    for (let n = l.first; n; ) {
      const next = this.node(n)?.succ ?? 0;
      this.freeNode(n);
      n = next;
    }
    this.lists.delete(offOf(r));
  }

  newList(): number {
    const id = this.allocId(this.lists, 'nextList');
    this.lists.set(id, { first: 0, last: 0 });
    return mk(this.listSeg, id);
  }

  newNode(value: number, key: number): number {
    const id = this.allocId(this.nodes, 'nextNode');
    this.nodes.set(id, { pred: 0, succ: 0, key, value });
    return mk(this.nodeSeg, id);
  }

  list(r: number): SciList | undefined {
    return segOf(r) === this.listSeg ? this.lists.get(offOf(r)) : undefined;
  }

  node(r: number): SciNode | undefined {
    return segOf(r) === this.nodeSeg ? this.nodes.get(offOf(r)) : undefined;
  }

  newHunk(value: unknown): number {
    const id = this.allocId(this.hunks, 'nextHunk');
    this.hunks.set(id, value);
    return mk(this.hunkSeg, id);
  }

  hunk<T>(r: number): T | undefined {
    return segOf(r) === this.hunkSeg ? (this.hunks.get(offOf(r)) as T) : undefined;
  }

  freeHunk(r: number): void {
    if (segOf(r) === this.hunkSeg) this.hunks.delete(offOf(r));
  }

  // ---------------------------------------------------------------- arithmetic

  private add(a: number, b: number): number {
    if (!isNum(a) && isNum(b)) return mk(segOf(a), offOf(a) + s16(b));
    if (isNum(a) && !isNum(b)) return mk(segOf(b), offOf(b) + s16(a));
    if (isNum(a) && isNum(b)) return num(s16(a) + s16(b));
    throw new SciError(`Invalid addition ${a.toString(16)} + ${b.toString(16)}`);
  }

  private sub(a: number, b: number): number {
    if (segOf(a) === segOf(b)) return num(s16(a) - s16(b));
    if (isNum(b)) return mk(segOf(a), offOf(a) - s16(b));
    throw new SciError(`Invalid subtraction ${a.toString(16)} - ${b.toString(16)}`);
  }

  private cmp(a: number, b: number, unsigned: boolean): number {
    if (segOf(a) === segOf(b)) {
      if (unsigned || !isNum(a)) return offOf(a) - offOf(b);
      return s16(a) - s16(b);
    }
    // Scripts compare pointers with small numbers to tell resources from strings.
    if (!isNum(a) && isNum(b) && offOf(b) <= 2000) return 1;
    if (!isNum(b) && isNum(a) && offOf(a) <= 2000) return -1;
    // Comparing a pointer to null (0) etc.
    return isNum(a) ? -1 : 1;
  }

  private requireNum(r: number): number {
    return r & 0xffff;
  }

  // ---------------------------------------------------------------- variables

  private varBlock(f: Frame, type: number): { arr: number[]; base: number; seg: number } {
    switch (type) {
      case 0:
        return { arr: this.globalsScript.locals, base: 0, seg: this.globalsScript.localsSeg };
      case 1: {
        const s = this.segments[f.localSeg];
        const scr = s && s.type === 'script' ? s.script : null;
        return { arr: scr ? scr.locals : [], base: 0, seg: scr ? scr.localsSeg : 0 };
      }
      case 2:
        return { arr: this.stack, base: f.fp, seg: this.stackSeg };
      default:
        return { arr: this.stack, base: f.argp, seg: this.stackSeg };
    }
  }

  private readVar(f: Frame, type: number, index: number): number {
    const b = this.varBlock(f, type);
    return b.arr[b.base + index] ?? 0;
  }

  private writeVar(f: Frame, type: number, index: number, v: number): void {
    const b = this.varBlock(f, type);
    if (b.base + index >= 0) b.arr[b.base + index] = v;
  }

  private property(f: Frame, index: number): { obj: SciObject; i: number } | null {
    const obj = this.objects.get(f.objp);
    if (!obj) throw new SciError(`Property access on disposed object ${this.objectName(f.objp)}`);
    const i = index >> 1;
    if (i < 0 || i >= obj.vars.length) return null;
    return { obj, i };
  }

  // ---------------------------------------------------------------- sends

  /** Pushes frames for a send; returns true if a method frame was pushed. */
  private sendSelector(sendObj: number, workObj: number, sp: number, frameSize: number, argp: number, origin: number): void {
    const obj = this.objects.get(sendObj);
    if (!obj) {
      throw new SciError(`Send to non-object ${segOf(sendObj).toString(16)}:${offOf(sendObj).toString(16)} (selector ${this.selectorNames[this.stack[argp]] ?? this.stack[argp]})`);
    }
    const newFrames: Frame[] = [];
    let curSp = sp;
    while (frameSize > 0) {
      const selector = this.requireNum(this.stack[argp]);
      argp++;
      const argc = this.requireNum(this.stack[argp]);
      if (argc > 0x800) throw new SciError('Too many arguments in send');
      if (this.traceSends) {
        const args = [];
        for (let i = 1; i <= argc; i++) args.push(this.fmt(this.stack[argp + i]));
        console.log(`send ${this.objectName(sendObj)}::${this.selectorNames[selector] ?? selector}(${args.join(', ')})`);
      }
      const vi = this.varIndex(obj, selector);
      if (vi >= 0) {
        newFrames.push({
          objp: workObj, sendp: sendObj, pcSeg: 0, pc: 0, localSeg: 0, sp: 0, fp: 0, argc, argp,
          tempCount: 0, type: VARSEL, varObj: sendObj, varIndex: vi, selector, origin,
        });
      } else {
        const m = this.findMethod(obj, selector);
        if (!m) {
          throw new SciError(`Send to invalid selector ${this.selectorNames[selector] ?? selector} of ${this.objectName(sendObj)}`);
        }
        newFrames.push({
          objp: workObj, sendp: sendObj, pcSeg: m.script.seg, pc: m.off, localSeg: m.script.seg, sp: curSp, fp: curSp,
          argc, argp, tempCount: 0, type: CALL, varObj: 0, varIndex: 0, selector, origin,
        });
        curSp = CARRY;
      }
      frameSize -= 2 + argc;
      argp += argc + 1;
    }
    // First selector executes first: push in reverse order.
    for (let i = newFrames.length - 1; i >= 0; i--) this.frames.push(newFrames[i]);
    this.execVarSelectors();
  }

  private execVarSelectors(): void {
    while (this.frames.length && this.frames[this.frames.length - 1].type === VARSEL) {
      const f = this.frames[this.frames.length - 1];
      this.doVarSel(f);
      this.frames.pop();
    }
  }

  private doVarSel(f: Frame): void {
    const o = this.objects.get(f.varObj);
    if (!o) return;
    if (f.argc) o.vars[f.varIndex] = this.stack[f.argp + 1];
    else this.acc = o.vars[f.varIndex];
  }

  private executeMethod(script: number, pubfunct: number, sp: number, callingObj: number, argc: number, argp: number): void {
    const scr = this.getScript(script);
    const off = scr.exports[pubfunct];
    if (off === undefined || off === 0) throw new SciError(`Invalid export ${pubfunct} of script ${script}`);
    this.frames.push({
      objp: callingObj, sendp: callingObj, pcSeg: scr.seg, pc: off, localSeg: scr.seg, sp, fp: sp, argc, argp,
      tempCount: 0, type: CALL, varObj: 0, varIndex: 0, selector: -1, origin: this.frames.length - 1,
    });
  }

  /** Calls a selector on an object from kernel code (nested VM run). Returns the accumulator. */
  invoke(obj: number, selName: string | number, ...args: number[]): number {
    const sel = typeof selName === 'number' ? selName : this.sel(selName);
    if (sel < 0) throw new SciError(`Unknown selector ${selName}`);
    // Build the send frame above the current stack top.
    const top = this.frames.length ? this.frames[this.frames.length - 1] : null;
    let base = top ? (top.sp === CARRY ? top.fp : top.sp) : 0;
    base = Math.max(base, this.highestSp()) + 1;
    this.stack[base] = sel;
    this.stack[base + 1] = args.length;
    for (let i = 0; i < args.length; i++) this.stack[base + 2 + i] = args[i];
    const savedAcc = this.acc;
    const depth = this.frames.length;
    this.sendSelector(obj, obj, base + 2 + args.length, 2 + args.length, base, depth - 1);
    if (this.frames.length > depth) {
      // a method frame was pushed; run it to completion
      this.runVM(depth);
    }
    const r = this.acc;
    if (typeof selName !== 'number' && this.varIndex(this.objects.get(obj)!, sel) >= 0) return r;
    void savedAcc;
    return r;
  }

  private highestSp(): number {
    let m = 0;
    for (const f of this.frames) {
      if (f.sp > m) m = f.sp;
      if (f.fp > m) m = f.fp;
    }
    return m;
  }

  // ---------------------------------------------------------------- execution

  /** Starts the game: sends `play` (or `replay` after a restore) to the game object (script 0, export 0). */
  startGame(selector: 'play' | 'replay' = 'play'): void {
    this.globalsScript = this.getScript(0);
    this.gameObject = this.exportAddress(0, 0);
    this.abort = null;
    this.rest = 0;
    const playSel = this.sel(selector);
    this.stack[0] = playSel;
    this.stack[1] = 0;
    this.frames = [];
    this.sendSelector(this.gameObject, this.gameObject, 2, 2, 0, -1);
  }

  // ---------------------------------------------------------------- save / restore

  /** Serializes the heap (scripts, objects, lists, strings) to a JSON-able value. */
  serialize(): unknown {
    const b64 = (u: Uint8Array) => {
      let s = '';
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return btoa(s);
    };
    const segs = this.segments.map((sg) => {
      if (!sg) return null;
      switch (sg.type) {
        case 'script':
          return { type: 'script', nr: sg.script.nr, buf: b64(sg.script.buf), locals: sg.script.locals, localsSeg: sg.script.localsSeg, exports: sg.script.exports, synonyms: sg.script.synonyms, lockers: sg.script.lockers };
        case 'locals':
          return { type: 'locals', scriptSeg: sg.script.seg };
        case 'dynmem':
          return { type: 'dynmem', data: b64(sg.data), desc: sg.desc };
        default:
          return { type: sg.type };
      }
    });
    const objects = [...this.objects.values()].map((o) => ({ pos: o.pos, seg: o.script.seg, vars: o.vars, baseVars: o.baseVars, methods: o.methods }));
    return {
      version: 1,
      segs,
      objects,
      classTable: this.classTable,
      lists: [...this.lists],
      nodes: [...this.nodes],
      next: [this.nextClone, this.nextList, this.nextNode, this.nextHunk],
      segIds: [this.stackSeg, this.cloneSeg, this.listSeg, this.nodeSeg, this.hunkSeg],
    };
  }

  /** Restores a serialized heap. The caller restarts execution with startGame('replay'). */
  deserialize(state: any): void {
    const unb64 = (s: string) => {
      const bin = atob(s);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    };
    this.segments = [];
    this.scriptsByNr.clear();
    this.objects.clear();
    const scripts = new Map<number, Script>();
    state.segs.forEach((d: any, i: number) => {
      if (!d) {
        this.segments[i] = null;
        return;
      }
      if (d.type === 'script') {
        const scr = new Script(d.nr, i, unb64(d.buf));
        scr.locals = d.locals;
        scr.localsSeg = d.localsSeg;
        scr.exports = d.exports;
        scr.synonyms = d.synonyms;
        scr.lockers = d.lockers;
        scripts.set(i, scr);
        this.scriptsByNr.set(d.nr, scr);
        this.segments[i] = { type: 'script', script: scr };
      } else if (d.type === 'dynmem') {
        this.segments[i] = { type: 'dynmem', data: unb64(d.data), desc: d.desc };
      } else if (d.type !== 'locals') {
        this.segments[i] = { type: d.type } as Segment;
      }
    });
    state.segs.forEach((d: any, i: number) => {
      if (d && d.type === 'locals') this.segments[i] = { type: 'locals', script: scripts.get(d.scriptSeg)! };
    });
    for (const o of state.objects) {
      const scr = scripts.get(o.seg);
      if (!scr) continue;
      const obj = new SciObject(o.pos, scr, o.vars);
      obj.baseVars = o.baseVars;
      obj.methods = o.methods;
      this.objects.set(o.pos, obj);
      if (segOf(o.pos) === scr.seg) scr.objects.set(offOf(o.pos), obj);
    }
    this.classTable = state.classTable;
    this.lists = new Map(state.lists);
    this.nodes = new Map(state.nodes);
    [this.nextClone, this.nextList, this.nextNode, this.nextHunk] = state.next;
    [this.stackSeg, this.cloneSeg, this.listSeg, this.nodeSeg, this.hunkSeg] = state.segIds;
    this.hunks.clear();
    this.frames = [];
    this.stack.fill(0);
    this.globalsScript = this.scriptsByNr.get(0)!;
  }

  /** True while the game still has code to run. */
  get running(): boolean {
    return this.frames.length > 0;
  }

  /**
   * Runs bytecode until the frame stack drops back to `baseDepth` frames, or (for the top-level
   * runner, baseDepth 0) until a kernel call asks to yield or the budget runs out.
   */
  runVM(baseDepth = 0, budget = Infinity): void {
    this.runDepth++;
    const topLevel = this.runDepth === 1;
    try {
      let steps = 0;
      while (this.frames.length > baseDepth) {
        if (this.abort) return;
        if (topLevel && (this.yieldRequested || steps >= budget)) return;
        steps++;
        this.step(baseDepth);
      }
    } finally {
      this.runDepth--;
    }
  }

  private fetch(scr: Script, f: Frame, kind: string, ext: number): number {
    const b = scr.buf;
    switch (kind) {
      case 'b':
        return b[f.pc++];
      case 'B':
        return (b[f.pc++] << 24) >> 24;
      case 'w': {
        const v = b[f.pc] | (b[f.pc + 1] << 8);
        f.pc += 2;
        return v;
      }
      case 'v':
        if (ext & 1) return b[f.pc++];
        else {
          const v = b[f.pc] | (b[f.pc + 1] << 8);
          f.pc += 2;
          return v;
        }
      case 'V':
      case 'R':
        if (ext & 1) return (b[f.pc++] << 24) >> 24;
        else {
          const v = ((b[f.pc] | (b[f.pc + 1] << 8)) << 16) >> 16;
          f.pc += 2;
          return v;
        }
    }
    return 0;
  }

  private step(baseDepth: number): void {
    const f = this.frames[this.frames.length - 1];
    const seg = this.segments[f.pcSeg];
    if (!seg || seg.type !== 'script') throw new SciError('PC in non-script segment');
    const scr = seg.script;
    const stack = this.stack;
    const at = f.pc;
    const ext = scr.buf[f.pc++];
    const op = ext >> 1;
    const fmt = FORMATS[op];
    const p0 = fmt.length > 0 ? this.fetch(scr, f, fmt[0], ext) : 0;
    const p1 = fmt.length > 1 ? this.fetch(scr, f, fmt[1], ext) : 0;
    const p2 = fmt.length > 2 ? this.fetch(scr, f, fmt[2], ext) : 0;
    this.instructionCount++;
    if (this.trace) console.log(`[${scr.nr}:${at.toString(16)}] ${OPCODE_NAMES[op] ?? op.toString(16)} ${p0} ${p1} ${p2}  acc=${this.fmt(this.acc)} sp=${f.sp}`);


    switch (op) {
      case 0x00: this.acc = num(0xffff ^ this.requireNum(this.acc)); break;
      case 0x01: this.acc = this.add(stack[--f.sp], this.acc); break;
      case 0x02: this.acc = this.sub(stack[--f.sp], this.acc); break;
      case 0x03: this.acc = num(s16(stack[--f.sp]) * s16(this.acc)); break;
      case 0x04: {
        const d = s16(this.acc);
        const a = s16(stack[--f.sp]);
        this.acc = d === 0 ? 0 : num(Math.trunc(a / d));
        break;
      }
      case 0x05: {
        const m = Math.abs(s16(this.acc));
        const a = s16(stack[--f.sp]);
        let r = m === 0 ? 0 : a % m;
        if (r < 0) r += m;
        this.acc = num(r);
        break;
      }
      case 0x06: this.acc = num(offOf(stack[--f.sp]) >>> offOf(this.acc)); break;
      case 0x07: this.acc = num(offOf(stack[--f.sp]) << offOf(this.acc)); break;
      case 0x08: this.acc = num(offOf(stack[--f.sp]) ^ offOf(this.acc)); break;
      case 0x09: this.acc = num(offOf(stack[--f.sp]) & offOf(this.acc)); break;
      case 0x0a: this.acc = num(offOf(stack[--f.sp]) | offOf(this.acc)); break;
      case 0x0b: this.acc = num(-s16(this.acc)); break;
      case 0x0c: this.acc = this.acc === 0 ? 1 : 0; break;
      case 0x0d: { this.prev = this.acc; this.acc = stack[--f.sp] === this.acc ? 1 : 0; break; }
      case 0x0e: { this.prev = this.acc; this.acc = stack[--f.sp] !== this.acc ? 1 : 0; break; }
      case 0x0f: { this.prev = this.acc; this.acc = this.cmp(stack[--f.sp], this.acc, false) > 0 ? 1 : 0; break; }
      case 0x10: { this.prev = this.acc; this.acc = this.cmp(stack[--f.sp], this.acc, false) >= 0 ? 1 : 0; break; }
      case 0x11: { this.prev = this.acc; this.acc = this.cmp(stack[--f.sp], this.acc, false) < 0 ? 1 : 0; break; }
      case 0x12: { this.prev = this.acc; this.acc = this.cmp(stack[--f.sp], this.acc, false) <= 0 ? 1 : 0; break; }
      case 0x13: { this.prev = this.acc; this.acc = this.cmp(stack[--f.sp], this.acc, true) > 0 ? 1 : 0; break; }
      case 0x14: { this.prev = this.acc; this.acc = this.cmp(stack[--f.sp], this.acc, true) >= 0 ? 1 : 0; break; }
      case 0x15: { this.prev = this.acc; this.acc = this.cmp(stack[--f.sp], this.acc, true) < 0 ? 1 : 0; break; }
      case 0x16: { this.prev = this.acc; this.acc = this.cmp(stack[--f.sp], this.acc, true) <= 0 ? 1 : 0; break; }
      case 0x17: if (this.acc !== 0) f.pc += p0; break;
      case 0x18: if (this.acc === 0) f.pc += p0; break;
      case 0x19: f.pc += p0; break;
      case 0x1a: this.acc = num(p0); break;
      case 0x1b: stack[f.sp++] = this.acc; break;
      case 0x1c: stack[f.sp++] = num(p0); break;
      case 0x1d: f.sp--; break;
      case 0x1e: { const v = stack[f.sp - 1]; stack[f.sp++] = v; break; }
      case 0x1f: // link
        f.tempCount = p0;
        for (let i = 0; i < p0; i++) stack[f.sp + i] = 0;
        f.sp += p0;
        break;
      case 0x20: { // call (local)
        const argc = (p1 >> 1) + 1 + this.rest;
        const callBase = f.sp - argc;
        const finalArgc = this.requireNum(stack[callBase]) + this.rest;
        stack[callBase] = finalArgc;
        this.frames.push({
          objp: f.objp, sendp: f.sendp, pcSeg: f.pcSeg, pc: f.pc + p0, localSeg: f.localSeg, sp: f.sp, fp: f.sp,
          argc: finalArgc, argp: callBase, tempCount: 0, type: CALL, varObj: 0, varIndex: 0, selector: -1,
          origin: this.frames.length - 1,
        });
        this.rest = 0;
        f.sp = callBase;
        break;
      }
      case 0x21: { // callk
        f.sp -= (p1 >> 1) + 1;
        f.sp -= this.rest;
        const argc = this.requireNum(stack[f.sp]) + this.rest;
        this.rest = 0;
        const args: number[] = [];
        for (let i = 1; i <= argc; i++) args.push(stack[f.sp + i]);
        this.callKernel(p0, args);
        break;
      }
      case 0x22: { // callb
        const temp = (p1 >> 1) + this.rest + 1;
        const sTemp = f.sp;
        f.sp -= temp;
        stack[f.sp] = num(stack[f.sp] + this.rest);
        this.rest = 0;
        this.executeMethod(0, p0, sTemp, f.objp, offOf(stack[f.sp]), f.sp);
        break;
      }
      case 0x23: { // calle
        const temp = (p2 >> 1) + this.rest + 1;
        const sTemp = f.sp;
        f.sp -= temp;
        stack[f.sp] = num(stack[f.sp] + this.rest);
        this.rest = 0;
        this.executeMethod(p0, p1, sTemp, f.objp, offOf(stack[f.sp]), f.sp);
        break;
      }
      case 0x24: // ret
        this.ret(baseDepth);
        break;
      case 0x25: { // send
        const sTemp = f.sp;
        f.sp -= (p0 >> 1) + this.rest;
        stack[f.sp + 1] = num(stack[f.sp + 1] + this.rest);
        const size = (p0 >> 1) + this.rest;
        this.rest = 0;
        this.sendSelector(this.acc, this.acc, sTemp, size, f.sp, this.frames.length - 1);
        break;
      }
      case 0x28: this.acc = this.getClassAddress(p0); break;
      case 0x2a: { // self
        const sTemp = f.sp;
        f.sp -= (p0 >> 1) + this.rest;
        stack[f.sp + 1] = num(stack[f.sp + 1] + this.rest);
        const size = (p0 >> 1) + this.rest;
        this.rest = 0;
        this.sendSelector(f.objp, f.objp, sTemp, size, f.sp, this.frames.length - 1);
        break;
      }
      case 0x2b: { // super
        const cls = this.getClassAddress(p0);
        const sTemp = f.sp;
        f.sp -= (p1 >> 1) + this.rest;
        stack[f.sp + 1] = num(stack[f.sp + 1] + this.rest);
        const size = (p1 >> 1) + this.rest;
        this.rest = 0;
        this.sendSelector(cls, f.objp, sTemp, size, f.sp, this.frames.length - 1);
        break;
      }
      case 0x2c: { // &rest
        let t = offOf(p0);
        this.rest = Math.max(f.argc - t + 1, 0);
        for (; t <= f.argc; t++) stack[f.sp++] = stack[f.argp + t];
        break;
      }
      case 0x2d: { // lea
        const t = (p0 & 0xffff) >> 1;
        const type = t & 3;
        const blk = this.varBlock(f, type);
        let index = blk.base;
        if (t & 0x08) index += s16(this.acc);
        index += p1;
        this.acc = mk(blk.seg, index * 2);
        break;
      }
      case 0x2e: this.acc = f.objp; break;
      case 0x30: stack[f.sp++] = this.prev; break;
      case 0x31: { const p = this.property(f, p0); this.acc = p ? p.obj.vars[p.i] : 0; break; }
      case 0x32: { const p = this.property(f, p0); if (p) p.obj.vars[p.i] = this.acc; break; }
      case 0x33: { const p = this.property(f, p0); stack[f.sp++] = p ? p.obj.vars[p.i] : 0; break; }
      case 0x34: { const v = stack[--f.sp]; const p = this.property(f, p0); if (p) p.obj.vars[p.i] = v; break; }
      case 0x35: case 0x36: case 0x37: case 0x38: {
        const p = this.property(f, p0);
        let v = 0;
        if (p) {
          v = op & 1 ? this.add(p.obj.vars[p.i], 1) : this.sub(p.obj.vars[p.i], 1);
          p.obj.vars[p.i] = v;
        }
        if (op === 0x35 || op === 0x36) this.acc = v;
        else stack[f.sp++] = v;
        break;
      }
      case 0x39: this.acc = mk(f.pcSeg, f.pc + p0); break;
      case 0x3a: stack[f.sp++] = mk(f.pcSeg, f.pc + p0); break;
      case 0x3b: stack[f.sp++] = 0; break;
      case 0x3c: stack[f.sp++] = 1; break;
      case 0x3d: stack[f.sp++] = 2; break;
      case 0x3e: stack[f.sp++] = f.objp; break;
      case 0x3f: break; // line (debug)
      default:
        if (op >= 0x40) {
          this.varOp(f, op, p0);
          break;
        }
        throw new SciError(`Invalid opcode 0x${op.toString(16)} in script ${scr.nr} at ${at.toString(16)}`);
    }
  }

  private varOp(f: Frame, op: number, p0: number): void {
    const type = op & 3;
    const group = (op >> 2) & 0x1f; // 0x10.. groups of 4
    // 0x40 la, 0x44 ls, 0x48 lai, 0x4c lsi, 0x50 sa, 0x54 ss, 0x58 sai, 0x5c ssi,
    // 0x60 plusa, 0x64 pluss, 0x68 plusai, 0x6c plussi, 0x70 minusa, 0x74 minuss, 0x78 minusai, 0x7c minussi
    const kind = group - 0x10;
    const indexed = (kind & 2) !== 0;
    const index = p0 + (indexed ? s16(this.acc) : 0);
    const stack = this.stack;
    switch (kind) {
      case 0: case 2: this.acc = this.readVar(f, type, index); break;
      case 1: case 3: stack[f.sp++] = this.readVar(f, type, index); break;
      case 4: this.writeVar(f, type, index, this.acc); break;
      case 6: this.acc = stack[--f.sp]; this.writeVar(f, type, index, this.acc); break;
      case 5: case 7: this.writeVar(f, type, index, stack[--f.sp]); break;
      case 8: case 10: this.acc = this.add(this.readVar(f, type, index), 1); this.writeVar(f, type, index, this.acc); break;
      case 9: case 11: { const v = this.add(this.readVar(f, type, index), 1); this.writeVar(f, type, index, v); stack[f.sp++] = v; break; }
      case 12: case 14: this.acc = this.sub(this.readVar(f, type, index), 1); this.writeVar(f, type, index, this.acc); break;
      case 13: case 15: { const v = this.sub(this.readVar(f, type, index), 1); this.writeVar(f, type, index, v); stack[f.sp++] = v; break; }
    }
  }

  private ret(baseDepth: number): void {
    for (;;) {
      const old = this.frames[this.frames.length - 1];
      const oldSp = old.sp;
      if (this.frames.length - 1 === baseDepth) {
        this.frames.pop();
        return; // hard return to the kernel/runner that started this run
      }
      if (old.type === VARSEL) this.doVarSel(old);
      this.frames.pop();
      const cur = this.frames[this.frames.length - 1];
      if (cur.sp === CARRY || cur.type !== CALL) {
        cur.sp = oldSp;
        cur.fp = oldSp;
      }
      if (cur.type !== VARSEL) return;
    }
  }

  private callKernel(n: number, args: number[]): void {
    const fn = this.kernel[n];
    const name = this.kernelNames[n] ?? `#${n}`;
    if (!fn) {
      if (this.stubMissing) {
        if (!this.warnedKernel.has(name)) {
          this.warnedKernel.add(name);
          console.warn(`[stub] kernel ${name}(${args.map((a) => this.fmt(a)).join(', ')}) not implemented; returning 0`);
        }
        this.acc = 0;
        return;
      }
      throw new SciError(`Kernel function ${name} is not implemented (args: ${args.map((a) => this.fmt(a)).join(', ')})`);
    }
    if (this.trace) console.log(`  kernel ${name}(${args.map((a) => this.fmt(a)).join(', ')})`);
    const r = fn(this, args);
    if (r !== undefined) this.acc = r;
  }

  fmt(r: number): string {
    if (isNum(r)) return String(s16(r));
    if (this.objects.has(r)) return this.objectName(r);
    return `${segOf(r).toString(16)}:${offOf(r).toString(16).padStart(4, '0')}`;
  }

  /** Current call stack, for error reports. */
  backtrace(): string {
    return this.frames
      .map((f) => {
        const s = this.segments[f.pcSeg];
        const nr = s && s.type === 'script' ? s.script.nr : '?';
        const sel = f.selector >= 0 ? this.selectorNames[f.selector] : 'call';
        return `${this.objectName(f.objp)}::${sel} @${nr}:${f.pc.toString(16)}`;
      })
      .reverse()
      .join('\n');
  }
}
