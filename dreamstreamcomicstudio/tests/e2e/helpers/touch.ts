// Touch gestures (P1-QA; mobile.md §10.4 editor.touch.spec.ts).
//
// Chromium: real multi-touch through CDP `Input.dispatchTouchEvent` (pointerType "touch", two
// fingers for pinch, long-press with a hold). WebKit (QA_WEBKIT=1) has no CDP; it gets the
// single-touch subset through page.touchscreen.tap and the specs skip multi-finger steps there.

import type { CDPSession, Page } from '@playwright/test';

export interface Pt {
  x: number;
  y: number;
}

type TouchPoint = { x: number; y: number; id: number; radiusX?: number; radiusY?: number; force?: number };

export class Touch {
  private cdp: CDPSession | null = null;
  constructor(private readonly page: Page) {}

  /** Multi-touch is available (Chromium / CDP). */
  async supported(): Promise<boolean> {
    try {
      await this.session();
      return true;
    } catch {
      return false;
    }
  }

  private async session(): Promise<CDPSession> {
    if (!this.cdp) this.cdp = await this.page.context().newCDPSession(this.page);
    return this.cdp;
  }

  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: TouchPoint[]) {
    const cdp = await this.session();
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ radiusX: 4, radiusY: 4, force: 1, ...p })) });
  }

  async tap(p: Pt): Promise<void> {
    if (!(await this.supported())) return this.page.touchscreen.tap(p.x, p.y);
    await this.send('touchStart', [{ ...p, id: 1 }]);
    await this.page.waitForTimeout(40);
    await this.send('touchEnd', []);
  }

  async doubleTap(p: Pt): Promise<void> {
    await this.tap(p);
    await this.page.waitForTimeout(90);
    await this.tap(p);
  }

  /** One finger: down at `from`, optional hold, move in `steps`, up at `to`. */
  async drag(from: Pt, to: Pt, opts: { holdMs?: number; steps?: number; stepMs?: number; release?: boolean } = {}): Promise<void> {
    const steps = opts.steps ?? 8;
    await this.send('touchStart', [{ ...from, id: 1 }]);
    if (opts.holdMs) await this.page.waitForTimeout(opts.holdMs);
    for (let i = 1; i <= steps; i++) {
      await this.send('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 }]);
      await this.page.waitForTimeout(opts.stepMs ?? 16);
    }
    if (opts.release !== false) await this.send('touchEnd', []);
  }

  /** Hold one finger still (long-press). */
  async longPress(p: Pt, ms = 520): Promise<void> {
    await this.send('touchStart', [{ ...p, id: 1 }]);
    await this.page.waitForTimeout(ms);
    await this.send('touchEnd', []);
  }

  /** Two fingers spread symmetrically around `center` from `fromDist` to `toDist` px apart. */
  async pinch(center: Pt, fromDist: number, toDist: number, steps = 10): Promise<void> {
    const at = (d: number): TouchPoint[] => [
      { x: center.x - d / 2, y: center.y, id: 1 },
      { x: center.x + d / 2, y: center.y, id: 2 }
    ];
    await this.send('touchStart', at(fromDist));
    for (let i = 1; i <= steps; i++) {
      await this.send('touchMove', at(fromDist + ((toDist - fromDist) * i) / steps));
      await this.page.waitForTimeout(16);
    }
    await this.send('touchEnd', []);
  }

  /** Start a one-finger drag, then add a second finger mid-gesture (the gesture must cancel). */
  async dragThenSecondFinger(from: Pt, mid: Pt, second: Pt): Promise<void> {
    await this.send('touchStart', [{ ...from, id: 1 }]);
    for (let i = 1; i <= 4; i++) {
      await this.send('touchMove', [{ x: from.x + ((mid.x - from.x) * i) / 4, y: from.y + ((mid.y - from.y) * i) / 4, id: 1 }]);
      await this.page.waitForTimeout(16);
    }
    await this.send('touchStart', [
      { ...mid, id: 1 },
      { ...second, id: 2 }
    ]);
    await this.page.waitForTimeout(30);
    await this.send('touchMove', [
      { x: mid.x + 20, y: mid.y, id: 1 },
      { x: second.x - 20, y: second.y, id: 2 }
    ]);
    await this.send('touchEnd', []);
  }

  /** Horizontal swipe (reader page turns). */
  async swipe(from: Pt, dx: number, dy = 0, steps = 8): Promise<void> {
    await this.drag(from, { x: from.x + dx, y: from.y + dy }, { steps, stepMs: 12 });
  }
}
