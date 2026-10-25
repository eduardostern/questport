// Loads AGI v2 resources: directory files (LOGDIR/PICDIR/VIEWDIR/SNDDIR) point into VOL.n files.

export type GameFiles = Map<string, Uint8Array>; // upper-case file name -> contents

export const AVIS_DURGAN = 'Avis Durgan';

export function decrypt(data: Uint8Array, start = 0, end = data.length): void {
  for (let i = start; i < end; i++) {
    data[i] ^= AVIS_DURGAN.charCodeAt((i - start) % AVIS_DURGAN.length);
  }
}

export type ResType = 'logic' | 'picture' | 'view' | 'sound';

const DIR_FILES: Record<ResType, string> = {
  logic: 'LOGDIR',
  picture: 'PICDIR',
  view: 'VIEWDIR',
  sound: 'SNDDIR',
};

interface DirEntry {
  vol: number;
  offset: number;
}

export class ResourceManager {
  private dirs: Record<ResType, (DirEntry | null)[]>;

  constructor(private files: GameFiles) {
    this.dirs = {
      logic: this.readDir('logic'),
      picture: this.readDir('picture'),
      view: this.readDir('view'),
      sound: this.readDir('sound'),
    };
  }

  private readDir(type: ResType): (DirEntry | null)[] {
    const d = this.file(DIR_FILES[type]);
    const out: (DirEntry | null)[] = [];
    for (let i = 0; i + 2 < d.length; i += 3) {
      if (d[i] === 0xff && d[i + 1] === 0xff && d[i + 2] === 0xff) {
        out.push(null);
        continue;
      }
      const vol = d[i] >> 4;
      const offset = ((d[i] & 0x0f) << 16) | (d[i + 1] << 8) | d[i + 2];
      // Ignore entries that don't point at a valid resource header.
      const v = this.files.get(`VOL.${vol}`);
      if (!v || v[offset] !== 0x12 || v[offset + 1] !== 0x34) {
        out.push(null);
        continue;
      }
      out.push({ vol, offset });
    }
    return out;
  }

  file(name: string): Uint8Array {
    const f = this.files.get(name.toUpperCase());
    if (!f) throw new Error(`Missing game file ${name}`);
    return f;
  }

  hasFile(name: string): boolean {
    return this.files.has(name.toUpperCase());
  }

  exists(type: ResType, n: number): boolean {
    return !!this.dirs[type][n];
  }

  count(type: ResType): number {
    return this.dirs[type].length;
  }

  /** Returns a fresh copy of the resource data (without the 5-byte header). */
  load(type: ResType, n: number): Uint8Array {
    const e = this.dirs[type][n];
    if (!e) throw new Error(`${type} ${n} does not exist`);
    const vol = this.file(`VOL.${e.vol}`);
    const o = e.offset;
    if (vol[o] !== 0x12 || vol[o + 1] !== 0x34) {
      throw new Error(`Bad resource header for ${type} ${n} at VOL.${e.vol}:${o}`);
    }
    const len = vol[o + 3] | (vol[o + 4] << 8);
    return vol.slice(o + 5, o + 5 + len);
  }
}
