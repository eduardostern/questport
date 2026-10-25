// AGI view decoder. A view has loops (usually one per facing direction); each loop has cels (frames).

export interface Cel {
  width: number;
  height: number;
  transparent: number;
  pixels: Uint8Array; // width * height color indices (already mirrored if needed)
}

export interface Loop {
  cels: Cel[];
}

export interface View {
  loops: Loop[];
  description: string;
}

function decodeCel(d: Uint8Array, off: number, loopNum: number): Cel {
  const width = d[off];
  const height = d[off + 1];
  const tm = d[off + 2];
  const transparent = tm & 0x0f;
  const mirrored = (tm & 0x80) !== 0 && ((tm >> 4) & 7) !== loopNum;
  const pixels = new Uint8Array(width * height).fill(transparent);
  let p = off + 3;
  for (let y = 0; y < height; y++) {
    let x = 0;
    for (;;) {
      const b = d[p++];
      if (b === 0 || b === undefined) break;
      const color = b >> 4;
      const n = b & 0x0f;
      for (let i = 0; i < n && x < width; i++, x++) {
        const px = mirrored ? width - 1 - x : x;
        pixels[y * width + px] = color;
      }
    }
  }
  return { width, height, transparent, pixels };
}

export function decodeView(d: Uint8Array): View {
  const numLoops = d[2];
  const descOff = d[3] | (d[4] << 8);
  const loops: Loop[] = [];
  for (let l = 0; l < numLoops; l++) {
    const lo = d[5 + l * 2] | (d[6 + l * 2] << 8);
    const numCels = d[lo];
    const cels: Cel[] = [];
    for (let c = 0; c < numCels; c++) {
      const co = lo + (d[lo + 1 + c * 2] | (d[lo + 2 + c * 2] << 8));
      cels.push(decodeCel(d, co, l));
    }
    loops.push({ cels });
  }
  let description = '';
  if (descOff) {
    for (let i = descOff; i < d.length && d[i]; i++) description += String.fromCharCode(d[i]);
  }
  return { loops, description };
}
