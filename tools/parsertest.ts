// SCI0 parser tests against SQ3's vocabulary. Run: npx tsx tools/parsertest.ts
import { SciResources } from '../src/sci/resource';
import { loadGameDir } from './png';
import { SciParser, SAID_FULL_MATCH, SAID_PARTIAL_MATCH, SAID_NO_MATCH } from '../src/sci/parser';

const res = new SciResources(loadGameDir('public/games/sq3'));
const p = new SciParser(res);
let fails = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { fails++; console.log(`  FAIL: ${msg}`); } };

console.log(`GNF rules: ${p.ruleCount}, dictionary words: ${p.dictionary.size}`);

const group = (w: string): number => {
  const r = p.lookupWord(w);
  if (!r.length) throw new Error(`word not in vocab: ${w}`);
  return r[0].group;
};

// ---------------------------------------------------------------- 1. tokenize + parse
const sentences: [string, 'ok' | 'syntaxFail' | 'wordFail'][] = [
  ['look', 'ok'],
  ['look at the room', 'ok'],
  ['get the ladder', 'ok'],
  ['talk to the man', 'ok'],
  ['xyzzy', 'wordFail'],
  ['look at', 'ok'], // SQ3 grammar accepts a dangling preposition (attached to the verb)
  ['Look, at the ROOM!', 'ok'], // punctuation dropped, case folded
  ['pick up ladder', 'ok'],
  ['the the', 'syntaxFail'],
];
for (const [s, want] of sentences) {
  console.log(`\n> "${s}"`);
  const t = p.tokenize(s);
  if (!t.ok) {
    console.log(`  unknown word: "${t.error}"`);
    check(want === 'wordFail', `"${s}" expected ${want}`);
    continue;
  }
  console.log('  words: ' + t.words.map(l => l.map(w => `[class ${w.wordClass.toString(16)} group ${w.group.toString(16)}]`).join('/')).join(' '));
  const ok = p.parse(t.words);
  console.log(`  parse: ${ok ? 'OK' : 'syntax fail'}`);
  if (ok) console.log('  ' + p.dumpTree().replace(/\n/g, '\n  '));
  check((ok ? 'ok' : 'syntaxFail') === want, `"${s}" expected ${want}`);
}
check(p.tokenize('xyzzy').ok === false && (p.tokenize('look xyzzy') as { error: string }).error === 'xyzzy', 'wordFail text');
check(p.parseInput('the the').kind === 'syntaxFail' && !p.lastParseValid, 'parseInput syntaxFail invalidates');
check(p.parseInput('   ').kind === 'empty', 'parseInput empty');

// ---------------------------------------------------------------- 2. Said specs
const OP: Record<string, number> = { ',': 0xf0, '&': 0xf1, '/': 0xf2, '(': 0xf3, ')': 0xf4, '[': 0xf5, ']': 0xf6, '#': 0xf7, '<': 0xf8, '>': 0xf9 };
/** Compile a said string like "look[/room]" to the SCI byte encoding (words -> 2-byte BE groups, 0xFF end). */
function compileSaid(spec: string): Uint8Array {
  const out: number[] = [];
  for (const tok of spec.match(/[a-z0-9*!]+|[,&/()[\]#<>]/g) ?? []) {
    if (tok in OP) out.push(OP[tok]);
    else {
      const g = tok === '*' ? 0xfff : tok === '!*' ? 0xffe : group(tok);
      out.push(g >> 8, g & 0xff);
    }
  }
  out.push(0xff);
  return new Uint8Array(out);
}

const G = (w: string) => group(w).toString(16);
console.log(`\nGroups: look=${G('look')} room=${G('room')} get=${G('get')} ladder=${G('ladder')} talk=${G('talk')} man=${G('man')} at=${G('at')} up=${G('up')}`);

type Want = 'full' | 'partial' | 'no';
const saidCases: [string, string, Want][] = [
  ['look', 'look', 'full'],
  ['look', 'look/room', 'no'],
  ['look', 'look[/room]', 'full'],
  ['look', '[look]/room', 'no'],
  ['look', 'look/*', 'no'],
  ['look', 'look[/!*]', 'full'],
  ['look', 'get', 'no'],
  ['look at the room', 'look/room', 'full'],
  ['look at the room', 'look[/room]', 'full'],
  ['look at the room', '[look]/room', 'full'],
  ['look at the room', 'look/*', 'full'],
  ['look at the room', 'look[/!*]', 'no'],
  ['look at the room', 'look/ladder', 'no'],
  ['look at the room', 'get/room', 'no'],
  ['look at the room', 'look', 'full'],
  ['look at the room', 'look>', 'partial'],
  // "at" modifies the verb in the parse tree (144 under the 13b verb phrase)
  ['look at the room', 'look<at/room', 'full'],
  ['look at the room', 'look/room<at', 'no'],
  ['look at the room', 'look<up/room', 'no'],
  ['look at the room', 'look[<up]/room', 'no'],
  ['pick up ladder', 'get<up/ladder', 'full'],
  ['pick up ladder', 'get[<up]/ladder', 'full'],
  ['pick up ladder', 'get/ladder', 'full'],
  ['look at the room', 'look/room<up', 'no'],
  ['look at the room', 'look/room[<at]', 'full'],
  ['look at the room', '*/room', 'full'],
  ['look at the room', 'look/room/ladder', 'no'],
  ['look at the room', '(look,get)/room', 'full'],
  ['look at the room', 'get,look/room', 'full'],
  ['look at the room', '/room', 'full'],
  ['get the ladder', 'get/ladder', 'full'],
  ['get the ladder', 'get/room', 'no'],
  ['get the ladder', 'get', 'full'],
  ['get the ladder', 'look/ladder', 'no'],
  ['talk to the man', 'talk/man', 'full'],
  ['talk to the man', 'talk[/man]', 'full'],
  ['talk to the man', 'talk/ladder', 'no'],
];
console.log();
let curSentence = '';
for (const [sentence, spec, want] of saidCases) {
  if (sentence !== curSentence) {
    const r = p.parseInput(sentence);
    check(r.kind === 'ok', `parse "${sentence}"`);
    curSentence = sentence;
  }
  const bytes = compileSaid(spec);
  const m = p.saidMatch(bytes, 0);
  const got: Want = m === SAID_FULL_MATCH ? 'full' : m === SAID_PARTIAL_MATCH ? 'partial' : 'no';
  console.log(`  "${sentence}" said '${spec}' (${p.saidToString(bytes, 0)}) -> ${got}${got === want ? '' : `  (expected ${want})`}`);
  check(got === want, `"${sentence}" said '${spec}'`);
  check(p.said(bytes, 0) === (m !== SAID_NO_MATCH), 'said() agrees with saidMatch()');
}

// Said with a non-zero offset inside a larger heap buffer
{
  p.parseInput('get the ladder');
  const spec = compileSaid('get/ladder');
  const heap = new Uint8Array(100);
  heap.set(spec, 37);
  check(p.said(heap, 37), 'said at offset');
}

// Synonyms: map "man" -> "ladder" group
{
  const t = p.tokenize('get the man');
  if (t.ok) {
    p.synonymize(t.words, [{ replaceant: group('man'), replacement: group('ladder') }]);
    check(p.parse(t.words) && p.said(compileSaid('get/ladder'), 0), 'synonym applied');
  } else check(false, 'tokenize "get the man"');
}

// Pronoun: "it" refers to the last parsed object
{
  p.parseInput('get the ladder');
  const r = p.parseInput('look at it');
  check(r.kind === 'ok' && p.said(compileSaid('look/ladder'), 0), 'pronoun "it" -> ladder');
}

// No valid parse -> never matches
p.invalidate();
check(!p.said(compileSaid('look'), 0), 'no match when parse invalid');

console.log(fails ? `\n${fails} FAILURES` : '\nAll parser tests passed.');
process.exit(fails ? 1 : 0);
