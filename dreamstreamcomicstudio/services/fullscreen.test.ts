import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IOS_FULLSCREEN_NOTE,
  enterFullscreen,
  exitFullscreen,
  fullscreenApi,
  fullscreenElement,
  isFullscreenActive,
  markIosFullscreenNoteSeen,
  onFullscreenChange,
  resetIosFullscreenNoteForTests,
  shouldShowIosFullscreenNote
} from './fullscreen';

// jsdom has no Fullscreen API at all, which is exactly what an iPhone browser looks like. Each test installs the
// variant it needs on the element / document instance and removes it afterwards.
type AnyRec = Record<string, unknown>;
const el = () => document.createElement('div');
const setDoc = (key: string, value: unknown) => Object.defineProperty(document, key, { value, configurable: true, writable: true });
const clearDoc = (...keys: string[]) => keys.forEach((k) => delete (document as unknown as AnyRec)[k]);
const flush = () => new Promise((r) => setTimeout(r, 0));
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const setUA = (ua: string) => Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });

afterEach(() => {
  clearDoc('fullscreenElement', 'webkitFullscreenElement', 'fullscreenEnabled', 'exitFullscreen', 'webkitExitFullscreen');
  vi.useRealTimers();
});

describe('fullscreenApi (capability detection)', () => {
  it('reports none when the API is missing (iPhone)', () => {
    expect(fullscreenApi(el())).toBe('none');
  });
  it('prefers the standard API, then the webkit one', () => {
    const a = el() as unknown as AnyRec;
    a.webkitRequestFullscreen = vi.fn();
    expect(fullscreenApi(a as unknown as Element)).toBe('webkit');
    a.requestFullscreen = vi.fn(() => Promise.resolve());
    expect(fullscreenApi(a as unknown as Element)).toBe('standard');
  });
  it('reports none when the document says full screen is disabled (iframe without allow)', () => {
    const a = el() as unknown as AnyRec;
    a.requestFullscreen = vi.fn(() => Promise.resolve());
    setDoc('fullscreenEnabled', false);
    expect(fullscreenApi(a as unknown as Element)).toBe('none');
  });
});

describe('enterFullscreen', () => {
  it('runs the reading-mode fallback synchronously when the API is missing, and never throws', () => {
    const onFallback = vi.fn();
    expect(() => enterFullscreen(el(), { onFallback })).not.toThrow();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith('unsupported');
    expect(enterFullscreen(null, { onFallback: () => undefined })).toBe('fallback');
  });

  it('calls requestFullscreen({ navigationUI: "hide" }) inside the tap (synchronously)', () => {
    const a = el() as unknown as AnyRec;
    const req = vi.fn(() => Promise.resolve());
    a.requestFullscreen = req;
    const onFallback = vi.fn();
    expect(enterFullscreen(a as unknown as Element, { onFallback })).toBe('requested');
    // No await happened yet: the call must already have been made (user activation is only valid in the tap).
    expect(req).toHaveBeenCalledTimes(1);
    expect(req).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('falls back when the browser refuses, without an unhandled rejection', async () => {
    const a = el() as unknown as AnyRec;
    a.requestFullscreen = vi.fn(() => Promise.reject(new TypeError('Permissions check failed')));
    const onFallback = vi.fn();
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    enterFullscreen(a as unknown as Element, { onFallback });
    await flush();
    window.removeEventListener('unhandledrejection', unhandled);
    expect(onFallback).toHaveBeenCalledWith('rejected');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('tries the webkit API when the standard call throws synchronously', () => {
    const a = el() as unknown as AnyRec;
    a.requestFullscreen = vi.fn(() => {
      throw new TypeError('not supported');
    });
    const wk = vi.fn();
    a.webkitRequestFullscreen = wk;
    const onFallback = vi.fn();
    enterFullscreen(a as unknown as Element, { onFallback });
    expect(wk).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('uses webkitRequestFullscreen (iPad Safari) and falls back on webkitfullscreenerror', () => {
    const a = el() as unknown as AnyRec;
    const wk = vi.fn();
    a.webkitRequestFullscreen = wk;
    const onFallback = vi.fn();
    expect(enterFullscreen(a as unknown as Element, { onFallback })).toBe('requested');
    expect(wk).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('webkitfullscreenerror'));
    expect(onFallback).toHaveBeenCalledWith('rejected');
    document.dispatchEvent(new Event('webkitfullscreenerror'));
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('webkit: a change event means it worked, so the safety timer never falls back', () => {
    vi.useFakeTimers();
    const a = el() as unknown as AnyRec;
    a.webkitRequestFullscreen = vi.fn(() => setDoc('webkitFullscreenElement', a));
    const onFallback = vi.fn();
    enterFullscreen(a as unknown as Element, { onFallback });
    document.dispatchEvent(new Event('webkitfullscreenchange'));
    vi.advanceTimersByTime(5000);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('webkit: silently ignored → the safety timer falls back (never a dead button)', () => {
    vi.useFakeTimers();
    const a = el() as unknown as AnyRec;
    a.webkitRequestFullscreen = vi.fn();
    const onFallback = vi.fn();
    enterFullscreen(a as unknown as Element, { onFallback });
    vi.advanceTimersByTime(5000);
    expect(onFallback).toHaveBeenCalledWith('rejected');
  });

  it('a throwing fallback callback still never throws out of the tap', () => {
    expect(() =>
      enterFullscreen(el(), {
        onFallback: () => {
          throw new Error('caller bug');
        }
      })
    ).not.toThrow();
  });
});

describe('state comes only from the browser events', () => {
  it('reads the standard and the webkit-prefixed full-screen element', () => {
    const a = el();
    expect(fullscreenElement()).toBeNull();
    expect(isFullscreenActive(a)).toBe(false);
    setDoc('webkitFullscreenElement', a);
    expect(fullscreenElement()).toBe(a);
    expect(isFullscreenActive(a)).toBe(true);
    expect(isFullscreenActive(el())).toBe(false);
    setDoc('fullscreenElement', a);
    expect(isFullscreenActive()).toBe(true);
  });

  it('listens to fullscreenchange and webkitfullscreenchange, and unsubscribes', () => {
    const cb = vi.fn();
    const off = onFullscreenChange(cb);
    document.dispatchEvent(new Event('fullscreenchange'));
    document.dispatchEvent(new Event('webkitfullscreenchange'));
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('exitFullscreen', () => {
  it('never throws when the API is missing or refuses', async () => {
    expect(() => exitFullscreen()).not.toThrow();
    const a = el();
    setDoc('fullscreenElement', a);
    setDoc('exitFullscreen', vi.fn(() => Promise.reject(new Error('nope'))));
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    expect(() => exitFullscreen()).not.toThrow();
    await flush();
    window.removeEventListener('unhandledrejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('uses the webkit exit when only the webkit element is set', () => {
    const a = el();
    setDoc('webkitFullscreenElement', a);
    const wk = vi.fn();
    setDoc('webkitExitFullscreen', wk);
    exitFullscreen();
    expect(wk).toHaveBeenCalledTimes(1);
  });
});

describe('one-time iPhone note', () => {
  const realUA = window.navigator.userAgent;
  beforeEach(() => {
    window.localStorage.clear();
    resetIosFullscreenNoteForTests();
  });
  afterEach(() => setUA(realUA));

  it('has the exact copy', () => {
    expect(IOS_FULLSCREEN_NOTE).toBe('iPhone browsers keep their toolbars. Share → Add to Home Screen opens comics edge-to-edge.');
  });

  it('shows once on an iPhone (Chrome for iOS included), never on Android', () => {
    setUA(ANDROID_UA);
    expect(shouldShowIosFullscreenNote()).toBe(false);
    setUA(IPHONE_UA);
    expect(shouldShowIosFullscreenNote()).toBe(true);
    markIosFullscreenNoteSeen();
    expect(shouldShowIosFullscreenNote()).toBe(false);
    // Remembered across sessions.
    resetIosFullscreenNoteForTests({ keepStorage: true });
    expect(shouldShowIosFullscreenNote()).toBe(false);
  });

  it('still shows only once when storage is blocked', () => {
    setUA(IPHONE_UA);
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(shouldShowIosFullscreenNote()).toBe(true);
    markIosFullscreenNoteSeen();
    expect(shouldShowIosFullscreenNote()).toBe(false);
    get.mockRestore();
    set.mockRestore();
  });

  it('is not shown when already opened from the Home Screen', () => {
    setUA(IPHONE_UA);
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
    expect(shouldShowIosFullscreenNote()).toBe(false);
    delete (window.navigator as unknown as AnyRec).standalone;
  });
});
