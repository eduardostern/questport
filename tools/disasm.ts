import { ResourceManager } from '../src/resources';
import { decodeLogic, disassemble, applyVersionQuirks, ACTION_OPS } from '../src/logic';
import { loadGameDir } from './png';

const res = new ResourceManager(loadGameDir(process.env.GAME ?? 'public/games/sq1'));
const ver = parseInt(process.env.AGIVER ?? '2089', 16);
applyVersionQuirks(ver);
const only = process.argv[2];
let ok = 0, bad = 0;
const used = new Map<string, number>();
for (let i = 0; i < res.count('logic'); i++) {
  if (!res.exists('logic', i) || (only && Number(only) !== i)) continue;
  const l = decodeLogic(res.load('logic', i));
  try {
    const lines = disassemble(l);
    for (const ln of lines) { const m = ln.match(/: ([a-z.]+)\(/); if (m) used.set(m[1], (used.get(m[1]) ?? 0) + 1); }
    if (only) { console.log(lines.join('\n')); l.messages.forEach((m, k) => m && console.log(`#${k}: ${JSON.stringify(m)}`)); }
    ok++;
  } catch (e) { bad++; console.log(`logic ${i}: ${(e as Error).message}`); }
}
console.log(`ok ${ok}, failed ${bad}`);
if (!only) console.log('unused:', ACTION_OPS.map(o => o.name).filter(n => !used.has(n)).join(' '));
