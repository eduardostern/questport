// Shared browser renderer for the "AI images" modes (SCI and AGI): loads repainted art lazily and
// blends it with the original frame. See src/sci/ai-compose.ts for the blending rules.

import { EGA } from './palette';
import type { CelPlacement } from './sci/screen';
import { composeFrame, lookupCel, AI_SCALE, OUT_W, OUT_H, RgbaImage, ViewSheetManifest } from './sci/ai-compose';
import { drawRuns, drawMasked, TextRun, TEXT_FONT_FAMILY } from './sci/ai-text';

/** One frame of an engine, described for the AI renderer. */
export interface AiFrame {
  frame: Uint8Array; // 320x200 EGA indices
  owner: Int32Array; // what drew each pixel (see SciScreen.owner)
  placements: Map<number, CelPlacement>;
  forced: Uint8Array; // 1 = keep original
  base: { nr: number; mirrored: boolean; visual: Uint8Array } | null;
  picTop: number;
  picH: number;
  useArt: boolean;
  /** Erases bitmap text from the blended frame and returns the lines to redraw smoothly. */
  text?: (out: Uint32Array) => TextRun[];
  /** Pixels drawn last from the original frame (the mouse cursor). */
  topMask?: Uint8Array;
}

interface AiIndex {
  pics: Record<string, string>;
  views: Record<string, string>;
}

export class AiRenderer {
  private index: AiIndex = { pics: {}, views: {} };
  private backgrounds = new Map<string, RgbaImage | null>();
  private views = new Map<number, { m: ViewSheetManifest; sheets: (RgbaImage | null)[] } | null>();
  private out = document.createElement('canvas');
  private octx: CanvasRenderingContext2D;
  private img: ImageData;
  private px32: Uint32Array;
  private pal = new Uint32Array(EGA.map(([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0));
  private queued = false;
  private hasFrame = false;

  /** Reads a file of the art pack (plain files, or an encrypted published pack). */
  private readFile: (path: string) => Promise<Uint8Array>;

  constructor(
    dir: string,
    private canvas: HTMLCanvasElement,
    private getFrame: () => AiFrame | null,
    load?: (path: string) => Promise<Uint8Array>,
  ) {
    this.readFile =
      load ??
      (async (path) => {
        const r = await fetch(`${dir}/${path}`);
        if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`${path}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      });
    this.out.width = OUT_W;
    this.out.height = OUT_H;
    this.octx = this.out.getContext('2d')!;
    this.img = this.octx.createImageData(OUT_W, OUT_H);
    this.px32 = new Uint32Array(this.img.data.buffer);
  }

  /** Loads the index and the text font; returns how many repaints exist. */
  async load(): Promise<number> {
    try {
      const face = new FontFace(TEXT_FONT_FAMILY, 'url(fonts/text.ttf)');
      document.fonts.add(await face.load());
    } catch {
      /* without the font, text falls back to the browser's sans-serif */
    }
    try {
      const j = JSON.parse(new TextDecoder().decode(await this.readFile('index.json')));
      this.index = 'pics' in j ? { pics: j.pics ?? {}, views: j.views ?? {} } : { pics: j, views: {} };
    } catch {
      /* no repaints: everything stays original */
    }
    return Object.keys(this.index.pics).length + Object.keys(this.index.views).length;
  }

  /** Loads an image file of the pack and scales it to w x h pixels. */
  private async decode(path: string, w: number, h: number, mirrored = false): Promise<RgbaImage> {
    const bytes = await this.readFile(path);
    const im = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.imageSmoothingQuality = 'high';
    if (mirrored) {
      x.translate(w, 0);
      x.scale(-1, 1);
    }
    x.drawImage(im, 0, 0, w, h);
    im.close();
    return { w, h, px: new Uint32Array(x.getImageData(0, 0, w, h).data.buffer) };
  }

  private background(nr: number, mirrored: boolean, picH: number): RgbaImage | null {
    const key = `${nr}${mirrored ? '-m' : ''}`;
    if (this.backgrounds.has(key)) return this.backgrounds.get(key)!;
    const file = this.index.pics[nr];
    if (!file) return null;
    // Keep only the most recent rooms decoded (about 4 MB each).
    while (this.backgrounds.size >= 8) this.backgrounds.delete(this.backgrounds.keys().next().value!);
    this.backgrounds.set(key, null);
    this.decode(file, 320 * AI_SCALE, picH * AI_SCALE, mirrored).then(
      (img) => {
        this.backgrounds.set(key, img);
        this.redrawSoon();
      },
      () => this.backgrounds.delete(key),
    );
    return null;
  }

  private view(nr: number): { m: ViewSheetManifest; sheets: (RgbaImage | null)[] } | null {
    if (this.views.has(nr)) return this.views.get(nr)!;
    const file = this.index.views[nr];
    if (!file) return null;
    this.views.set(nr, null);
    void (async () => {
      try {
        const m: ViewSheetManifest = JSON.parse(new TextDecoder().decode(await this.readFile(file)));
        const entry = { m, sheets: m.sheets.map(() => null as RgbaImage | null) };
        await Promise.all(
          m.sheets.map(async (s, i) => {
            entry.sheets[i] = await this.decode(s.file, s.w * (m.xs ?? 1) * AI_SCALE, s.h * AI_SCALE);
          }),
        );
        this.views.set(nr, entry);
        this.redrawSoon();
      } catch {
        this.views.delete(nr);
      }
    })();
    return null;
  }

  private redrawSoon(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.redraw();
    });
  }

  /** Called whenever the engine presents a frame; blending runs at most once per display refresh. */
  present(): void {
    this.hasFrame = true;
    this.redrawSoon();
  }

  redraw(): void {
    if (!this.hasFrame) return;
    const f = this.getFrame();
    if (!f) return;
    const base = f.useArt ? f.base : null;
    composeFrame(
      {
        frame: f.frame,
        owner: f.owner,
        placements: f.placements,
        forced: f.forced,
        baseVisual: base?.visual ?? null,
        background: base ? this.background(base.nr, base.mirrored, f.picH) : null,
        picTop: f.picTop,
        cel: (v, l, c) => {
          if (!f.useArt) return null;
          const e = this.view(v);
          return e ? lookupCel(e.m, e.sheets, l, c) : null;
        },
        palette: this.pal,
      },
      this.px32,
    );
    const runs = f.text ? f.text(this.px32) : [];
    this.octx.putImageData(this.img, 0, 0);
    drawRuns(this.octx, runs, EGA);
    if (f.topMask) drawMasked(this.octx, f.frame, f.topMask, EGA);
    const ctx = this.canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.out, 0, 0, this.canvas.width, this.canvas.height);
  }
}
