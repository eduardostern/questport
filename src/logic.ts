// AGI logic resources: bytecode plus an encrypted message table.

import { decrypt } from './resources';

export interface Logic {
  code: Uint8Array;
  messages: (string | null)[]; // 1-based: messages[1] is message #1
}

export function decodeLogic(d: Uint8Array): Logic {
  const msgOff = (d[0] | (d[1] << 8)) + 2;
  const code = d.slice(2, msgOff);
  const messages: (string | null)[] = [null];
  if (msgOff < d.length) {
    const num = d[msgOff];
    const base = msgOff + 1; // offsets are relative to this
    const textStart = msgOff + 3 + num * 2;
    const data = d.slice();
    decrypt(data, textStart, data.length);
    for (let i = 0; i < num; i++) {
      const o = data[msgOff + 3 + i * 2] | (data[msgOff + 4 + i * 2] << 8);
      if (o === 0) {
        messages.push(null);
        continue;
      }
      let s = '';
      for (let p = base + o; p < data.length && data[p] !== 0; p++) s += String.fromCharCode(data[p]);
      messages.push(s);
    }
  }
  return { code, messages };
}

// Argument kinds: n = number, v = variable, f = flag, m = message, o = object (screen object), i = inventory item, s = string, c = controller
export interface OpInfo {
  name: string;
  args: string;
}

export const TEST_OPS: OpInfo[] = [
  { name: 'return.false', args: '' },
  { name: 'equaln', args: 'vn' },
  { name: 'equalv', args: 'vv' },
  { name: 'lessn', args: 'vn' },
  { name: 'lessv', args: 'vv' },
  { name: 'greatern', args: 'vn' },
  { name: 'greaterv', args: 'vv' },
  { name: 'isset', args: 'f' },
  { name: 'issetv', args: 'v' },
  { name: 'has', args: 'i' },
  { name: 'obj.in.room', args: 'iv' },
  { name: 'posn', args: 'onnnn' },
  { name: 'controller', args: 'c' },
  { name: 'have.key', args: '' },
  { name: 'said', args: '' }, // variable length
  { name: 'compare.strings', args: 'ss' },
  { name: 'obj.in.box', args: 'onnnn' },
  { name: 'center.posn', args: 'onnnn' },
  { name: 'right.posn', args: 'onnnn' },
];

export const ACTION_OPS: OpInfo[] = [
  { name: 'return', args: '' },
  { name: 'increment', args: 'v' },
  { name: 'decrement', args: 'v' },
  { name: 'assignn', args: 'vn' },
  { name: 'assignv', args: 'vv' },
  { name: 'addn', args: 'vn' },
  { name: 'addv', args: 'vv' },
  { name: 'subn', args: 'vn' },
  { name: 'subv', args: 'vv' },
  { name: 'lindirectv', args: 'vv' },
  { name: 'rindirect', args: 'vv' },
  { name: 'lindirectn', args: 'vn' },
  { name: 'set', args: 'f' },
  { name: 'reset', args: 'f' },
  { name: 'toggle', args: 'f' },
  { name: 'set.v', args: 'v' },
  { name: 'reset.v', args: 'v' },
  { name: 'toggle.v', args: 'v' },
  { name: 'new.room', args: 'n' },
  { name: 'new.room.v', args: 'v' },
  { name: 'load.logics', args: 'n' },
  { name: 'load.logics.v', args: 'v' },
  { name: 'call', args: 'n' },
  { name: 'call.v', args: 'v' },
  { name: 'load.pic', args: 'v' },
  { name: 'draw.pic', args: 'v' },
  { name: 'show.pic', args: '' },
  { name: 'discard.pic', args: 'v' },
  { name: 'overlay.pic', args: 'v' },
  { name: 'show.pri.screen', args: '' },
  { name: 'load.view', args: 'n' },
  { name: 'load.view.v', args: 'v' },
  { name: 'discard.view', args: 'n' },
  { name: 'animate.obj', args: 'o' },
  { name: 'unanimate.all', args: '' },
  { name: 'draw', args: 'o' },
  { name: 'erase', args: 'o' },
  { name: 'position', args: 'onn' },
  { name: 'position.v', args: 'ovv' },
  { name: 'get.posn', args: 'ovv' },
  { name: 'reposition', args: 'ovv' },
  { name: 'set.view', args: 'on' },
  { name: 'set.view.v', args: 'ov' },
  { name: 'set.loop', args: 'on' },
  { name: 'set.loop.v', args: 'ov' },
  { name: 'fix.loop', args: 'o' },
  { name: 'release.loop', args: 'o' },
  { name: 'set.cel', args: 'on' },
  { name: 'set.cel.v', args: 'ov' },
  { name: 'last.cel', args: 'ov' },
  { name: 'current.cel', args: 'ov' },
  { name: 'current.loop', args: 'ov' },
  { name: 'current.view', args: 'ov' },
  { name: 'number.of.loops', args: 'ov' },
  { name: 'set.priority', args: 'on' },
  { name: 'set.priority.v', args: 'ov' },
  { name: 'release.priority', args: 'o' },
  { name: 'get.priority', args: 'ov' },
  { name: 'stop.update', args: 'o' },
  { name: 'start.update', args: 'o' },
  { name: 'force.update', args: 'o' },
  { name: 'ignore.horizon', args: 'o' },
  { name: 'observe.horizon', args: 'o' },
  { name: 'set.horizon', args: 'n' },
  { name: 'object.on.water', args: 'o' },
  { name: 'object.on.land', args: 'o' },
  { name: 'object.on.anything', args: 'o' },
  { name: 'ignore.objs', args: 'o' },
  { name: 'observe.objs', args: 'o' },
  { name: 'distance', args: 'oov' },
  { name: 'stop.cycling', args: 'o' },
  { name: 'start.cycling', args: 'o' },
  { name: 'normal.cycle', args: 'o' },
  { name: 'end.of.loop', args: 'of' },
  { name: 'reverse.cycle', args: 'o' },
  { name: 'reverse.loop', args: 'of' },
  { name: 'cycle.time', args: 'ov' },
  { name: 'stop.motion', args: 'o' },
  { name: 'start.motion', args: 'o' },
  { name: 'step.size', args: 'ov' },
  { name: 'step.time', args: 'ov' },
  { name: 'move.obj', args: 'onnnf' },
  { name: 'move.obj.v', args: 'ovvvf' },
  { name: 'follow.ego', args: 'onf' },
  { name: 'wander', args: 'o' },
  { name: 'normal.motion', args: 'o' },
  { name: 'set.dir', args: 'ov' },
  { name: 'get.dir', args: 'ov' },
  { name: 'ignore.blocks', args: 'o' },
  { name: 'observe.blocks', args: 'o' },
  { name: 'block', args: 'nnnn' },
  { name: 'unblock', args: '' },
  { name: 'get', args: 'i' },
  { name: 'get.v', args: 'v' },
  { name: 'drop', args: 'i' },
  { name: 'put', args: 'iv' },
  { name: 'put.v', args: 'vv' },
  { name: 'get.room.v', args: 'vv' },
  { name: 'load.sound', args: 'n' },
  { name: 'sound', args: 'nf' },
  { name: 'stop.sound', args: '' },
  { name: 'print', args: 'm' },
  { name: 'print.v', args: 'v' },
  { name: 'display', args: 'nnm' },
  { name: 'display.v', args: 'vvv' },
  { name: 'clear.lines', args: 'nnn' },
  { name: 'text.screen', args: '' },
  { name: 'graphics', args: '' },
  { name: 'set.cursor.char', args: 'm' },
  { name: 'set.text.attribute', args: 'nn' },
  { name: 'shake.screen', args: 'n' },
  { name: 'configure.screen', args: 'nnn' },
  { name: 'status.line.on', args: '' },
  { name: 'status.line.off', args: '' },
  { name: 'set.string', args: 'sm' },
  { name: 'get.string', args: 'smnnn' },
  { name: 'word.to.string', args: 'sn' },
  { name: 'parse', args: 's' },
  { name: 'get.num', args: 'mv' },
  { name: 'prevent.input', args: '' },
  { name: 'accept.input', args: '' },
  { name: 'set.key', args: 'nnc' },
  { name: 'add.to.pic', args: 'nnnnnnn' },
  { name: 'add.to.pic.v', args: 'vvvvvvv' },
  { name: 'status', args: '' },
  { name: 'save.game', args: '' },
  { name: 'restore.game', args: '' },
  { name: 'init.disk', args: '' },
  { name: 'restart.game', args: '' },
  { name: 'show.obj', args: 'n' },
  { name: 'random', args: 'nnv' },
  { name: 'program.control', args: '' },
  { name: 'player.control', args: '' },
  { name: 'obj.status.v', args: 'v' },
  { name: 'quit', args: 'n' },
  { name: 'show.mem', args: '' },
  { name: 'pause', args: '' },
  { name: 'echo.line', args: '' },
  { name: 'cancel.line', args: '' },
  { name: 'init.joy', args: '' },
  { name: 'toggle.monitor', args: '' },
  { name: 'version', args: '' },
  { name: 'script.size', args: 'n' },
  { name: 'set.game.id', args: 'm' },
  { name: 'log', args: 'm' },
  { name: 'set.scan.start', args: '' },
  { name: 'reset.scan.start', args: '' },
  { name: 'reposition.to', args: 'onn' },
  { name: 'reposition.to.v', args: 'ovv' },
  { name: 'trace.on', args: '' },
  { name: 'trace.info', args: 'nnn' },
  { name: 'print.at', args: 'mnnn' },
  { name: 'print.at.v', args: 'vnnn' },
  { name: 'discard.view.v', args: 'v' },
  { name: 'clear.text.rect', args: 'nnnnn' },
  { name: 'set.upper.left', args: 'nn' },
  { name: 'set.menu', args: 'm' },
  { name: 'set.menu.item', args: 'mc' },
  { name: 'submit.menu', args: '' },
  { name: 'enable.item', args: 'c' },
  { name: 'disable.item', args: 'c' },
  { name: 'menu.input', args: '' },
  { name: 'show.obj.v', args: 'v' },
  { name: 'open.dialogue', args: '' },
  { name: 'close.dialogue', args: '' },
  { name: 'mul.n', args: 'vn' },
  { name: 'mul.v', args: 'vv' },
  { name: 'div.n', args: 'vn' },
  { name: 'div.v', args: 'vv' },
  { name: 'close.window', args: '' },
];

const BASE_OPS = { 134: ACTION_OPS[134], 151: ACTION_OPS[151], 152: ACTION_OPS[152] };

/** Some opcodes take fewer arguments in older interpreter versions. */
export function applyVersionQuirks(version: number): void {
  Object.assign(ACTION_OPS, BASE_OPS);
  if (version <= 0x2089) {
    ACTION_OPS[134] = { name: 'quit', args: '' };
  }
  if (version < 0x2400) {
    ACTION_OPS[151] = { name: 'print.at', args: 'mnn' };
    ACTION_OPS[152] = { name: 'print.at.v', args: 'vnn' };
  }
}

/**
 * Guesses the interpreter version by decoding every logic script with each candidate
 * opcode table and keeping the newest one under which all scripts parse cleanly.
 */
export function detectVersion(logics: Logic[]): number {
  for (const v of [0x2917, 0x2440, 0x2089]) {
    applyVersionQuirks(v);
    try {
      for (const l of logics) disassemble(l);
      return v;
    } catch {
      /* try an older table */
    }
  }
  applyVersionQuirks(0x2917);
  return 0x2917;
}

/** Human-readable disassembly, used for debugging and for verifying the opcode table. */
export function disassemble(logic: Logic): string[] {
  const c = logic.code;
  const out: string[] = [];
  let p = 0;
  const args = (spec: string) => {
    const a: string[] = [];
    for (const k of spec) a.push(k === 'n' ? String(c[p++]) : k + c[p++]);
    return a.join(', ');
  };
  while (p < c.length) {
    const at = p;
    const op = c[p++];
    if (op === 0xff) {
      const conds: string[] = [];
      while (p < c.length && c[p] !== 0xff) {
        const t = c[p++];
        if (t === 0xfc) conds.push('||');
        else if (t === 0xfd) conds.push('!');
        else if (t === 0x0e) {
          const n = c[p++];
          const w: number[] = [];
          for (let i = 0; i < n; i++, p += 2) w.push(c[p] | (c[p + 1] << 8));
          conds.push(`said(${w.join(',')})`);
        } else if (t < TEST_OPS.length) {
          conds.push(`${TEST_OPS[t].name}(${args(TEST_OPS[t].args)})`);
        } else throw new Error(`bad test op ${t} at ${p - 1}`);
      }
      p++;
      const size = c[p] | (c[p + 1] << 8);
      p += 2;
      out.push(`${at}: if (${conds.join(' ')}) { [${size} -> ${p + size}]`);
    } else if (op === 0xfe) {
      const off = (c[p] | (c[p + 1] << 8)) << 16 >> 16;
      p += 2;
      out.push(`${at}: goto ${p + off}`);
    } else if (op < ACTION_OPS.length) {
      out.push(`${at}: ${ACTION_OPS[op].name}(${args(ACTION_OPS[op].args)})`);
    } else throw new Error(`bad action op ${op} at ${at}`);
  }
  if (p !== c.length) throw new Error(`overran code: ${p} vs ${c.length}`);
  return out;
}
