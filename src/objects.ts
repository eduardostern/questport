// OBJECT file: inventory item names and their starting rooms (255 = carried by player).

import { decrypt } from './resources';

export interface InventoryItem {
  name: string;
  room: number;
}

function parse(d: Uint8Array): { items: InventoryItem[]; maxAnimated: number } | null {
  const textOff = d[0] | (d[1] << 8);
  if (textOff % 3 !== 0 || textOff + 3 > d.length) return null;
  const items: InventoryItem[] = [];
  for (let i = 0; i < textOff / 3; i++) {
    const p = 3 + i * 3;
    const off = (d[p] | (d[p + 1] << 8)) + 3;
    if (off >= d.length) return null;
    let name = '';
    for (let q = off; q < d.length && d[q]; q++) {
      if (d[q] < 32 || d[q] > 126) return null;
      name += String.fromCharCode(d[q]);
    }
    items.push({ name, room: d[p + 2] });
  }
  return { items, maxAnimated: d[2] };
}

export function decodeObjects(raw: Uint8Array): { items: InventoryItem[]; maxAnimated: number } {
  const plain = parse(raw);
  if (plain) return plain;
  const d = raw.slice();
  decrypt(d);
  const r = parse(d);
  if (!r) throw new Error('Could not decode OBJECT file');
  return r;
}
