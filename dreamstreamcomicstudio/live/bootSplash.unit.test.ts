// @vitest-environment jsdom
// The boot splash → account splash hand-off (live/bootSplash.ts): the account splash continues the
// static splash's progress line instead of restarting it — no second fade-in once the line has
// shown, the sweep at the same phase — and its On-air mark's loading loop on the static mark's
// clock; and it does nothing at all where there was no static splash, no loop (reduced motion) or
// no Web Animations API (tests, old browsers).
import { afterEach, describe, expect, it } from 'vitest';
import { bootLineStyles, captureBootSplash, continueBootMark, resetBootSplash } from './bootSplash';

function staticSplash(startTime: number | null) {
  document.body.innerHTML = '<div id="live-root"><div class="boot-page" data-live-boot=""><span class="boot-bar"><i></i></span></div></div>';
  const line = document.querySelector<HTMLElement>('.boot-bar i')!;
  Object.assign(line, { getAnimations: () => (startTime == null ? [] : [{ startTime }]) });
  return document.getElementById('live-root');
}
function timelineAt(ms: number) {
  Object.defineProperty(document, 'timeline', { value: { currentTime: ms }, configurable: true });
}

afterEach(() => {
  resetBootSplash();
  document.body.innerHTML = '';
});

describe('the account splash continues the boot splash’s progress line', () => {
  it('without a static splash (or the API), it adds nothing: the account splash animates on its own', () => {
    captureBootSplash(null);
    expect(bootLineStyles()).toEqual({});
    captureBootSplash(staticSplash(null));
    timelineAt(1000);
    expect(bootLineStyles()).toEqual({});
  });

  it('once the line has shown, it stays shown (no second fade-in) and the sweep keeps its phase', () => {
    captureBootSplash(staticSplash(100));
    timelineAt(100 + 1900); // 1.9 s in: shown, 500 ms into its second 1.4 s sweep
    expect(bootLineStyles()).toEqual({ bar: { animation: 'none', opacity: 1 }, sweep: { animationDelay: '-500ms' } });
  });

  it('before the line has shown, it appears exactly when the static one would have', () => {
    captureBootSplash(staticSplash(50));
    timelineAt(50 + 150);
    expect(bootLineStyles()).toEqual({ bar: { animationDelay: '250ms' }, sweep: { animationDelay: '-150ms' } });
  });
});

describe('the account splash’s mark continues the boot splash’s broadcast loop', () => {
  type Fake = { startTime: number | null; animationName?: string };
  /** The static splash with its looping mark (studio-marks.css runs one loop on the cut, one on the point). */
  function staticMark(loopStart: number | null) {
    document.body.innerHTML =
      '<div id="live-root"><div class="boot-page" data-live-boot=""><svg class="boot-mark"><mask><path class="ds-logo-cut"/><circle class="ds-logo-point"/></mask></svg></div></div>';
    const cut = document.querySelector('.ds-logo-cut')!;
    Object.assign(cut, { getAnimations: () => (loopStart == null ? [] : [{ startTime: loopStart, animationName: 'ds-logo-onair' }]) });
    return document.getElementById('live-root');
  }
  /** React's mark, with the animations the browser started for it (and a hover transition, which isn't ours). */
  function reactMark(): { el: Element; anims: Fake[]; asked: unknown[] } {
    const el = document.createElement('svg');
    const anims: Fake[] = [
      { startTime: 9000, animationName: 'ds-logo-onair' },
      { startTime: 9000, animationName: 'ds-logo-live' },
      { startTime: 9000 }, // a CSSTransition: no animationName
    ];
    const asked: unknown[] = [];
    Object.assign(el, { getAnimations: (opts?: unknown) => (asked.push(opts), anims) });
    return { el, anims, asked };
  }

  it('puts every loop of the new mark on the static mark’s start time (same timeline, so the same phase)', () => {
    captureBootSplash(staticMark(120));
    const { el, anims, asked } = reactMark();
    continueBootMark(el);
    expect(asked).toEqual([{ subtree: true }]);
    expect(anims.map((a) => a.startTime)).toEqual([120, 120, 9000]);
  });

  it('leaves the new mark alone without a static loop (reduced motion, no splash, no API) or without a mark', () => {
    captureBootSplash(staticMark(null));
    const { el, anims } = reactMark();
    continueBootMark(el);
    expect(anims.map((a) => a.startTime)).toEqual([9000, 9000, 9000]);
    resetBootSplash();
    captureBootSplash(null);
    continueBootMark(el);
    expect(anims.map((a) => a.startTime)).toEqual([9000, 9000, 9000]);
    captureBootSplash(staticMark(120));
    expect(() => continueBootMark(null)).not.toThrow();
    expect(() => continueBootMark(document.createElement('svg'))).not.toThrow(); // jsdom: no getAnimations
  });

  it('captures the line and the loop independently', () => {
    captureBootSplash(staticMark(120)); // a splash with the mark but no line
    timelineAt(1000);
    expect(bootLineStyles()).toEqual({});
    const { el, anims } = reactMark();
    continueBootMark(el);
    expect(anims[0].startTime).toBe(120);
  });
});
