// Minimal FAT12 floppy image reader, so players can drop raw .ima/.img disk images.

export function readFat12(img: Uint8Array): Map<string, Uint8Array> | null {
  const dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
  if (img.length < 512) return null;
  const bps = dv.getUint16(11, true);
  const spc = img[13];
  const rsv = dv.getUint16(14, true);
  const nfats = img[16];
  const nroot = dv.getUint16(17, true);
  const spf = dv.getUint16(22, true);
  if (bps !== 512 || !spc || !nfats || !nroot || !spf) return null;
  const fat = img.subarray(rsv * bps, (rsv + spf) * bps);
  const rootOff = (rsv + nfats * spf) * bps;
  const dataOff = rootOff + nroot * 32;
  const clus = bps * spc;
  const next = (c: number) => {
    const o = (c * 3) >> 1;
    const v = fat[o] | (fat[o + 1] << 8);
    return c & 1 ? v >> 4 : v & 0xfff;
  };
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < nroot; i++) {
    const e = rootOff + i * 32;
    if (img[e] === 0 || img[e] === 0xe5 || img[e + 11] & 0x18) continue;
    const name = String.fromCharCode(...img.subarray(e, e + 8)).trim();
    const ext = String.fromCharCode(...img.subarray(e + 8, e + 11)).trim();
    let c = dv.getUint16(e + 26, true);
    const size = dv.getUint32(e + 28, true);
    const out = new Uint8Array(size);
    let p = 0;
    for (let guard = 0; c >= 2 && c < 0xff8 && p < size && guard < 4096; guard++) {
      const src = img.subarray(dataOff + (c - 2) * clus, dataOff + (c - 1) * clus);
      const n = Math.min(clus, size - p);
      out.set(src.subarray(0, n), p);
      p += n;
      c = next(c);
    }
    files.set((ext ? `${name}.${ext}` : name).toUpperCase(), out);
  }
  return files;
}
