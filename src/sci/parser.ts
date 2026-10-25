// SCI0 text parser: tokenizer (vocab.000 + suffixes vocab.901), GNF grammar
// parse (branches vocab.900) and Said spec matching.
// Faithful port of ScummVM engines/sci/parser/{vocabulary,grammar,said}.cpp (GPL).

import { ResType, type SciResources } from './resource';

export interface ParserWord { wordClass: number; group: number; }
export interface Synonym { replaceant: number; replacement: number; }
export type TokenizeResult = { ok: true; words: ParserWord[][] } | { ok: false; error: string };

/** Result of the full kParse flow (see SciParser.parseInput). */
export type ParseInputResult =
  | { kind: 'ok'; words: ParserWord[][] }          // parsed; claimed=0, return 1
  | { kind: 'syntaxFail'; words: ParserWord[][] }  // claimed=1, invoke game::syntaxFail, return 1
  | { kind: 'wordFail'; word: string }             // claimed=1, copy word to parser ptr, invoke game::wordFail, return 1
  | { kind: 'empty' };                              // no words: claimed=1, return 0

export const SAID_FULL_MATCH = 0xffff;
export const SAID_NO_MATCH = 0xfffe;
export const SAID_PARTIAL_MATCH = 0xfffd;

// Word classes (as stored in ParserWord.wordClass these are shifted left by 4).
export const VOCAB_CLASS_PREPOSITION = 0x01;
export const VOCAB_CLASS_ARTICLE = 0x02;
export const VOCAB_CLASS_ADJECTIVE = 0x04;
export const VOCAB_CLASS_PRONOUN = 0x08;
export const VOCAB_CLASS_NOUN = 0x10;
export const VOCAB_CLASS_INDICATIVE_VERB = 0x20;
export const VOCAB_CLASS_ADVERB = 0x40;
export const VOCAB_CLASS_IMPERATIVE_VERB = 0x80;
export const VOCAB_MAGIC_NUMBER_GROUP = 0xffd;
export const VOCAB_MAGIC_NOTHING_GROUP = 0xffe;

const VOCAB_TREE_NODES = 500;
const VOCAB_TREE_NODE_LAST_WORD_STORAGE = 0x140;
const VOCAB_TREE_NODE_COMPARE_TYPE = 0x146;
const VOCAB_TREE_NODE_COMPARE_GROUP = 0x14d;
const VOCAB_TREE_NODE_FORCE_STORAGE = 0x154;

// ---------------------------------------------------------------- parse tree nodes
const enum NT { Word = 4, Leaf = 5, Branch = 6 }
interface Node { type: NT; value: number; left: Node | null; right: Node | null; }
const newNode = (): Node => ({ type: NT.Leaf, value: 0, left: null, right: null });

// ---------------------------------------------------------------- grammar (grammar.cpp)
// int32 semantics like the C++ ints
const TOKEN_OPAREN = 0xff000000 | 0;
const TOKEN_CPAREN = 0xfe000000 | 0;
const TOKEN_TERMINAL_CLASS = 0x10000;
const TOKEN_TERMINAL_GROUP = 0x20000;
const TOKEN_STUFFING_LEAF = 0x40000;
const TOKEN_STUFFING_WORD = 0x80000;
const TOKEN_NON_NT = TOKEN_OPAREN | TOKEN_TERMINAL_CLASS | TOKEN_TERMINAL_GROUP | TOKEN_STUFFING_LEAF | TOKEN_STUFFING_WORD;
const TOKEN_TERMINAL = TOKEN_TERMINAL_CLASS | TOKEN_TERMINAL_GROUP;

interface ParseRule { id: number; firstSpecial: number; numSpecials: number; data: number[]; }
interface Branch { id: number; data: number[]; } // data has 10 entries, data[9] = 0

const ruleKey = (r: ParseRule) => `${r.id},${r.firstSpecial},${r.numSpecials}:${r.data.join(',')}`;
const ruleTerminal = (r: ParseRule) => { const t = r.data[r.firstSpecial]; return (t & TOKEN_TERMINAL) ? t : 0; };

/** ParseRuleList equivalent. _vocab_add_rule appends, rejecting duplicates of any element except the head. */
class RuleList {
  items: ParseRule[] = [];
  private keys = new Set<string>(); // keys of items[1..]
  add(rule: ParseRule | null): void {
    if (!rule || rule.data.length === 0) return;
    if (this.items.length === 0) { this.items.push(rule); return; }
    const k = ruleKey(rule);
    if (this.keys.has(k)) return;
    this.keys.add(k);
    this.items.push(rule);
  }
  get length() { return this.items.length; }
}

function dupRule(a: ParseRule): ParseRule {
  return { id: a.id, firstSpecial: a.firstSpecial, numSpecials: a.numSpecials, data: a.data.slice() };
}

function vinsert(turkey: ParseRule, stuffing: ParseRule): ParseRule | null {
  let firstnt = turkey.firstSpecial;
  while (firstnt < turkey.data.length && (turkey.data[firstnt] & TOKEN_NON_NT)) firstnt++;
  if (firstnt === turkey.data.length || turkey.data[firstnt] !== stuffing.id) return null;
  return {
    id: turkey.id,
    numSpecials: turkey.numSpecials + stuffing.numSpecials - 1,
    firstSpecial: firstnt + stuffing.firstSpecial,
    data: [...turkey.data.slice(0, firstnt), ...stuffing.data, ...turkey.data.slice(firstnt + 1)],
  };
}

function vbuildRule(branch: Branch): ParseRule | null {
  let tokens = 0, tokenpos = 0;
  while (tokenpos < 10 && branch.data[tokenpos]) {
    const type = branch.data[tokenpos];
    tokenpos += 2;
    if (type === VOCAB_TREE_NODE_COMPARE_TYPE || type === VOCAB_TREE_NODE_COMPARE_GROUP || type === VOCAB_TREE_NODE_FORCE_STORAGE) ++tokens;
    else if (type > VOCAB_TREE_NODE_LAST_WORD_STORAGE) tokens += 5;
    else return null;
  }
  const rule: ParseRule = { id: branch.id, numSpecials: tokenpos >> 1, data: new Array(tokens).fill(0), firstSpecial: 0 };
  tokens = 0;
  for (let i = 0; i < tokenpos; i += 2) {
    const type = branch.data[i], value = branch.data[i + 1];
    if (type === VOCAB_TREE_NODE_COMPARE_TYPE) rule.data[tokens++] = value | TOKEN_TERMINAL_CLASS;
    else if (type === VOCAB_TREE_NODE_COMPARE_GROUP) rule.data[tokens++] = value | TOKEN_TERMINAL_GROUP;
    else if (type === VOCAB_TREE_NODE_FORCE_STORAGE) rule.data[tokens++] = value | TOKEN_STUFFING_WORD;
    else {
      rule.data[tokens++] = TOKEN_OPAREN;
      rule.data[tokens++] = type | TOKEN_STUFFING_LEAF;
      rule.data[tokens++] = value | TOKEN_STUFFING_LEAF;
      if (i === 0) rule.firstSpecial = tokens;
      rule.data[tokens++] = value; // the non-terminal
      rule.data[tokens++] = TOKEN_CPAREN;
    }
  }
  return rule;
}

function vsatisfyRule(rule: ParseRule, input: ParserWord[]): ParseRule | null {
  if (!rule.numSpecials) return null;
  const dep = rule.data[rule.firstSpecial];
  const matches: number[] = [];
  for (const w of input) {
    if (((dep & TOKEN_TERMINAL_CLASS) && ((dep & 0xffff) & w.wordClass)) ||
        ((dep & TOKEN_TERMINAL_GROUP) && ((dep & 0xffff) & w.group)))
      matches.push(TOKEN_STUFFING_WORD | w.group);
  }
  if (!matches.length) return null;
  const data = rule.data.slice();
  data.splice(rule.firstSpecial, 1, ...matches);
  const r: ParseRule = { id: rule.id, data, numSpecials: rule.numSpecials - 1, firstSpecial: 0 };
  if (r.numSpecials) {
    for (let i = rule.firstSpecial; i < data.length; ++i) {
      const tmp = data[i];
      if (!(tmp & TOKEN_NON_NT) || (tmp & TOKEN_TERMINAL)) { r.firstSpecial = i; break; }
    }
  }
  return r;
}

function ruleToString(rule: ParseRule): string {
  let s = `[${rule.id.toString(16).padStart(3, '0')}] -> `;
  if (!rule.data.length) s += 'e';
  let wspace = false;
  const h = (v: number, n: number) => v.toString(16).padStart(n, '0');
  rule.data.forEach((token, i) => {
    const fs = i === rule.firstSpecial ? '_' : '';
    if (token === TOKEN_OPAREN) { s += fs + '('; wspace = false; }
    else if (token === TOKEN_CPAREN) { s += fs + ')'; wspace = false; }
    else {
      if (wspace) s += ' ';
      s += fs;
      if (token & TOKEN_TERMINAL_CLASS) s += `C(${h(token & 0xffff, 4)})`;
      else if (token & TOKEN_TERMINAL_GROUP) s += `G(${h(token & 0xffff, 4)})`;
      else if (token & TOKEN_STUFFING_LEAF) s += h(token & 0xffff, 3);
      else if (token & TOKEN_STUFFING_WORD) s += `{${h(token & 0xffff, 3)}}`;
      else s += `[${h(token, 3)}]`;
      wspace = true;
    }
    s += fs;
  });
  return s + ` [${rule.numSpecials} specials]`;
}

// ---------------------------------------------------------------- tokenizer tables
const lowerCaseMap = (() => {
  const m = new Uint8Array(256);
  for (let i = 0; i < 256; i++) m[i] = i;
  for (let i = 0x41; i <= 0x5a; i++) m[i] = i + 0x20;
  // Extended (CP437) mappings as in ScummVM
  m[0x80] = 0x87; m[0x8e] = 0x84; m[0x8f] = 0x86; m[0x90] = 0x82; m[0x92] = 0x91;
  m[0x99] = 0x94; m[0x9a] = 0x81; m[0xa5] = 0xa4;
  return m;
})();
const isAlnum = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

interface Suffix { classMask: number; resultClass: number; altSuffix: string; wordSuffix: string; }

// ---------------------------------------------------------------- said spec tokens (said.cpp)
const SAID_FIRST = 0xf0;
const SAID_TERM = 0xff;
const TOKEN_COMMA = 0xf000, TOKEN_SLASH = 0xf200, TOKEN_PARENO = 0xf300, TOKEN_PARENC = 0xf400,
  TOKEN_BRACKETO = 0xf500, TOKEN_BRACKETC = 0xf600, TOKEN_LT = 0xf800, TOKEN_GT = 0xf900, TOKEN_TERM = 0xff00;
const WORD_NONE = 0x0ffe, WORD_ANY = 0x0fff;
const MAX_SAID_TOKENS = 128;
const SAID_TREE_START = 4;
const enum Scan { And = 0, Or = 1 }

function nodeMajor(n: Node): number { return n.left!.value; }
function nodeMinor(n: Node): number { return n.right!.left!.value; }
function nodeIsTerminal(n: Node): boolean { const r = n.right!.right; return !!r && r.type !== NT.Branch; }
function nodeTerminalValue(n: Node): number { return n.right!.right!.value; }

export class SciParser {
  private words = new Map<string, ParserWord[]>();
  private suffixes: Suffix[] = [];
  private branches: Branch[] = [];
  private rules: ParseRule[] | null = null;
  private synonyms: Synonym[] = [];
  /** Persistent node arrays, like _parserNodes / said_tree. */
  private nodes: Node[] = Array.from({ length: VOCAB_TREE_NODES }, newNode);
  private saidTree: Node[] = Array.from({ length: VOCAB_TREE_NODES }, newNode);
  private valid = false;
  private pronounReference = 0x1000;
  /** False only for SCI_VERSION_0_EARLY games (no number words). SQ3 (0.000.685) is SCI0 late. */
  numbersAsWords = true;

  constructor(res: SciResources, opts: { sci0Early?: boolean } = {}) {
    if (opts.sci0Early) this.numbersAsWords = false;
    if (this.loadWords(res.get(ResType.Vocab, 0))) {
      this.loadSuffixes(res.get(ResType.Vocab, 901));
      if (this.loadBranches(res.get(ResType.Vocab, 900))) this.rules = this.buildGNF();
    }
  }

  /** True if the parse tree from the last parse() is valid (Vocabulary::parserIsValid). */
  get lastParseValid(): boolean { return this.valid; }
  /** Invalidate the parser (kParse does this before parsing; also on game restart). */
  invalidate(): void { this.valid = false; }
  get hasParser(): boolean { return this.rules !== null; }
  get ruleCount(): number { return this.rules?.length ?? 0; }

  // ------------------------------------------------------------ vocab loading
  private loadWords(r: Uint8Array | null): boolean {
    if (!r || r.length < 26 * 2) return false;
    let seeker = 26 * 2;
    const cur: number[] = [];
    while (seeker < r.length) {
      let pos = r[seeker++];
      cur.length = pos;
      let c: number;
      do {
        if (seeker === r.length) return false;
        c = r[seeker++];
        cur[pos++] = c & 0x7f;
      } while (c < 0x80);
      if (seeker === r.length) return false;
      const word = String.fromCharCode(...cur.slice(0, pos));
      const c1 = r[seeker + 1];
      const w: ParserWord = { wordClass: (r[seeker] << 4) | ((c1 & 0xf0) >> 4), group: r[seeker + 2] | ((c1 & 0x0f) << 8) };
      this.words.set(word, [w]); // SCI0: one class/group pair per word, later entries win
      seeker += 3;
    }
    return true;
  }

  private loadSuffixes(r: Uint8Array | null): void {
    if (!r) return;
    const cstr = (p: number) => { let e = p; while (e < r.length && r[e]) e++; return String.fromCharCode(...r.subarray(p, e)); };
    let seeker = 1;
    while (seeker < r.length - 1 && r[seeker + 1] !== 0xff) {
      const altSuffix = cstr(seeker);
      seeker += altSuffix.length + 1;
      const resultClass = ((r[seeker] << 8) | r[seeker + 1]) << 16 >> 16;
      seeker += 2;
      seeker++; // skip leading '*'
      if (seeker >= r.length) break;
      const wordSuffix = cstr(seeker);
      seeker += wordSuffix.length + 1;
      const classMask = (r[seeker] << 8) | r[seeker + 1];
      seeker += 3;
      this.suffixes.push({ altSuffix, wordSuffix, resultClass, classMask });
    }
  }

  private loadBranches(r: Uint8Array | null): boolean {
    if (!r) return false;
    const n = Math.floor(r.length / 20);
    if (!n) return false;
    for (let i = 0; i < n; i++) {
      const b = i * 20;
      const id = (r[b] | (r[b + 1] << 8)) << 16 >> 16;
      const data: number[] = [];
      for (let k = 0; k < 9; k++) data.push(r[b + 2 + 2 * k] | (r[b + 3 + 2 * k] << 8));
      data.push(0);
      this.branches.push({ id, data });
    }
    if (!this.branches[n - 1].id) this.branches.pop();
    return true;
  }

  private buildGNF(): ParseRule[] | null {
    let ntlist = new RuleList();
    for (let i = 1; i < this.branches.length; i++) {
      const rule = vbuildRule(this.branches[i]);
      if (!rule) return null;
      ntlist.add(rule);
    }
    // _vocab_split_rule_list: cut before the first terminal rule after the head
    let split = ntlist.items.length;
    for (let i = 1; i < ntlist.items.length; i++) if (ruleTerminal(ntlist.items[i])) { split = i; break; }
    let newT = new RuleList();
    for (const r of ntlist.items.slice(split)) newT.add(r);
    const nt = ntlist.items.slice(0, split);
    const tlist = new RuleList();
    let iterations = 0, termrules = 0;
    do {
      const nn = new RuleList();
      for (const ntr of nt) for (const tr of newT.items) nn.add(vinsert(ntr, tr));
      for (const r of newT.items) tlist.add(r);
      newT = nn;
      termrules = nn.length;
      iterations++;
    } while (termrules && iterations < 30);
    return tlist.items;
  }

  // ------------------------------------------------------------ tokenizer
  /** Vocabulary::lookupWord. `word` is already lowercased. */
  lookupWord(word: string): ParserWord[] {
    const temp = word.replace(/-/g, '');
    const hit = this.words.get(temp);
    if (hit) return hit.map(w => ({ ...w }));
    const out: ParserWord[] = [];
    for (const s of this.suffixes) {
      if (s.altSuffix.length <= word.length) {
        const idx = word.length - s.altSuffix.length;
        if (word.substr(idx, s.altSuffix.length) === s.altSuffix) {
          const dict = this.words.get(word.slice(0, idx) + s.wordSuffix);
          if (dict) for (const w of dict) {
            if (w.wordClass & s.classMask) {
              out.push({ wordClass: s.resultClass, group: w.group });
              return out; // SCI0: first suffix match only
            }
          }
        }
      }
    }
    if (this.numbersAsWords && /^[0-9]+$/.test(temp)) out.push({ wordClass: VOCAB_CLASS_NOUN << 4, group: VOCAB_MAGIC_NUMBER_GROUP });
    return out;
  }

  tokenize(text: string): TokenizeResult {
    const words: ParserWord[][] = [];
    let cur = '';
    for (let p = 0; p <= text.length; p++) {
      const c = p < text.length ? text.charCodeAt(p) & 0xff : 0;
      if (isAlnum(c) || (c === 0x2d && cur.length) || c >= 0x80) {
        cur += String.fromCharCode(lowerCaseMap[c]);
      } else if (c === 0x20 || c === 0) {
        if (cur.length) {
          const r = this.lookupWord(cur);
          if (!r.length) return { ok: false, error: cur };
          words.push(r);
        }
        cur = '';
        if (c === 0) break; // C string terminator
      }
      // any other character is silently dropped (does not split words)
    }
    return { ok: true, words };
  }

  // ------------------------------------------------------------ synonyms / pronouns
  setSynonyms(list: Synonym[]): void { this.synonyms = list.slice(); }
  clearSynonyms(): void { this.synonyms = []; }
  addSynonym(s: Synonym): void { this.synonyms.push(s); }

  synonymize(words: ParserWord[][], synonyms: Synonym[] = this.synonyms): void {
    if (!synonyms.length) return;
    for (const list of words) for (const w of list)
      for (const s of synonyms) if (w.group === s.replaceant) w.group = s.replacement;
  }

  replacePronouns(words: ParserWord[][]): void {
    if (this.pronounReference === 0x1000) return;
    for (const list of words) for (const w of list)
      if (w.wordClass & (VOCAB_CLASS_PRONOUN << 4)) { w.wordClass = VOCAB_CLASS_NOUN << 4; w.group = this.pronounReference; }
  }

  private scanForMajor(tree: Node, major: number): Node | null {
    if (nodeIsTerminal(tree)) return nodeMajor(tree) === major ? tree : null;
    let ptr = tree.right!;
    while (ptr.right) {
      ptr = ptr.right;
      if (nodeMajor(ptr.left!) === major) return ptr.left;
    }
    if (major === 0x141) return null;
    const t = this.scanForMajor(tree, 0x141);
    return t ? this.scanForMajor(t, major) : null;
  }

  /** Vocabulary::storePronounReference (called by kParse after a successful parse). */
  storePronounReference(): boolean {
    let ptr = this.scanForMajor(this.nodes[0], 0x142);
    while (ptr && !nodeIsTerminal(ptr)) ptr = this.scanForMajor(ptr, 0x141);
    if (!ptr) return false;
    this.pronounReference = nodeTerminalValue(ptr);
    return true;
  }

  // ------------------------------------------------------------ GNF parse
  private node(i: number): Node {
    while (i >= this.nodes.length) this.nodes.push(newNode());
    return this.nodes[i];
  }

  /** Vocabulary::parseGNF. Returns true on success and stores the tree. Sets lastParseValid. */
  parse(words: ParserWord[][]): boolean {
    this.valid = false;
    if (!this.rules || !words.length) return false;
    const startId = this.branches[0].data[1];
    let work = new RuleList();
    for (const r of this.rules) if (r.id === startId) work.add(dupRule(r));
    const wordsNr = words.length;
    for (let word = 0; word < wordsNr; word++) {
      const reduced = new RuleList();
      for (const r of work.items)
        if (r.numSpecials <= wordsNr - word) reduced.add(vsatisfyRule(r, words[word]));
      if (!reduced.length) return false;
      let newWork: RuleList;
      if (word + 1 < wordsNr) {
        newWork = new RuleList();
        for (const r of reduced.items) {
          if (r.numSpecials) {
            const myId = r.data[r.firstSpecial];
            for (const sub of this.rules) if (sub.id === myId) newWork.add(vinsert(r, sub));
          }
        }
      } else newWork = reduced;
      work = newWork;
      if (!work.length) return false;
    }
    const result = work.items[0];
    const n0 = this.node(0), n1 = this.node(1), n2 = this.node(2);
    n0.type = NT.Branch; n0.left = n1; n0.right = n2;
    n1.type = NT.Leaf; n1.value = 0x141; n1.right = null;
    n2.type = NT.Branch; n2.left = null; n2.right = null;
    const pos = { v: 2 };
    const temp = this.vbptAppend(pos, 2, this.branches[0].id);
    this.writeSubexpression(pos, result, 0, temp);
    this.valid = true;
    return true;
  }

  private vbptPareno(pos: { v: number }, base: number): number {
    this.node(base).left = this.node(pos.v + 1);
    const n = this.node(++pos.v);
    n.type = NT.Branch; n.left = null; n.right = null;
    return pos.v;
  }
  private vbptParenc(pos: { v: number }, paren: number): number {
    const n = this.node(++pos.v);
    this.node(paren).right = n;
    n.type = NT.Branch; n.left = null; n.right = null;
    return pos.v;
  }
  private vbptAppend(pos: { v: number }, base: number, value: number): number {
    const b = this.node(base);
    const l = this.node(++pos.v);
    b.left = l; l.type = NT.Leaf; l.value = value; l.right = null;
    const r = this.node(++pos.v);
    b.right = r; r.type = NT.Branch; r.left = null; r.right = null;
    return pos.v;
  }
  private vbptTerminate(pos: { v: number }, base: number, value: number): number {
    const b = this.node(base);
    b.type = NT.Leaf; b.value = value; b.right = null;
    return pos.v;
  }
  private vbptAppendWord(pos: { v: number }, base: number, value: number): number {
    const b = this.node(base);
    b.type = NT.Word; b.value = value;
    const r = this.node(++pos.v);
    b.right = r; r.type = NT.Branch; r.left = null; r.right = null;
    return pos.v;
  }
  private vbptTerminateWord(pos: { v: number }, base: number, value: number): number {
    const b = this.node(base);
    b.type = NT.Word; b.value = value; b.right = null;
    return pos.v;
  }

  private writeSubexpression(pos: { v: number }, rule: ParseRule, rulepos: number, writepos: number): number {
    const d = rule.data;
    for (;;) {
      const token = rulepos < d.length ? d[rulepos++] : TOKEN_CPAREN;
      if (token === TOKEN_CPAREN) break;
      let nexttoken = rulepos < d.length ? d[rulepos] : TOKEN_CPAREN;
      if (token === TOKEN_OPAREN) {
        const writepos2 = this.vbptPareno(pos, writepos);
        rulepos = this.writeSubexpression(pos, rule, rulepos, writepos2);
        nexttoken = rulepos < d.length ? d[rulepos] : TOKEN_CPAREN;
        if (nexttoken !== TOKEN_CPAREN) writepos = this.vbptParenc(pos, writepos);
      } else if (token & TOKEN_STUFFING_LEAF) {
        writepos = nexttoken === TOKEN_CPAREN ? this.vbptTerminate(pos, writepos, token & 0xffff) : this.vbptAppend(pos, writepos, token & 0xffff);
      } else if (token & TOKEN_STUFFING_WORD) {
        writepos = nexttoken === TOKEN_CPAREN ? this.vbptTerminateWord(pos, writepos, token & 0xffff) : this.vbptAppendWord(pos, writepos, token & 0xffff);
      } else {
        console.warn(`parser: rule data broken in rule ${ruleToString(rule)}`);
        return rulepos;
      }
    }
    return rulepos;
  }

  /**
   * Full kParse flow: tokenize, synonymize (active synonyms), replace pronouns, parse,
   * store pronoun reference. Updates lastParseValid.
   */
  parseInput(text: string): ParseInputResult {
    const t = this.tokenize(text);
    this.valid = false;
    if (!t.ok) return { kind: 'wordFail', word: t.error };
    if (!t.words.length) return { kind: 'empty' };
    this.synonymize(t.words);
    this.replacePronouns(t.words);
    if (!this.parse(t.words)) return { kind: 'syntaxFail', words: t.words };
    this.storePronounReference();
    return { kind: 'ok', words: t.words };
  }

  // ------------------------------------------------------------ Said
  private saidTokens: number[] = [];
  private saidToken = 0;
  private saidTreePos = 0;
  private dontclaim = false;

  /** Returns SAID_FULL_MATCH, SAID_PARTIAL_MATCH (spec ended in '>': don't claim) or SAID_NO_MATCH. */
  saidMatch(spec: Uint8Array, offset: number): number {
    if (!this.valid) return SAID_NO_MATCH;
    if (!this.saidParseSpec(spec, offset)) return SAID_NO_MATCH;
    let ret: number;
    try {
      this.dontclaim = false;
      ret = this.matchTrees(this.nodes[0], this.saidTree[0]);
    } catch (e) {
      console.warn('said: tree match failed', e);
      return SAID_NO_MATCH;
    }
    if (ret !== 1) return SAID_NO_MATCH;
    return this.dontclaim ? SAID_PARTIAL_MATCH : SAID_FULL_MATCH;
  }

  /** True on full or partial match. kSaid should set claimed=1 only on a full match (see saidMatch). */
  said(spec: Uint8Array, offset: number): boolean {
    return this.saidMatch(spec, offset) !== SAID_NO_MATCH;
  }

  private saidParseSpec(spec: Uint8Array, offset: number): boolean {
    const toks: number[] = this.saidTokens = [];
    let p = offset, next: number;
    do {
      next = p < spec.length ? spec[p++] : SAID_TERM;
      if (next < SAID_FIRST) toks.push((next << 8) | (p < spec.length ? spec[p++] : 0));
      else toks.push(next << 8);
    } while (next !== SAID_TERM && toks.length < MAX_SAID_TOKENS);
    if (next !== SAID_TERM) { console.warn('SAID spec is too long'); return false; }
    this.saidToken = 0;
    if (!this.buildSaidTree()) { console.warn('Error while parsing SAID spec'); return false; }
    return true;
  }

  private tok(): number { return this.saidToken < this.saidTokens.length ? this.saidTokens[this.saidToken] : TOKEN_TERM; }

  private nextNode(): Node {
    if (this.saidTreePos >= this.saidTree.length) this.saidTree.push(newNode());
    return this.saidTree[this.saidTreePos++];
  }
  private static leaf(pos: Node, value: number): Node { pos.type = NT.Leaf; pos.value = value; pos.right = null; return pos; }
  private static word(pos: Node, value: number): Node { pos.type = NT.Word; pos.value = value; pos.right = null; return pos; }
  private static branch(pos: Node, l: Node | null, r: Node | null): Node { pos.type = NT.Branch; pos.left = l; pos.right = r; return pos; }

  private attachSubtree(pos: Node, major: number, minor: number, subtree: Node): void {
    // Evaluation order matches the C++ (nested said_next_node calls, outermost first).
    const b1 = this.nextNode();
    const b2 = this.nextNode();
    const lMajor = SciParser.leaf(this.nextNode(), major);
    subtree.type = NT.Branch;
    subtree.left = SciParser.leaf(this.nextNode(), minor);
    SciParser.branch(b2, lMajor, subtree);
    SciParser.branch(b1, b2, null);
    pos.type = NT.Branch;
    pos.right = b1;
  }

  private buildSaidTree(): boolean {
    const t = this.saidTree;
    SciParser.branch(t[0], t[1], t[2]);
    SciParser.leaf(t[1], 0x141);
    SciParser.branch(t[2], t[3], null);
    SciParser.leaf(t[3], 0x13f);
    this.saidTreePos = SAID_TREE_START;
    if (!this.parseSpec(t[2])) return false;
    if (this.tok() !== TOKEN_TERM) {
      t[2].right = null; this.saidToken = 0; this.saidTreePos = SAID_TREE_START;
      return false;
    }
    return true;
  }

  private parseWord(parent: Node): boolean {
    const token = this.tok();
    if (token & 0x8000) return false;
    this.saidToken++;
    parent.right = SciParser.word(this.nextNode(), token);
    return true;
  }

  private parsePart23(parent: Node, isPart3: boolean, ne: { v: boolean }): boolean {
    const curToken = this.saidToken, curTreePos = this.saidTreePos, curRight = parent.right;
    const nn = SciParser.branch(this.nextNode(), null, null);
    ne.v = true;
    const major = isPart3 ? 0x143 : 0x142;
    if (this.parseSlash(nn)) {
      this.attachSubtree(parent, major, 0x14a, nn);
      return true;
    } else if (this.tok() === TOKEN_BRACKETO) {
      this.saidToken++;
      if (this.parsePart23(nn, isPart3, ne)) {
        if (this.tok() === TOKEN_BRACKETC) {
          this.saidToken++;
          this.attachSubtree(parent, 0x152, major, nn);
          return true;
        }
      }
    }
    if (this.tok() === TOKEN_SLASH) {
      this.saidToken++;
      ne.v = false;
      return true;
    }
    this.saidToken = curToken; this.saidTreePos = curTreePos; parent.right = curRight;
    return false;
  }

  private parseSlash(parent: Node): boolean {
    const curToken = this.saidToken, curTreePos = this.saidTreePos, curRight = parent.right;
    if (this.tok() === TOKEN_SLASH) {
      this.saidToken++;
      if (this.parseExpr(parent)) return true;
    }
    this.saidToken = curToken; this.saidTreePos = curTreePos; parent.right = curRight;
    return false;
  }

  private parseRef(parent: Node): boolean {
    const curToken = this.saidToken, curTreePos = this.saidTreePos, curRight = parent.right;
    let nn = SciParser.branch(this.nextNode(), null, null);
    let newParent = parent;
    if (this.tok() === TOKEN_LT) {
      this.saidToken++;
      if (this.parseList(nn)) {
        this.attachSubtree(newParent, 0x144, 0x14f, nn);
        newParent = newParent.right!;
        nn = SciParser.branch(this.nextNode(), null, null);
        if (this.parseRef(nn)) this.attachSubtree(newParent, 0x141, 0x144, nn);
        return true;
      }
    }
    // not an 'else if': "< [ ... ]" is parsed as "< ..."
    if (this.tok() === TOKEN_BRACKETO) {
      this.saidToken++;
      if (this.parseRef(nn)) {
        if (this.tok() === TOKEN_BRACKETC) {
          this.saidToken++;
          this.attachSubtree(parent, 0x152, 0x144, nn);
          return true;
        }
      }
    }
    this.saidToken = curToken; this.saidTreePos = curTreePos; parent.right = curRight;
    return false;
  }

  private parseComma(parent: Node): boolean {
    const curToken = this.saidToken, curTreePos = this.saidTreePos, curRight = parent.right;
    if (this.tok() === TOKEN_COMMA) {
      this.saidToken++;
      if (this.parseList(parent)) return true;
    }
    this.saidToken = curToken; this.saidTreePos = curTreePos; parent.right = curRight;
    return false;
  }

  private parseListEntry(parent: Node): boolean {
    const curToken = this.saidToken, curTreePos = this.saidTreePos, curRight = parent.right;
    const nn = SciParser.branch(this.nextNode(), null, null);
    if (this.tok() === TOKEN_BRACKETO) {
      this.saidToken++;
      if (this.parseExpr(nn) && this.tok() === TOKEN_BRACKETC) {
        this.saidToken++;
        this.attachSubtree(parent, 0x152, 0x14c, nn);
        return true;
      }
    } else if (this.tok() === TOKEN_PARENO) {
      this.saidToken++;
      if (this.parseExpr(nn) && this.tok() === TOKEN_PARENC) {
        this.saidToken++;
        this.attachSubtree(parent, 0x141, 0x14c, nn);
        return true;
      }
    } else if (this.parseWord(nn)) {
      this.attachSubtree(parent, 0x141, 0x153, nn);
      return true;
    }
    this.saidToken = curToken; this.saidTreePos = curTreePos; parent.right = curRight;
    return false;
  }

  private parseList(parent: Node): boolean {
    const curToken = this.saidToken, curTreePos = this.saidTreePos, curRight = parent.right;
    if (this.parseListEntry(parent)) {
      this.parseComma(parent.right!);
      return true;
    }
    this.saidToken = curToken; this.saidTreePos = curTreePos; parent.right = curRight;
    return false;
  }

  private parseExpr(parent: Node): boolean {
    const curToken = this.saidToken, curTreePos = this.saidTreePos, curRight = parent.right;
    const nn = SciParser.branch(this.nextNode(), null, null);
    let ret = false;
    let newParent = parent;
    if (this.parseList(nn)) {
      ret = true;
      this.attachSubtree(newParent, 0x141, 0x14f, nn);
      newParent = newParent.right!;
    }
    if (this.parseRef(newParent) || ret) return true;
    this.saidToken = curToken; this.saidTreePos = curTreePos; parent.right = curRight;
    return false;
  }

  private parseSpec(parent: Node): boolean {
    const curToken = this.saidToken, curTreePos = this.saidTreePos, curRight = parent.right;
    let nn = SciParser.branch(this.nextNode(), null, null);
    let ret = false;
    let newParent = parent;
    if (this.parseExpr(nn)) {
      this.attachSubtree(newParent, 0x141, 0x149, nn);
      newParent = newParent.right!;
      ret = true;
    }
    const ne = { v: false };
    if (this.parsePart23(newParent, false, ne)) {
      ret = true;
      if (ne.v) newParent = newParent.right!;
      if (this.parsePart23(newParent, true, ne)) {
        if (ne.v) newParent = newParent.right!;
      }
    }
    if (this.tok() === TOKEN_GT) {
      this.saidToken++;
      const b = this.nextNode();
      nn = SciParser.branch(b, null, SciParser.leaf(this.nextNode(), TOKEN_GT));
      this.attachSubtree(newParent, 0x14b, TOKEN_GT, nn);
    }
    if (ret) return true;
    this.saidToken = curToken; this.saidTreePos = curTreePos; parent.right = curRight;
    return false;
  }

  // ---- augmentation / matching
  private matchTrees(parseT: Node, saidT: Node): number {
    const inParen = nodeMinor(saidT) === 0x14f || nodeMinor(saidT) === 0x150;
    const inBracket = nodeMajor(saidT) === 0x152;
    let ret: number;
    const pm = nodeMajor(parseT), sm = nodeMajor(saidT);
    if (pm !== 0x141 && sm !== 0x141 && sm !== 0x152 && sm !== pm) {
      ret = -1;
    } else if (nodeIsTerminal(saidT) && nodeIsTerminal(parseT)) {
      const saidVal = nodeTerminalValue(saidT);
      if (saidVal === WORD_NONE) ret = -1;
      else if (saidVal === WORD_ANY) ret = 1;
      else {
        ret = -1;
        let t: Node | null = parseT.right!.right;
        do {
          const v = t!.value;
          if (v === WORD_ANY || v === saidVal) { ret = 1; break; }
          t = t!.right;
        } while (t);
      }
    } else if (nodeIsTerminal(saidT) && !nodeIsTerminal(parseT)) {
      ret = (pm === 0x141 || pm === sm) ? this.scanParseChildren(parseT.right!.right, saidT) : 0;
    } else if (nodeIsTerminal(parseT)) {
      ret = (sm === 0x141 || sm === 0x152 || sm === pm)
        ? this.scanSaidChildren(parseT, saidT.right!.right, inParen ? Scan.Or : Scan.And) : 0;
    } else if (sm !== 0x141 && sm !== 0x152 && sm !== pm) {
      ret = this.scanParseChildren(parseT.right!.right, saidT);
    } else {
      ret = this.scanSaidChildren(parseT.right!.right, saidT.right!.right, inParen ? Scan.Or : Scan.And);
    }
    if (inBracket && ret === 0) ret = 1;
    return ret;
  }

  private scanSaidChildren(parseT: Node | null, saidT: Node | null, type: Scan): number {
    let ret = 1;
    while (saidT) {
      const saidChild = saidT.left!;
      if (nodeMajor(saidChild) !== 0x145) {
        ret = this.scanParseChildren(parseT, saidChild);
        if (type === Scan.And && ret !== 1) break;
        if (type === Scan.Or && ret === 1) break;
      }
      saidT = saidT.right;
    }
    return ret;
  }

  private scanParseChildren(parseT: Node | null, saidT: Node): number {
    if (nodeMajor(saidT) === 0x14b) { this.dontclaim = true; return 1; }
    const inParen = nodeMinor(saidT) === 0x14f || nodeMinor(saidT) === 0x150;
    const inBracket = nodeMajor(saidT) === 0x152;
    let ret: number;
    if ((nodeMajor(saidT) === 0x141 || nodeMajor(saidT) === 0x152) && !nodeIsTerminal(saidT)) {
      ret = this.scanSaidChildren(parseT, saidT.right!.right, inParen ? Scan.Or : Scan.And);
    } else if (parseT && parseT.left!.type === NT.Branch) {
      ret = 0;
      let subresult = 0;
      while (parseT) {
        const parseChild: Node = parseT.left!;
        if (nodeMajor(parseChild) === nodeMajor(saidT) || nodeMajor(parseChild) === 0x141)
          subresult = this.matchTrees(parseChild, saidT);
        if (subresult !== 0) ret = subresult;
        if (ret === 1) break;
        parseT = parseT.right;
      }
    } else {
      ret = this.matchTrees(parseT!, saidT);
    }
    if (inBracket && ret === 0) ret = 1;
    return ret;
  }

  // ------------------------------------------------------------ debugging helpers
  /** Any word string of a group (Vocabulary::getAnyWordFromGroup). */
  wordForGroup(group: number): string {
    if (group === VOCAB_MAGIC_NUMBER_GROUP) return '{number}';
    if (group === VOCAB_MAGIC_NOTHING_GROUP) return '{nothing}';
    for (const [k, v] of this.words) for (const w of v) if (w.group === group) return k;
    return '{invalid}';
  }

  /** All dictionary entries (word -> class/group). */
  get dictionary(): ReadonlyMap<string, readonly ParserWord[]> { return this.words; }

  /** Human-readable Said spec (Vocabulary::debugDecipherSaidBlock). */
  saidToString(spec: Uint8Array, offset: number): string {
    const ops: Record<number, string> = { 0xf0: ',', 0xf1: '&', 0xf2: '/', 0xf3: '(', 0xf4: ')', 0xf5: '[', 0xf6: ']', 0xf7: '#', 0xf8: '<', 0xf9: '>' };
    let s = '', first = true, p = offset;
    while (p < spec.length) {
      let item = spec[p++];
      if (item === 0xff) break;
      if (!first && item !== 0xf0) s += ' ';
      first = false;
      if (item < 0xf0) {
        item = (item << 8) | spec[p++];
        s += `${this.wordForGroup(item)}{${item.toString(16).padStart(3, '0')}}`;
      } else s += ops[item] ?? '';
    }
    return s;
  }

  /** Lisp-style dump of the last parse tree (vocab_dump_parse_tree). */
  dumpTree(): string {
    if (!this.valid) return '(no valid parse)';
    let out = "(setq parse-tree \n'(";
    const rec = (tree: Node, blanks: number) => {
      const l = tree.left, r = tree.right;
      if (tree.type === NT.Leaf) { out += 'Error: consp is nil\n'; return; }
      if (l) {
        if (l.type === NT.Branch) {
          out += '\n' + '    '.repeat(blanks) + '(';
          rec(l, blanks + 1);
          out += ')\n' + '    '.repeat(blanks);
        } else out += l.value.toString(16);
        out += ' ';
      }
      if (r) {
        if (r.type === NT.Branch) rec(r, blanks);
        else {
          let rr: Node = r;
          out += rr.value.toString(16);
          while (rr.right) { rr = rr.right; out += '/' + rr.value.toString(16); }
        }
      }
    };
    rec(this.nodes[0], 1);
    return out + '))';
  }

  /** GNF rules as text (for debugging). */
  dumpRules(): string {
    return (this.rules ?? []).map((r, i) => `R${String(i).padStart(3, '0')}: ${ruleToString(r)}`).join('\n');
  }
}
