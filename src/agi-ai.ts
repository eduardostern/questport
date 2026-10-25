// "AI images" mode for AGI games: describes AGI interpreter frames for the shared AI renderer.

import type { Interpreter } from './interpreter';
import { forcedMask, AI_SCALE, OUT_W } from './sci/ai-compose';
import type { TextRun } from './sci/ai-text';
import { cellChar, cellFg, cellBg } from './screen';
import { EGA } from './palette';
import { PIC_W, PIC_H } from './picture';
import { AiRenderer, AiFrame } from './ai-render';

const PAL = EGA.map(([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0);

export class AgiAiBackdrop {
  readonly renderer: AiRenderer;
  private frame: Uint8Array | null = null;
  private forced = new Uint8Array(320 * 200);
  private cells = new Int32Array(40 * 25);
  private baseCache: { src: unknown; picTop: number; visual: Uint8Array } | null = null;

  constructor(
    dir: string,
    canvas: HTMLCanvasElement,
    private getInterp: () => Interpreter | null,
    load?: (path: string) => Promise<Uint8Array>,
  ) {
    this.renderer = new AiRenderer(dir, canvas, () => this.describe(), load);
  }

  load(): Promise<number> {
    return this.renderer.load();
  }

  present(frame: Uint8Array): void {
    this.frame = frame;
    this.renderer.present();
  }

  redraw(): void {
    this.renderer.redraw();
  }

  /** The room picture as it appears on screen (double-wide pixels below the status line). */
  private baseVisual(src: { nr: number; vis: Uint8Array }, picTop: number): Uint8Array {
    if (this.baseCache?.src === src && this.baseCache.picTop === picTop) return this.baseCache.visual;
    const v = new Uint8Array(320 * 200);
    for (let y = 0; y < PIC_H && picTop + y < 200; y++) {
      for (let x = 0; x < PIC_W; x++) {
        const c = src.vis[y * PIC_W + x];
        v[(picTop + y) * 320 + x * 2] = c;
        v[(picTop + y) * 320 + x * 2 + 1] = c;
      }
    }
    this.baseCache = { src, picTop, visual: v };
    return v;
  }

  private describe(): AiFrame | null {
    const it = this.getInterp();
    const frame = this.frame;
    if (!it || !frame) return null;
    const scr = it.screen;
    const picTop = scr.picRow * 8;
    const bp = it.basePicture;
    // Text drawn after compose (menu items) sits on the pixels layer.
    this.cells.set(scr.visibleCells);
    const late = scr.cells(scr.pixels);
    for (let i = 0; i < late.length; i++) if (late[i]) this.cells[i] = late[i];
    const cells = this.cells;
    return {
      frame,
      owner: scr.owner,
      placements: it.placements,
      forced: forcedMask(scr.windowRect ? [scr.windowRect] : [], this.forced),
      base: bp ? { nr: bp.nr, mirrored: false, visual: this.baseVisual(bp, picTop) } : null,
      picTop,
      picH: PIC_H,
      useArt: true,
      text: (out) => agiText(cells, out),
    };
  }
}

const printable = (ch: number) => ch >= 32 && ch <= 126;

/** Erases AGI's 8x8 text cells from the blended frame and returns them as lines to redraw. */
export function agiText(cells: Int32Array, out: Uint32Array): TextRun[] {
  const S = AI_SCALE;
  const runs: TextRun[] = [];
  for (let row = 0; row < 25; row++) {
    let run: (TextRun & { bg: number; lastInk: number }) | null = null;
    const flush = () => {
      if (run && run.lastInk >= 0) {
        run.text = run.text.slice(0, run.lastInk + 1);
        run.right = run.left + (run.lastInk + 1) * 8;
        runs.push(run);
      }
      run = null;
    };
    for (let col = 0; col < 40; col++) {
      const c = cells[row * 40 + col];
      const ch = cellChar(c);
      const bg = cellBg(c);
      if (!c || !printable(ch) || bg > 15) {
        flush();
        continue;
      }
      // Erase the bitmap glyph with its background color.
      for (let y = 0; y < 8 * S; y++) out.fill(PAL[bg], (row * 8 * S + y) * OUT_W + col * 8 * S, (row * 8 * S + y) * OUT_W + (col + 1) * 8 * S);
      const fg = cellFg(c);
      if (run && (run.color !== fg || run.bg !== bg)) flush();
      // AGI's fixed-width 8x8 letters are wide: use a larger font and allow more stretch.
      if (!run) run = { text: '', left: col * 8, top: row * 8, right: col * 8, h: 8, color: fg, greyed: false, bg, lastInk: -1, size: 1.15, maxStretch: 1.6 };
      run.text += String.fromCharCode(ch);
      if (ch !== 32) run.lastInk = run.text.length - 1;
    }
    flush();
  }
  return runs;
}
