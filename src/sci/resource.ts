// SCI0 resources: RESOURCE.MAP indexes resources stored (often compressed) in RESOURCE.00n files.

import type { GameFiles } from '../resources';

export const enum ResType {
  View = 0,
  Pic = 1,
  Script = 2,
  Text = 3,
  Sound = 4,
  Memory = 5,
  Vocab = 6,
  Font = 7,
  Cursor = 8,
  Patch = 9,
}

export const RES_NAMES = ['view', 'pic', 'script', 'text', 'sound', 'memory', 'vocab', 'font', 'cursor', 'patch'];

interface MapEntry {
  vol: number;
  offset: number;
}

class BitReader {
  private pos: number;
  private bits = 0;
  private n = 0;

  constructor(private d: Uint8Array, start: number) {
    this.pos = start;
  }

  private byte(): number {
    return this.pos < this.d.length ? this.d[this.pos++] : 0;
  }

  lsb(count: number): number {
    while (this.n < count) {
      this.bits |= this.byte() << this.n;
      this.n += 8;
    }
    const r = this.bits & ((1 << count) - 1);
    this.bits >>>= count;
    this.n -= count;
    return r;
  }

  msb(count: number): number {
    while (this.n < count) {
      this.bits = ((this.bits << 8) | this.byte()) >>> 0;
      this.n += 8;
    }
    const r = (this.bits >>> (this.n - count)) & ((1 << count) - 1);
    this.n -= count;
    this.bits &= (1 << this.n) - 1;
    return r;
  }
}

function unpackLZW(src: Uint8Array, start: number, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen);
  const br = new BitReader(src, start);
  const offsets = new Uint16Array(4096);
  const lengths = new Uint16Array(4096);
  let bitLen = 9;
  let tableSize = 258;
  let limit = 512;
  let w = 0;
  while (w < outLen) {
    const code = br.lsb(bitLen);
    if (code >= tableSize || code === 257) break;
    if (code === 256) {
      bitLen = 9;
      tableSize = 258;
      limit = 512;
      continue;
    }
    const newOff = w;
    if (code <= 255) out[w++] = code;
    else for (let i = 0; i < lengths[code] && w < outLen; i++) out[w++] = out[offsets[code] + i];
    if (tableSize >= 4096) continue;
    if (tableSize === limit && bitLen < 12) {
      bitLen++;
      limit = 1 << bitLen;
    }
    offsets[tableSize] = newOff;
    lengths[tableSize] = w - newOff + 1;
    tableSize++;
  }
  return out;
}

function unpackHuffman(src: Uint8Array, start: number, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen);
  const numNodes = src[start];
  const terminator = src[start + 1] | 0x100;
  const nodes = src.subarray(start + 2, start + 2 + numNodes * 2);
  const br = new BitReader(src, start + 2 + numNodes * 2);
  let w = 0;
  while (w < outLen) {
    let node = 0;
    let c: number;
    for (;;) {
      if (!nodes[node + 1]) {
        c = nodes[node] | (nodes[node + 1] << 8);
        break;
      }
      let next: number;
      if (br.msb(1)) {
        next = nodes[node + 1] & 0x0f;
        if (next === 0) {
          c = br.msb(8) | 0x100;
          break;
        }
      } else next = nodes[node + 1] >> 4;
      node += next << 1;
    }
    if (c === terminator) break;
    out[w++] = c & 0xff;
  }
  return out;
}

export class SciResources {
  private map = new Map<number, MapEntry>(); // key = type << 11 | number
  private cache = new Map<number, Uint8Array>();

  constructor(private files: GameFiles) {
    const m = files.get('RESOURCE.MAP');
    if (!m) throw new Error('Missing RESOURCE.MAP');
    for (let p = 0; p + 5 < m.length; p += 6) {
      const id = m[p] | (m[p + 1] << 8);
      const loc = (m[p + 2] | (m[p + 3] << 8) | (m[p + 4] << 16) | (m[p + 5] << 24)) >>> 0;
      if (id === 0xffff && loc === 0xffffffff) break;
      const vol = loc >>> 26;
      const offset = loc & 0x3ffffff;
      // Later entries for the same resource (e.g. on another disk) are duplicates.
      if (!this.map.has(id) && files.has(`RESOURCE.${String(vol).padStart(3, '0')}`)) this.map.set(id, { vol, offset });
    }
  }

  exists(type: ResType, n: number): boolean {
    return this.map.has((type << 11) | n);
  }

  list(type: ResType): number[] {
    const out: number[] = [];
    for (const id of this.map.keys()) if (id >> 11 === type) out.push(id & 0x7ff);
    return out.sort((a, b) => a - b);
  }

  /** Returns the decompressed resource, or null if it doesn't exist. */
  get(type: ResType, n: number): Uint8Array | null {
    const key = (type << 11) | n;
    const cached = this.cache.get(key);
    if (cached) return cached;
    // Patch files on disk (e.g. 0.SCR, 999.VOC) take priority, as in the original.
    const e = this.map.get(key);
    if (!e) return null;
    const vol = this.files.get(`RESOURCE.${String(e.vol).padStart(3, '0')}`)!;
    const o = e.offset;
    const id = vol[o] | (vol[o + 1] << 8);
    if (id !== key) throw new Error(`Resource header mismatch for ${RES_NAMES[type]}.${n}`);
    const compSize = (vol[o + 2] | (vol[o + 3] << 8)) - 4;
    const size = vol[o + 4] | (vol[o + 5] << 8);
    const method = vol[o + 6] | (vol[o + 7] << 8);
    const start = o + 8;
    let data: Uint8Array;
    if (method === 0) data = vol.slice(start, start + size);
    else if (method === 1) data = unpackLZW(vol, start, size);
    else if (method === 2) data = unpackHuffman(vol, start, size);
    else throw new Error(`Unsupported compression ${method} for ${RES_NAMES[type]}.${n} (${compSize} bytes)`);
    this.cache.set(key, data);
    return data;
  }
}
