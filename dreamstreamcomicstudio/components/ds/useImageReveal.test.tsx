/**
 * useImageReveal (Program 3 MO-1, styles.md §7.3 M1): the art is shown only once it has loaded AND decoded; a
 * cached picture shows in the same frame with no entrance; an error hands over to the caller; a new key starts
 * over and ignores the old decode; a decode that never settles cannot strand the art; and the entrance helpers
 * keep filters off coarse pointers, low-power devices and wide art.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowFilterEffects,
  isLowPowerDevice,
  motionEase,
  motionMs,
  parseMotionMs,
  playEntrance,
  readRevealEnvironment,
  REVEAL_DECODE_TIMEOUT_MS,
  REVEAL_FILTER_MAX_WIDTH_PX,
  revealTokenFallbacks,
  useImageReveal,
  type DecodeImage,
  type ImageReveal
} from './useImageReveal';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const setMatchMedia = (matches: (q: string) => boolean) => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true
  });
};
const realMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let last: ImageReveal;
const Probe: React.FC<{ src?: string; decode?: DecodeImage; enabled?: boolean; wrap?: boolean; empty?: boolean }> = ({ src = 'https://cdn.test/a.webp', decode, enabled, wrap, empty }) => {
  const reveal = useImageReveal(src, { decode, enabled });
  last = reveal;
  const img = <img src={src} alt="art" />;
  if (empty) return <div ref={reveal.ref} data-testid="box" />;
  return wrap ? (
    <div ref={reveal.ref} data-testid="box">
      {img}
    </div>
  ) : (
    <img ref={reveal.ref} src={src} alt="art" />
  );
};

describe('useImageReveal: the decode gate', () => {
  it('stays hidden until decode() resolves after load, then reveals (not from cache)', async () => {
    const d = deferred();
    const decode = vi.fn(() => d.promise);
    render(<Probe decode={decode} />);
    expect(last.phase).toBe('loading');
    expect(last.shown).toBe(false);
    expect(decode).not.toHaveBeenCalled();

    act(() => {
      fireEvent.load(screen.getByAltText('art'));
    });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(last.phase).toBe('decoding');
    expect(last.shown).toBe(false);

    await act(async () => {
      d.resolve();
      await d.promise;
    });
    expect(last.phase).toBe('revealed');
    expect(last.shown).toBe(true);
    expect(last.fromCache).toBe(false);
  });

  it('watches the first <img> inside a container ref (a picture handed over as children)', async () => {
    const d = deferred();
    render(<Probe wrap decode={() => d.promise} />);
    expect(last.element).toBe(screen.getByTestId('box'));
    act(() => {
      fireEvent.load(screen.getByAltText('art'));
    });
    expect(last.phase).toBe('decoding');
    await act(async () => {
      d.resolve();
      await d.promise;
    });
    expect(last.phase).toBe('revealed');
  });

  it('reveals at once when the container holds no <img> (nothing to wait for)', () => {
    render(<Probe empty />);
    expect(last.phase).toBe('revealed');
    expect(last.fromCache).toBe(false);
  });

  it('a browser without decode() reveals on load', () => {
    render(<Probe decode={() => null} />);
    act(() => {
      fireEvent.load(screen.getByAltText('art'));
    });
    expect(last.phase).toBe('revealed');
  });

  it('a rejected decode still reveals what loaded', async () => {
    const d = deferred();
    render(<Probe decode={() => d.promise} />);
    act(() => {
      fireEvent.load(screen.getByAltText('art'));
    });
    await act(async () => {
      d.reject(new Error('EncodingError'));
      await d.promise.catch(() => undefined);
    });
    expect(last.phase).toBe('revealed');
  });

  it('a decode that never settles reveals after REVEAL_DECODE_TIMEOUT_MS, not before', () => {
    vi.useFakeTimers();
    render(<Probe decode={() => new Promise<void>(() => {})} />);
    act(() => {
      fireEvent.load(screen.getByAltText('art'));
    });
    act(() => {
      vi.advanceTimersByTime(REVEAL_DECODE_TIMEOUT_MS - 1);
    });
    expect(last.phase).toBe('decoding');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(last.phase).toBe('revealed');
  });

  it('arms no timer before the image loads (nothing runs while it waits)', () => {
    vi.useFakeTimers();
    render(<Probe decode={() => new Promise<void>(() => {})} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an error hands over to the caller (shown, phase error)', () => {
    render(<Probe />);
    act(() => {
      fireEvent.error(screen.getByAltText('art'));
    });
    expect(last.phase).toBe('error');
    expect(last.shown).toBe(true);
  });

  it('a picture already in memory is revealed in the same frame and flagged fromCache', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(640);
    const decode = vi.fn(() => new Promise<void>(() => {}));
    render(<Probe decode={decode} />);
    expect(last.phase).toBe('revealed');
    expect(last.fromCache).toBe(true);
    expect(decode).not.toHaveBeenCalled();
  });

  it('a new key starts over at loading and ignores the old decode', async () => {
    const first = deferred();
    const second = deferred();
    const decodes = [first, second];
    const { rerender } = render(<Probe src="https://cdn.test/a.webp" decode={() => decodes.shift()!.promise} />);
    act(() => {
      fireEvent.load(screen.getByAltText('art'));
    });
    expect(last.phase).toBe('decoding');
    rerender(<Probe src="https://cdn.test/b.webp" decode={() => decodes.shift()!.promise} />);
    expect(last.phase).toBe('loading');
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    expect(last.phase).toBe('loading');
    act(() => {
      fireEvent.load(screen.getByAltText('art'));
    });
    await act(async () => {
      second.resolve();
      await second.promise;
    });
    expect(last.phase).toBe('revealed');
  });

  it('enabled: false is no gate: revealed at once, never from cache', () => {
    render(<Probe enabled={false} />);
    expect(last.phase).toBe('revealed');
    expect(last.shown).toBe(true);
    expect(last.fromCache).toBe(false);
  });

  it('reports the OS reduced-motion setting', () => {
    setMatchMedia((q) => q.includes('prefers-reduced-motion'));
    render(<Probe />);
    expect(last.reduced).toBe(true);
  });
});

describe('entrance helpers', () => {
  it('allowFilterEffects: only a fine pointer, a capable device and measured art up to 640 px', () => {
    const fine = { coarse: false, lowPower: false, width: 320 };
    expect(allowFilterEffects(fine)).toBe(true);
    expect(allowFilterEffects({ ...fine, width: REVEAL_FILTER_MAX_WIDTH_PX })).toBe(true);
    expect(allowFilterEffects({ ...fine, width: REVEAL_FILTER_MAX_WIDTH_PX + 1 })).toBe(false);
    expect(allowFilterEffects({ ...fine, width: 0 })).toBe(false);
    expect(allowFilterEffects({ ...fine, coarse: true })).toBe(false);
    expect(allowFilterEffects({ ...fine, lowPower: true })).toBe(false);
  });

  it('isLowPowerDevice: Save-Data, or ≤ 4 cores with ≤ 2 GB (the reader’s rule)', () => {
    expect(isLowPowerDevice({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe(false);
    expect(isLowPowerDevice({ hardwareConcurrency: 4, deviceMemory: 2 })).toBe(true);
    expect(isLowPowerDevice({ hardwareConcurrency: 4, deviceMemory: 4 })).toBe(false);
    expect(isLowPowerDevice({ hardwareConcurrency: 8, connection: { saveData: true } })).toBe(true);
    expect(isLowPowerDevice(undefined)).toBe(false);
  });

  it('readRevealEnvironment measures the box and reads the pointer', () => {
    setMatchMedia((q) => q === '(pointer: coarse)');
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ width: 412 } as DOMRect);
    expect(readRevealEnvironment(el)).toMatchObject({ coarse: true, width: 412 });
    expect(readRevealEnvironment(null).width).toBe(0);
  });

  it('parses motion tokens in ms or s and falls back on anything else', () => {
    expect(parseMotionMs('420ms', 1)).toBe(420);
    expect(parseMotionMs(' 0.28s ', 1)).toBe(280);
    expect(parseMotionMs('', 120)).toBe(120);
    expect(parseMotionMs('var(--x)', 120)).toBe(120);
    expect(parseMotionMs('-5ms', 120)).toBe(120);
  });

  it('reads the tokens from the element’s computed style', () => {
    const el = document.createElement('div');
    el.style.setProperty('--ds-motion-enter-slow', '0.5s');
    el.style.setProperty('--ds-ease-enter', 'cubic-bezier(0.2, 1, 0.3, 1)');
    document.body.appendChild(el);
    expect(motionMs(el, '--ds-motion-enter-slow', 1)).toBe(500);
    expect(motionEase(el, '--ds-ease-enter', 'linear')).toBe('cubic-bezier(0.2, 1, 0.3, 1)');
    expect(motionEase(el, '--ds-ease-missing', 'linear')).toBe('linear');
    el.remove();
  });

  it('playEntrance is null where the browser has no Web Animations (the end state simply shows)', () => {
    const el = document.createElement('div');
    expect(playEntrance(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 1 })).toBeNull();
    expect(playEntrance(null, [], {})).toBeNull();
    const animation = { finished: Promise.resolve(), cancel: () => {} } as unknown as Animation;
    (el as unknown as { animate: unknown }).animate = vi.fn(() => animation);
    expect(playEntrance(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 1 })).toBe(animation);
    (el as unknown as { animate: unknown }).animate = () => {
      throw new TypeError('bad easing');
    };
    expect(playEntrance(el, [], {})).toBeNull();
  });
});
