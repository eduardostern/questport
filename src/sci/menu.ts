// SCI0 menu bar (kAddMenu/kSetMenu/kGetMenu/kDrawMenuBar/kMenuSelect), ported from ScummVM's GfxMenu.
//
// Sierra's kMenuSelect ran a blocking event loop while a menu was pulled down. We can't block the JS
// thread, so the interactive part is a state machine (MenuSession) fed one event at a time:
//
//  1. kMenuSelect gets an activating event (Esc key, or mouse-down on the bar at y < 10). It opens the
//     menu and drains ctx.waitInput() (already-queued events) into the session.
//  2. If the session finishes during the drain, kMenuSelect returns the chosen item synchronously,
//     exactly like Sierra did.
//  3. Otherwise the menu stays open and kMenuSelect returns 0 with the event claimed. While
//     `isOpen()` is true the engine must NOT run the VM (Sierra's loop blocked the game too) and must
//     pass every new input event to `feed(ev)` (type 0 events with x/y = mouse moves, for mouse tracking).
//     When the session finishes, the screen is restored and the selection is remembered; the engine then
//     resumes the VM and should queue a keyDown event with message 0 so the scripts call kMenuSelect
//     again, which returns (and claims) the pending selection.

import type { SciGfx, Rect, Port } from './gfx';
import { rect } from './gfx';
import { MASK_VIS } from './screen';
import { SciText } from './text';

export const MENU_ATTR_SAID = 0x6d;
export const MENU_ATTR_TEXT = 0x6e;
export const MENU_ATTR_KEYPRESS = 0x6f;
export const MENU_ATTR_ENABLED = 0x70;
export const MENU_ATTR_TAG = 0x71;

const EV_MOUSE_DOWN = 1;
const EV_MOUSE_UP = 2;
const EV_KEY_DOWN = 4;
const EV_SAID = 0x80;

const KEY_ESC = 27;
const KEY_ENTER = 13;
const KEY_TAB = 9;
const KEY_UP = 72 << 8;
const KEY_DOWN = 80 << 8;
const KEY_LEFT = 75 << 8;
const KEY_RIGHT = 77 << 8;
const MOD_CTRL = 4;
const MOD_ALT = 8;
const MOD_NONSTICKY = 0x0f;

export interface MenuEvent {
  type: number;
  message: number;
  modifiers: number;
  x: number;
  y: number;
}

interface MenuEntry {
  id: number;
  text: string;
  textWidth: number;
}

interface MenuItem {
  menuId: number;
  id: number;
  enabled: boolean;
  tag: number;
  keyPress: number;
  keyModifier: number;
  separatorLine: boolean;
  saidVmPtr: number;
  text: string;
  textVmPtr: number;
  textWidth: number;
  textRightAligned: string;
  textRightAlignedWidth: number;
}

export interface MenuHost {
  gfx: SciGfx;
  text: SciText;
  /** Redraws cast over a port-relative rect of the current port (Sierra's kGraph RedrawBox). */
  redrawBox(r: Rect): void;
  /** Reads a string from VM memory. */
  getString(ptr: number): string;
  /** Said matcher for said events; undefined = said events never match. */
  said?: (spec: number) => boolean;
  /** Cursor show/hide around interactive sessions. */
  setCursorVisible?(v: boolean): boolean;
}

const MENU_BAR_RECT = rect(0, 0, 9, 320);
const MENU_PORT_RECT = rect(0, 0, 10, 320);
const MENU_LINE = rect(9, 0, 10, 320);

type SessionResult = { done: false } | { done: true; item: MenuItem | null };

export class SciMenu {
  list: MenuEntry[] = [];
  items: MenuItem[] = [];
  private curMenuId = 1;
  private curItemId = 1;
  private menuRect: Rect = rect(0, 0, 0, 0);
  private menuSaveHandle = 0;
  /** Screen rect of the pulled-down menu box while it is shown. */
  dropRect: { top: number; left: number; bottom: number; right: number } | null = null;
  private barSaveHandle = 0;
  private oldPort: Port | null = null;
  private session: KeyboardSession | MouseSession | null = null;
  private pending: MenuItem | null = null;
  private prevCursor: boolean | undefined;

  constructor(private host: MenuHost) {}

  private get gfx() {
    return this.host.gfx;
  }
  private get t() {
    return this.host.text;
  }

  reset(): void {
    this.list = [];
    this.items = [];
    this.curMenuId = 1;
    this.curItemId = 1;
  }

  // ------------------------------------------------------------ kAddMenu

  addEntry(title: string, content: string, contentVmPtr: number): void {
    const listSize = this.list.length + 1;
    this.list.push({ id: listSize, text: title, textWidth: 0 });
    const chars = content.split('');
    const size = chars.length;
    let curPos = 0;
    let itemCount = 0;
    do {
      itemCount++;
      const item: MenuItem = {
        menuId: listSize, id: itemCount, enabled: true, tag: 0, keyPress: 0, keyModifier: 0, separatorLine: false,
        saidVmPtr: 0, text: '', textVmPtr: 0, textWidth: 0, textRightAligned: '', textRightAlignedWidth: 0,
      };
      const beginPos = curPos;
      let tagPos = 0, rightAlignedPos = 0, controlPos = 0, altPos = 0, functionPos = 0;
      while (curPos < size && chars[curPos] !== ':') {
        switch (chars[curPos]) {
          case '=':
            if (rightAlignedPos === curPos - 1) break; // right aligned "=" (animation speed)
            tagPos = curPos;
            break;
          case '`':
            rightAlignedPos = curPos;
            break;
          case '^':
            controlPos = curPos;
            break;
          case '@':
            altPos = curPos;
            break;
          case '#':
            if (rightAlignedPos) functionPos = curPos;
            break;
        }
        curPos++;
      }
      const endPos = curPos;
      if (controlPos && controlPos + 1 < size) {
        chars[controlPos] = '\x03';
        item.keyModifier = MOD_CTRL;
        item.keyPress = chars[controlPos + 1].toLowerCase().charCodeAt(0);
        chars[controlPos + 1] = chars[controlPos + 1].toUpperCase();
      }
      if (altPos && altPos + 1 < size) {
        chars[altPos] = '\x02';
        item.keyModifier = MOD_ALT;
        item.keyPress = chars[altPos + 1].toLowerCase().charCodeAt(0);
        chars[altPos + 1] = chars[altPos + 1].toUpperCase();
      }
      if (functionPos && functionPos + 1 < size) {
        chars[functionPos] = 'F';
        const d = chars[functionPos + 1];
        const n = d === '0' ? 10 : Number(d);
        if (n >= 1 && n <= 10) item.keyPress = (58 + n) << 8;
      }
      let tempPos = endPos;
      if (rightAlignedPos) tempPos = rightAlignedPos;
      else if (tagPos) tempPos = tagPos;
      let separatorCount = 0;
      for (let p = beginPos; p < tempPos; p++) {
        const c = chars[p];
        if (c === '!' || c === '-' || c === ' ') separatorCount++;
        else if (c === '%' || c === '#') {
          separatorCount += 2;
          p++;
        }
      }
      if (separatorCount === tempPos - beginPos) item.separatorLine = true;
      else {
        item.text = chars.slice(beginPos, tempPos).join('');
        const ci = item.text.indexOf('Ctrl-');
        if (ci >= 0) {
          item.keyModifier = MOD_CTRL;
          item.keyPress = (item.text[ci + 5] ?? '').toLowerCase().charCodeAt(0) || 0;
        }
      }
      item.textVmPtr = contentVmPtr ? (contentVmPtr & 0xffff0000) | (((contentVmPtr & 0xffff) + beginPos) & 0xffff) : 0;
      item.textVmPtr >>>= 0;
      if (rightAlignedPos) {
        const ra = rightAlignedPos + 1;
        let end = endPos;
        if (tagPos && tagPos >= ra) end = tagPos;
        let s = chars.slice(ra, end).join('');
        if (s.endsWith(' ')) s = s.slice(0, -1);
        if (s === '-' || s === '+' || s === '=') item.keyPress = s.charCodeAt(0);
        if (item.keyPress === 68 << 8) s = s.replace('F0', 'F10');
        item.textRightAligned = s;
      }
      if (tagPos) {
        // ScummVM reads the number after functionPos here (a bug); Sierra's tag follows the '='.
        item.tag = parseInt(chars.slice(tagPos + 1, endPos).join(''), 10) || 0;
      }
      curPos = endPos + 1;
      this.items.push(item);
    } while (curPos < size);
  }

  findItem(menuId: number, itemId: number): MenuItem | undefined {
    return this.items.find((i) => i.menuId === menuId && i.id === itemId);
  }

  // ------------------------------------------------------------ kSetMenu / kGetMenu

  setAttribute(menuId: number, itemId: number, attr: number, value: number): void {
    const item = this.findItem(menuId, itemId);
    if (!item) return;
    switch (attr) {
      case MENU_ATTR_ENABLED:
        item.enabled = value !== 0;
        break;
      case MENU_ATTR_SAID:
        item.saidVmPtr = value;
        break;
      case MENU_ATTR_TEXT:
        item.text = this.host.getString(value);
        item.textVmPtr = value;
        break;
      case MENU_ATTR_KEYPRESS: {
        const k = value & 0xffff;
        item.keyPress = k < 256 ? String.fromCharCode(k).toLowerCase().charCodeAt(0) : k;
        item.keyModifier = 0;
        break;
      }
      case MENU_ATTR_TAG:
        item.tag = value & 0xffff;
        break;
    }
  }

  getAttribute(menuId: number, itemId: number, attr: number): number {
    const item = this.findItem(menuId, itemId);
    if (!item) return 0;
    switch (attr) {
      case MENU_ATTR_ENABLED:
        return item.enabled ? 1 : 0;
      case MENU_ATTR_SAID:
        return item.saidVmPtr;
      case MENU_ATTR_TEXT:
        return item.textVmPtr;
      case MENU_ATTR_KEYPRESS:
        return item.keyPress & 0xffff;
      case MENU_ATTR_TAG:
        return item.tag & 0xffff;
    }
    return 0;
  }

  // ------------------------------------------------------------ drawing

  private calculateMenuWidth(): void {
    for (const m of this.list) m.textWidth = this.gfx.stringWidth(m.text, 0);
  }

  private calculateMenuAndItemWidth(): void {
    this.calculateMenuWidth();
    for (const i of this.items) {
      i.textWidth = this.gfx.stringWidth(i.text, 0);
      i.textRightAlignedWidth = this.gfx.stringWidth(i.textRightAligned, 0);
    }
  }

  private drawBar(): void {
    this.gfx.fillRect(MENU_BAR_RECT, MASK_VIS, 15);
    this.gfx.fillRect(MENU_LINE, MASK_VIS, 0);
    this.gfx.curPort.penClr = 0;
    this.t.moveTo(8, 1);
    for (const m of this.list) this.t.drawString(m.text);
  }

  drawMenuBar(): void {
    const old = this.gfx.setPort(this.gfx.menuPort);
    this.calculateMenuWidth();
    this.drawBar();
    this.gfx.bitsShow(MENU_BAR_RECT);
    this.gfx.setPort(old);
  }

  drawStatus(text: string, pen: number, back: number): void {
    const old = this.gfx.setPort(this.gfx.menuPort);
    this.gfx.fillRect(MENU_BAR_RECT, MASK_VIS, back);
    this.gfx.curPort.penClr = pen;
    this.t.moveTo(0, 1);
    this.t.drawStatus(text);
    this.gfx.bitsShow(MENU_BAR_RECT);
    // ScummVM also redraws the black line under the status bar (Sierra never erased it).
    this.gfx.fillRect(MENU_LINE, MASK_VIS, 0);
    this.gfx.bitsShow(MENU_LINE);
    this.gfx.setPort(old);
  }

  private removeMenu(): void {
    if (!this.menuSaveHandle) return;
    this.gfx.bitsRestore(this.menuSaveHandle);
    this.menuSaveHandle = 0;
    this.dropRect = null;
    this.gfx.bitsShow(rect(this.menuRect.top, this.menuRect.left, this.menuRect.top + 1, this.menuRect.right));
    this.host.redrawBox(this.menuRect);
  }

  private drawMenu(oldMenuId: number, newMenuId: number): void {
    const gfx = this.gfx;
    this.removeMenu();
    const mr = this.menuRect;
    mr.top = MENU_BAR_RECT.bottom;
    const textRect = rect(MENU_BAR_RECT.top, 7, MENU_BAR_RECT.bottom, 7);
    let listNr = 0;
    for (const m of this.list) {
      listNr++;
      textRect.left = textRect.right;
      textRect.right += m.textWidth;
      if (listNr === newMenuId) mr.left = textRect.left;
      if (listNr === newMenuId || listNr === oldMenuId)
        gfx.invertRect(rect(textRect.top, textRect.left + 1, textRect.bottom, textRect.right + 1));
    }
    gfx.bitsShow(MENU_BAR_RECT);
    mr.bottom = mr.top + 2;
    let maxW = 0, maxRA = 0;
    const fh = gfx.curPort.fontHeight;
    for (const i of this.items) {
      if (i.menuId !== newMenuId) continue;
      mr.bottom += fh;
      maxW = Math.max(maxW, i.textWidth);
      maxRA = Math.max(maxRA, i.textRightAlignedWidth);
    }
    mr.right = mr.left + 16 + 4 + 2 + maxW + maxRA;
    if (!maxRA) mr.right -= 5;
    if (mr.right > 320) {
      const d = mr.right - 320;
      mr.left -= d;
      mr.right -= d;
    }
    this.menuSaveHandle = gfx.bitsSave(mr, MASK_VIS);
    this.dropRect = { ...mr };
    gfx.fillRect(mr, MASK_VIS, 0);
    mr.left++;
    mr.right--;
    mr.bottom--;
    gfx.fillRect(mr, MASK_VIS, 15);
    mr.left += 8;
    let topPos = mr.top + 1;
    for (const i of this.items) {
      if (i.menuId !== newMenuId) continue;
      if (!i.separatorLine) {
        gfx.curPort.greyedOutput = !i.enabled;
        this.t.moveTo(mr.left, topPos);
        this.t.drawString(i.text);
        this.t.moveTo(mr.right - i.textRightAlignedWidth - 5, topPos);
        this.t.drawString(i.textRightAligned);
      } else {
        const y = topPos + (fh >> 1) - 1;
        for (let x = mr.left - 7; x < mr.right - 1; x += 2) gfx.screen.putPixel(x, y, MASK_VIS, 0, 0, 0);
      }
      topPos += fh;
    }
    gfx.curPort.greyedOutput = false;
    gfx.fillRect(MENU_LINE, MASK_VIS, 0);
    mr.left -= 9;
    mr.right++;
    mr.bottom++;
    gfx.bitsShow(mr);
  }

  private invertMenuSelection(itemId: number): void {
    if (itemId === 0) return;
    const fh = this.gfx.curPort.fontHeight;
    const r = { ...this.menuRect };
    r.top += (itemId - 1) * fh + 1;
    r.bottom = r.top + fh;
    r.left++;
    r.right--;
    this.gfx.invertRect(r);
    this.gfx.bitsShow(r);
  }

  private interactiveGetItem(menuId: number, itemId: number, menuChanged: boolean): MenuItem {
    if (menuId > this.list.length) menuId = 1;
    if (menuId === 0) menuId = this.list.length;
    let first: MenuItem | null = null;
    let last: MenuItem | null = null;
    for (const i of this.items) {
      if (i.menuId !== menuId) continue;
      if (i.id === itemId) return i;
      if (!first) first = i;
      if (!last || i.id > last.id) last = i;
    }
    return (itemId === 0 || menuChanged ? last : first)!;
  }

  private mouseFindMenuSelection(x: number): number {
    let start = 8;
    for (const m of this.list) {
      if (x >= start && x < start + m.textWidth) return m.id;
      start += m.textWidth;
    }
    return 0;
  }

  private mouseFindMenuItemSelection(x: number, y: number, menuId: number): number {
    if (!menuId) return 0;
    if (x < this.menuRect.left || x >= this.menuRect.right) return 0;
    let yStart = 10;
    let itemId = 0;
    const fh = this.gfx.curPort.fontHeight;
    for (const i of this.items) {
      if (i.menuId !== menuId) continue;
      yStart += fh;
      if (!itemId && yStart > y) itemId = i.id;
    }
    return itemId;
  }

  // ------------------------------------------------------------ interactive sessions

  /** True while a pulled-down menu is waiting for input (engine must feed events, not run the VM). */
  isOpen(): boolean {
    return this.session !== null;
  }

  private openCommon(): void {
    this.oldPort = this.gfx.setPort(this.gfx.menuPort);
    this.calculateMenuAndItemWidth();
    this.barSaveHandle = this.gfx.bitsSave(MENU_PORT_RECT, MASK_VIS);
    this.gfx.curPort.penClr = 0;
    this.gfx.curPort.backClr = 15;
    this.drawBar();
  }

  private startKeyboard(): void {
    this.openCommon();
    const s = new KeyboardSession(this);
    this.session = s;
    const cur = this.findItem(this.curMenuId, this.curItemId) ?? this.items[0];
    s.cur = cur;
    s.newMenuId = cur.menuId;
    s.newItemId = cur.id;
    this.drawMenu(0, cur.menuId);
    this.invertMenuSelection(cur.id);
    this.gfx.bitsShow(MENU_PORT_RECT);
    this.gfx.bitsShow(this.menuRect);
  }

  private startMouse(): void {
    this.openCommon();
    this.session = new MouseSession(this);
    this.gfx.bitsShow(MENU_PORT_RECT);
  }

  /** Closes the menu and restores the screen (end of Sierra's kMenuSelect). */
  private close(): void {
    if (this.menuSaveHandle) this.removeMenu();
    if (this.barSaveHandle) {
      this.gfx.bitsRestore(this.barSaveHandle);
      this.gfx.bitsShow(MENU_PORT_RECT);
      this.barSaveHandle = 0;
    }
    if (this.oldPort) {
      this.gfx.setPort(this.oldPort);
      this.oldPort = null;
    }
    this.session = null;
    if (this.prevCursor === false) this.host.setCursorVisible?.(false);
    this.prevCursor = undefined;
  }

  /** Feeds one event to the open menu. Returns true when the menu closed. */
  feed(ev: MenuEvent): boolean {
    if (!this.session) return true;
    const port = this.gfx.setPort(this.gfx.menuPort);
    const r = this.session.feed(ev);
    this.gfx.setPort(port);
    if (!r.done) return false;
    this.close();
    this.pending = r.item;
    return true;
  }

  /**
   * kMenuSelect. `getEvent` reads the event object's fields; returns the item (menu << 8 | item) or 0,
   * and whether the event is to be claimed.
   */
  select(ev: MenuEvent, nextInput?: () => MenuEvent | null): { result: number; claimed: boolean } {
    // A selection made in a previous (asynchronous) session is delivered on the next call.
    if (this.pending && !this.session) {
      const it = this.pending;
      this.pending = null;
      return { result: (it.menuId << 8) | it.id, claimed: true };
    }
    let item: MenuItem | null = null;
    let forceClaimed = false;
    let interactive = false;
    switch (ev.type) {
      case EV_KEY_DOWN: {
        let key = ev.message & 0xffff;
        let mod = ev.modifiers;
        if ((mod & MOD_NONSTICKY) === MOD_CTRL && key > 0 && key < 27) key += 96;
        if (key === 0) break;
        if (key === KEY_ESC) {
          if (!this.items.length) break;
          this.startKeyboard();
          interactive = true;
          forceClaimed = true;
          break;
        }
        if (key === KEY_TAB) {
          mod = MOD_CTRL;
          key = 'i'.charCodeAt(0);
        }
        mod &= 0xff;
        item = this.items.find((i) => i.keyPress === key && i.keyModifier === mod && i.enabled) ?? null;
        break;
      }
      case EV_SAID:
        if (this.host.said) item = this.items.find((i) => i.saidVmPtr && i.enabled && this.host.said!(i.saidVmPtr)) ?? null;
        break;
      case EV_MOUSE_DOWN:
        if (ev.y < 10 && this.items.length) {
          this.startMouse();
          // The press itself starts tracking at its position.
          this.feed({ type: 0, message: 0, modifiers: 0, x: ev.x, y: ev.y });
          interactive = true;
          forceClaimed = true;
        }
        break;
    }
    if (interactive) {
      this.prevCursor = this.host.setCursorVisible?.(true);
      while (this.session && nextInput) {
        const e = nextInput();
        if (!e) break;
        this.feed(e);
      }
      if (this.session) {
        // Still open: the engine keeps feeding events (see header). Selection is delivered later.
        return { result: 0, claimed: true };
      }
      item = this.pending;
      this.pending = null;
    }
    if (item) return { result: (item.menuId << 8) | item.id, claimed: true };
    return { result: 0, claimed: forceClaimed };
  }

  // exposed to sessions
  /** @internal */ _drawMenu(o: number, n: number) {
    this.drawMenu(o, n);
  }
  /** @internal */ _invert(id: number) {
    this.invertMenuSelection(id);
  }
  /** @internal */ _getItem(m: number, i: number, ch: boolean) {
    return this.interactiveGetItem(m, i, ch);
  }
  /** @internal */ _findMenu(x: number) {
    return this.mouseFindMenuSelection(x);
  }
  /** @internal */ _findItem(x: number, y: number, m: number) {
    return this.mouseFindMenuItemSelection(x, y, m);
  }
  /** @internal */ _remember(it: MenuItem) {
    this.curMenuId = it.menuId;
    this.curItemId = it.id;
  }
  /** @internal */ _showBar() {
    this.gfx.bitsShow(MENU_BAR_RECT);
  }
}

/** Sierra's keyboard-driven menu loop (opened with Esc), one event per feed(). */
class KeyboardSession {
  cur!: MenuItem;
  newMenuId = 0;
  newItemId = 0;
  constructor(private m: SciMenu) {}

  feed(ev: MenuEvent): SessionResult {
    const m = this.m;
    if (ev.type === EV_KEY_DOWN) {
      let ch = ev.message & 0xffff;
      let newEntry = this.cur;
      do {
        switch (ch) {
          case KEY_ESC:
            m._remember(this.cur);
            return { done: true, item: null };
          case KEY_ENTER:
            if (this.cur.enabled) {
              m._remember(this.cur);
              return { done: true, item: this.cur };
            }
            break;
          case KEY_LEFT:
            this.newMenuId--;
            this.newItemId = 1;
            break;
          case KEY_RIGHT:
            this.newMenuId++;
            this.newItemId = 1;
            break;
          case KEY_UP:
            this.newItemId--;
            break;
          case KEY_DOWN:
            this.newItemId++;
            break;
        }
        if (this.newMenuId !== this.cur.menuId || this.newItemId !== this.cur.id) {
          newEntry = m._getItem(this.newMenuId, this.newItemId, this.newMenuId !== this.cur.menuId);
          this.newMenuId = newEntry.menuId;
          this.newItemId = newEntry.id;
          if (ch === KEY_LEFT || ch === KEY_RIGHT) ch = KEY_DOWN;
        }
      } while (newEntry.separatorLine);
      if (this.newMenuId !== this.cur.menuId || this.newItemId !== this.cur.id) {
        if (this.newMenuId !== this.cur.menuId) m._drawMenu(this.cur.menuId, this.newMenuId);
        else m._invert(this.cur.id);
        m._invert(this.newItemId);
        this.cur = newEntry;
      }
    } else if (ev.type === EV_MOUSE_DOWN) {
      if (ev.y < 10) {
        const menuId = m._findMenu(ev.x);
        if (menuId) {
          this.newMenuId = menuId;
          this.newItemId = 1;
          const ne = m._getItem(menuId, 1, menuId !== this.cur.menuId);
          if (menuId !== this.cur.menuId) m._drawMenu(this.cur.menuId, menuId);
          else m._invert(this.cur.id);
          m._invert(1);
          this.cur = ne;
        } else this.newMenuId = this.cur.menuId;
      } else {
        const itemId = m._findItem(ev.x, ev.y, this.newMenuId);
        if (itemId) {
          const ne = m._getItem(this.newMenuId, itemId, false);
          if (ne.enabled && !ne.separatorLine) {
            m._remember(ne);
            return { done: true, item: ne };
          }
        }
        this.newItemId = this.cur.id;
      }
    }
    return { done: false };
  }
}

/** Sierra's mouse-driven menu loop: track while the button is held, choose on release. */
class MouseSession {
  private curMenuId = 0;
  private curItemId = 0;
  private newMenuId = 0;
  private firstMenuChange = true;
  private cur: MenuItem | null = null;
  constructor(private m: SciMenu) {}

  feed(ev: MenuEvent): SessionResult {
    const m = this.m;
    if (ev.type === EV_MOUSE_UP) {
      if (!this.curMenuId || !this.curItemId || !this.cur) return { done: true, item: null };
      if (!this.cur.enabled || this.cur.separatorLine) return { done: true, item: null };
      return { done: true, item: this.cur };
    }
    let newItemId: number;
    if (ev.y < 10) {
      this.newMenuId = m._findMenu(ev.x);
      newItemId = 0;
    } else {
      newItemId = m._findItem(ev.x, ev.y, this.newMenuId);
      this.cur = this.curMenuId ? m._getItem(this.curMenuId, newItemId, false) : null;
    }
    if (newItemId !== this.curItemId) {
      m._invert(this.curItemId);
      m._invert(newItemId);
      this.curItemId = newItemId;
    }
    if (this.newMenuId !== this.curMenuId) {
      m._drawMenu(this.curMenuId, this.newMenuId);
      if (this.firstMenuChange) {
        m._showBar();
        this.firstMenuChange = false;
      }
      this.curMenuId = this.newMenuId;
    }
    return { done: false };
  }
}
