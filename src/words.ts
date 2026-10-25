// WORDS.TOK dictionary and the text parser.

export interface ParsedWord {
  id: number;
  word: string;
}

export const UNKNOWN_WORD = 19999;

export class Dictionary {
  private byLetter = new Map<string, { word: string; id: number }[]>();

  constructor(d: Uint8Array) {
    let p = (d[0] << 8) | d[1]; // offset of the 'a' section (big-endian)
    let prev = '';
    while (p < d.length) {
      const keep = d[p++];
      if (p >= d.length) break;
      let w = prev.slice(0, keep);
      for (;;) {
        const b = d[p++];
        if (b === undefined) break;
        w += String.fromCharCode((b & 0x7f) ^ 0x7f);
        if (b & 0x80) break;
      }
      if (p + 1 >= d.length) break;
      const id = (d[p] << 8) | d[p + 1];
      p += 2;
      prev = w;
      if (!w) continue;
      const list = this.byLetter.get(w[0]) ?? [];
      list.push({ word: w, id });
      this.byLetter.set(w[0], list);
    }
    // Longest words first so multi-word phrases win.
    for (const list of this.byLetter.values()) list.sort((a, b) => b.word.length - a.word.length);
  }

  /** Splits player input into dictionary words. Returns the words and the 1-based index of the first unknown word (0 if none). */
  parse(input: string): { words: ParsedWord[]; unknownAt: number } {
    let s = input.toLowerCase().replace(/['`\-\\"]/g, '');
    s = s.replace(/[,.?!();:[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
    const words: ParsedWord[] = [];
    let p = 0;
    while (p < s.length) {
      const list = this.byLetter.get(s[p]) ?? [];
      let match: { word: string; id: number } | undefined;
      for (const e of list) {
        if (s.startsWith(e.word, p) && (p + e.word.length === s.length || s[p + e.word.length] === ' ')) {
          match = e;
          break;
        }
      }
      if (!match) {
        let end = s.indexOf(' ', p);
        if (end < 0) end = s.length;
        words.push({ id: UNKNOWN_WORD, word: s.slice(p, end) });
        return { words, unknownAt: words.length };
      }
      if (match.id !== 0) words.push({ id: match.id, word: match.word });
      p += match.word.length + 1;
    }
    return { words, unknownAt: 0 };
  }
}
