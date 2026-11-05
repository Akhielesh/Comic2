// @vitest-environment jsdom
// The boot splash → account splash hand-off (live/bootSplash.ts): the account splash continues the
// static splash's progress line instead of restarting it — no second fade-in once the line has
// shown, the sweep at the same phase — and does nothing at all where there was no static splash or
// no Web Animations API (tests, old browsers).
import { afterEach, describe, expect, it } from 'vitest';
import { bootLineStyles, captureBootSplash, resetBootSplash } from './bootSplash';

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
