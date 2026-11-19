// @vitest-environment jsdom
// The landing's clip player, with a fake IntersectionObserver and stubbed play()/pause() (no engine behaviour, no
// media playback, no timers): it plays only in view, pauses out of view, never autoplays under reduced motion, keeps a
// visitor's pause, lets one clip play at a time, stays quiet when play() is refused, and falls back to the poster and
// Play without an IntersectionObserver. Stills are lazy, sized and described.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingClip } from './LandingClip';
import { LandingShot } from './LandingShot';
import { landingMedia, type LandingMedia } from './landingMedia';

type Entry = { isIntersecting: boolean; intersectionRatio: number; target: Element };
const observers: Array<{ cb: (entries: Entry[]) => void; targets: Element[] }> = [];

class FakeObserver {
  cb: (entries: Entry[]) => void;
  targets: Element[] = [];
  constructor(cb: (entries: Entry[]) => void) {
    this.cb = cb;
    observers.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  disconnect() {
    this.targets = [];
  }
}

const view = (el: Element, inView: boolean) =>
  act(() => {
    for (const o of observers) if (o.targets.includes(el)) o.cb([{ isIntersecting: inView, intersectionRatio: inView ? 1 : 0, target: el }]);
  });

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
let reduced = false;

beforeEach(() => {
  observers.length = 0;
  reduced = false;
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  play = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    return Promise.resolve();
  });
  pause = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
    this.dispatchEvent(new Event('pause'));
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: pause });
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) => ({ matches: reduced && query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLMediaElement.prototype as { play?: unknown }).play;
  delete (HTMLMediaElement.prototype as { pause?: unknown }).pause;
});

const clip = landingMedia('reader');
const twin: LandingMedia = { ...clip, short: 'the second clip' };
const toggle = (name: RegExp) => screen.getByRole('button', { name });

describe('LandingClip', () => {
  it('is muted, looping, inline, waits to load (its poster too, until it nears the screen), and has its size', () => {
    const { container } = render(<LandingClip media={clip} />);
    const video = container.querySelector('video')!;
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute('loop');
    expect(video).toHaveAttribute('playsinline');
    expect(video).toHaveAttribute('preload', 'none');
    // Far down the page the poster is not asked for yet; once the clip is within a screen of view, it is.
    expect(video).not.toHaveAttribute('poster');
    view(video, true);
    expect(container.querySelector('video')).toHaveAttribute('poster', clip.light.poster);
    expect(video).toHaveAttribute('width', String(clip.width));
    expect(video).toHaveAttribute('height', String(clip.height));
    expect([...video.querySelectorAll('source')].map((s) => s.getAttribute('type'))).toEqual(['video/webm', 'video/mp4']);
  });

  it('plays in view and pauses out of view; the toggle says what it does and flips', async () => {
    const { container } = render(<LandingClip media={clip} />);
    const video = container.querySelector('video')!;
    // The name says what a press does; it never also claims a pressed state (that would read "Play, pressed").
    expect(toggle(/^Play:/)).not.toHaveAttribute('aria-pressed');
    view(video, true);
    await act(async () => undefined);
    expect(play).toHaveBeenCalledTimes(1);
    expect(toggle(/^Pause:/)).not.toHaveAttribute('aria-pressed');
    view(video, false);
    expect(pause).toHaveBeenCalled();
    expect(toggle(/^Play:/)).toBeInTheDocument();
  });

  it('a visitor’s pause holds when the clip scrolls back into view; Play starts it again', async () => {
    const { container } = render(<LandingClip media={clip} />);
    const video = container.querySelector('video')!;
    view(video, true);
    await act(async () => undefined);
    fireEvent.click(toggle(/^Pause:/));
    expect(toggle(/^Play:/)).toBeInTheDocument();
    view(video, false);
    view(video, true);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle(/^Play:/));
    await act(async () => undefined);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('under reduced motion it never starts on its own: the poster and Play show, and Play plays', async () => {
    reduced = true;
    const { container } = render(<LandingClip media={clip} />);
    const video = container.querySelector('video')!;
    view(video, true);
    await act(async () => undefined);
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(toggle(/^Play:/));
    await act(async () => undefined);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('one clip at a time: starting a second pauses the first', async () => {
    const { container } = render(
      <>
        <LandingClip media={clip} />
        <LandingClip media={twin} />
      </>
    );
    const [first, second] = [...container.querySelectorAll('video')];
    view(first, true);
    await act(async () => undefined);
    pause.mockClear();
    view(second, true);
    await act(async () => undefined);
    expect(pause.mock.contexts).toContain(first);
  });

  it('a refused play() leaves the poster and Play, and logs nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    play.mockImplementation(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
    const { container } = render(<LandingClip media={clip} />);
    view(container.querySelector('video')!, true);
    await act(async () => undefined);
    expect(toggle(/^Play:/)).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  });

  it('without an IntersectionObserver it shows the poster and Play and never starts', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { container } = render(<LandingClip media={clip} />);
    expect(container.querySelector('video')).toHaveAttribute('poster', clip.light.poster);
    expect(toggle(/^Play:/)).toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  });

  it('the toggle is the ds IconButton with the 44 px coarse-pointer floor', () => {
    render(<LandingClip media={clip} />);
    const button = toggle(/^Play:/);
    expect(button).toHaveAttribute('data-slot', 'icon-button');
    expect(button.className).toMatch(/coarse:min-h-\[var\(--ds-density-touch\)\]/);
    // It sits in its own strip after the clip, never laid over the page art.
    const bar = button.closest('.landing-clip-bar')!;
    expect(bar).not.toBeNull();
    expect(bar.previousElementSibling?.tagName).toBe('VIDEO');
  });
});

describe('LandingShot', () => {
  it('is lazy, decoded off the main thread, sized and described; the dark picture in dark mode', () => {
    const shot = landingMedia('plan');
    const { container, unmount } = render(<LandingShot media={shot} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).toHaveAttribute('width', String(shot.width));
    expect(img).toHaveAttribute('height', String(shot.height));
    expect(img).toHaveAttribute('alt', shot.alt);
    expect(img).toHaveAttribute('src', shot.light.webp);
    unmount();
    document.documentElement.classList.add('dark');
    try {
      const { container: dark } = render(<LandingShot media={shot} />);
      expect(dark.querySelector('img')).toHaveAttribute('src', shot.dark.webp);
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
