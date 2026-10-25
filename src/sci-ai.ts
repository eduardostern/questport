// "AI images" mode for SCI games: describes SCI engine frames for the shared AI renderer.

import type { SciEngine } from './sci/engine';
import { Window } from './sci/gfx';
import { forcedMask } from './sci/ai-compose';
import { eraseText } from './sci/ai-text';
import { AiRenderer, AiFrame } from './ai-render';

export class AiBackdrop {
  readonly renderer: AiRenderer;
  private shown: { nr: number; mirrored: boolean; visual: Uint8Array } | null = null;
  private frame: Uint8Array | null = null;
  private forced = new Uint8Array(320 * 200);

  constructor(
    dir: string,
    canvas: HTMLCanvasElement,
    private getEngine: () => SciEngine | undefined,
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

  private describe(): AiFrame | null {
    const engine = this.getEngine();
    const frame = this.frame;
    if (!engine || !frame) return null;
    const gfx = engine.gfx;
    const scr = gfx.screen;
    // Switch to a new room only once its picture is fully on screen (after the transition).
    if (!scr.picNotValid && !scr.pendingTransition) this.shown = gfx.basePicture;
    const t = gfx.wmgrPort.top;
    const rects = gfx.windowList
      .filter((w): w is Window => w instanceof Window && w !== gfx.picWind)
      .map((w) => ({ top: w.restoreRect.top + t, left: w.restoreRect.left, bottom: w.restoreRect.bottom + t, right: w.restoreRect.right }));
    const drop = engine.windows.menu.dropRect;
    if (drop) rects.push(drop);
    return {
      frame,
      owner: scr.outOwner,
      placements: scr.placements,
      forced: forcedMask(rects, this.forced, engine.cursorMask),
      base: this.shown,
      picTop: 10,
      picH: 190,
      useArt: !scr.pendingTransition,
      text: (out) => eraseText(scr.outOwner, scr.textGlyphs, engine.cursorMask, frame, out),
      topMask: engine.cursorMask,
    };
  }
}
