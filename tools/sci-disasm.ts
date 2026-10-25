// SCI0 script disassembler. Usage: tsx tools/sci-disasm.ts <script nr>   (GAME=dir)
import { SciResources, ResType } from '../src/sci/resource';
import { FORMATS, OPCODE_NAMES } from '../src/sci/vm';
import { loadGameDir } from './png';

const res = new SciResources(loadGameDir(process.env.GAME ?? 'public/games/sq3'));
const nr = Number(process.argv[2]);
const b = res.get(ResType.Script, nr)!;
const sel = (() => {
  const v = res.get(ResType.Vocab, 997);
  if (!v) return [] as string[];
  const n = v[0] | (v[1] << 8);
  const out: string[] = [];
  for (let i = 0; i <= n; i++) {
    const o = v[2 + i * 2] | (v[3 + i * 2] << 8);
    const len = v[o] | (v[o + 1] << 8);
    out.push(String.fromCharCode(...v.subarray(o + 2, o + 2 + len)));
  }
  return out;
})();
const kern = (() => {
  const v = res.get(ResType.Vocab, 999);
  if (!v) return [] as string[];
  const n = v[0] | (v[1] << 8);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const o = v[2 + i * 2] | (v[3 + i * 2] << 8);
    const len = v[o] | (v[o + 1] << 8);
    out.push(String.fromCharCode(...v.subarray(o + 2, o + 2 + len)));
  }
  return out;
})();
const u16 = (p: number) => b[p] | (b[p + 1] << 8);
let p = 0;
while (p < b.length) {
  const type = u16(p);
  if (type === 0) break;
  const size = u16(p + 2);
  if (type === 1 || type === 6) {
    // object/class: show name and method selectors
    const nameOff = u16(p + 4 + 8 + 6);
    console.log(`\n--- ${type === 6 ? 'class' : 'object'} @${p.toString(16)}`);
  }
  if (type === 2) {
    console.log(`\n--- code ${(p + 4).toString(16)}..${(p + size).toString(16)}`);
    let pc = p + 4;
    while (pc < p + size) {
      const at = pc;
      const ext = b[pc++];
      const op = ext >> 1;
      const fmt = FORMATS[op] ?? '';
      const args: number[] = [];
      for (const k of fmt) {
        if (k === 'b') args.push(b[pc++]);
        else if (k === 'B') args.push((b[pc++] << 24) >> 24);
        else if (k === 'w') { args.push(u16(pc)); pc += 2; }
        else if (k === 'v') { if (ext & 1) args.push(b[pc++]); else { args.push(u16(pc)); pc += 2; } }
        else { if (ext & 1) args.push((b[pc++] << 24) >> 24); else { args.push((u16(pc) << 16) >> 16); pc += 2; } }
      }
      const name = OPCODE_NAMES[op] ?? `op${op.toString(16)}`;
      let note = '';
      if (name === 'callk') note = ` ; ${kern[args[0]]}`;
      if (name === 'pushi' || name === 'ldi') note = args[0] < sel.length ? ` ; ${sel[args[0]]}?` : '';
      if (/^(bt|bnt|jmp|call)$/.test(name)) note = ` ; -> ${(pc + args[0]).toString(16)}`;
      console.log(`${at.toString(16).padStart(4)}: ${name} ${args.join(' ')}${note}`);
    }
  }
  p += size;
}
