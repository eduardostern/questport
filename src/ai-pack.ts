// Encrypted AI art packs. A pack is encrypted with a key derived from the original game files, so it can
// only be used by someone who loads that exact game. Works in browsers and Node (WebCrypto).

import type { GameFiles } from './resources';

const enc = new TextEncoder();

/** The game files a pack is tied to (small directory files that identify a release). */
export function keyFiles(files: GameFiles): string[] | null {
  const sci = ['RESOURCE.MAP', 'RESOURCE.001'];
  const agi = ['LOGDIR', 'PICDIR', 'VIEWDIR', 'SNDDIR'];
  if (sci.every((n) => files.has(n))) return sci;
  if (agi.every((n) => files.has(n))) return agi;
  return null;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export interface PackKey {
  id: string; // public pack name (a one-way hash; reveals nothing about the key)
  key: CryptoKey;
}

/** Derives the pack id and key from the game files, or null if the game isn't recognized. */
export async function packKey(files: GameFiles): Promise<PackKey | null> {
  const names = keyFiles(files);
  if (!names) return null;
  const parts: Uint8Array[] = [];
  for (const n of names) parts.push(enc.encode(`${n}\0`), await sha256(files.get(n)!));
  const material = await sha256(...parts);
  const id = hex(await sha256(enc.encode('questport-pack-id:'), material)).slice(0, 32);
  const raw = await sha256(enc.encode('questport-pack-key:'), material);
  const key = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id, key };
}

/** AES-GCM: 12-byte IV followed by the ciphertext. */
export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function decryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.subarray(0, 12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> }, key, data.subarray(12) as Uint8Array<ArrayBuffer>));
}

/** Loader for a published pack: fetches packs/<id>/<path>.bin and decrypts it. */
export function packLoader(base: string, pk: PackKey): (path: string) => Promise<Uint8Array> {
  return async (path) => {
    const r = await fetch(`${base}/${pk.id}/${path}.bin`);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return decryptBytes(pk.key, new Uint8Array(await r.arrayBuffer()));
  };
}
