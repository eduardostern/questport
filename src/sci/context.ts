// The shared context handed to every kernel module.

import type { SciVM } from './vm';
import type { SciGfx, Rect } from './gfx';

export interface SciContext {
  vm: SciVM;
  gfx: SciGfx;
  /** Milliseconds since an arbitrary epoch. */
  now(): number;
  /**
   * Graphics hooks shared between kernel modules. The animation module provides
   * reAnimate (redraws cast members inside a screen-coordinate rect after a window
   * closes); the windows module provides drawStatus etc. Missing hooks are no-ops.
   */
  hooks: {
    /**
     * Sierra's ReAnimate(rect): redraw the last cast over `r` and show it. Called by the windows module
     * (kDisposeWindow with reanimate, kGraph RedrawBox, kDisplay restore-under, menu close) with `r` in
     * SCREEN coordinates and gfx.curPort temporarily set to gfx.picWind. If absent, the rect is just shown.
     */
    reAnimate?: (r: Rect) => void;
    /** kShakeScreen(count, directions: 1=vertical, 2=horizontal). The host animates it (non-blocking). */
    shakeScreen?: (count: number, directions: number) => void;
    /** Called when the visible screen changed and should be presented to the player. */
    present?: () => void;
  };
  /** Mouse/cursor state (screen coordinates) maintained by the event module. */
  mouse: { x: number; y: number; visible: boolean; view: number; loop: number; cel: number };
  /**
   * Synchronous input source for interactive kernel calls (kMenuSelect's menu loop): returns the next
   * already-queued event (key/mouse down/up) and removes it from the queue, or null if none is queued.
   * Event fields follow kGetEvent: type 1=mouseDown 2=mouseUp 4=keyDown; message = key code; x/y screen coords.
   */
  waitInput?: () => { type: number; message: number; modifiers: number; x: number; y: number } | null;
  /**
   * Said-spec matcher for kMenuSelect on said events (type 0x80): matches the said spec at `spec` (script
   * pointer) against the last parsed sentence; returns true unless SAID_NO_MATCH.
   */
  said?: (spec: number) => boolean;
}
