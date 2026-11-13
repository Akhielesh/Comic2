// Smoke + reduced-motion coverage for the Agent Stream motion primitives.

import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  StreamList,
  StreamItem,
  AgentThinking,
  ImageDevelop,
  SelectPop,
  CountUp,
  PanelGrid,
  PanelPop,
} from './streamMotion';

/** Install a matchMedia mock that reports `reduce` for the reduced-motion query. */
const mockMatchMedia = (reduce: boolean) => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  });
};

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('Agent Stream motion primitives render children (animated path)', () => {
  it('StreamList + StreamItem render cards', () => {
    mockMatchMedia(false);
    render(
      <StreamList>
        <StreamItem><span>card-one</span></StreamItem>
        <StreamItem><span>card-two</span></StreamItem>
      </StreamList>,
    );
    expect(screen.getByText('card-one')).toBeInTheDocument();
    expect(screen.getByText('card-two')).toBeInTheDocument();
  });

  it('AgentThinking exposes a live status with its label', () => {
    mockMatchMedia(false);
    render(<AgentThinking label="Planning beats…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Planning beats…');
  });

  it('ImageDevelop renders placeholder children and image alt', () => {
    mockMatchMedia(false);
    render(<ImageDevelop src="data:image/png;base64,x" alt="cast sheet" />);
    expect(screen.getByAltText('cast sheet')).toBeInTheDocument();
  });

  it('SelectPop forwards label + selected state', () => {
    mockMatchMedia(false);
    render(<SelectPop selected ariaLabel="Inked noir"><span>board</span></SelectPop>);
    const btn = screen.getByRole('button', { name: 'Inked noir' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('board')).toBeInTheDocument();
  });

  it('PanelGrid + PanelPop render panels', () => {
    mockMatchMedia(false);
    render(
      <PanelGrid>
        <PanelPop><span>panel-a</span></PanelPop>
      </PanelGrid>,
    );
    expect(screen.getByText('panel-a')).toBeInTheDocument();
  });
});

describe('reduced motion degrades to static', () => {
  it('CountUp shows the final value immediately under reduced motion', () => {
    mockMatchMedia(true);
    render(<CountUp value={0.42} prefix="$" />);
    expect(screen.getByText('$0.42')).toBeInTheDocument();
  });

  it('StreamItem still renders its child under reduced motion', () => {
    mockMatchMedia(true);
    render(<StreamItem><span>static-card</span></StreamItem>);
    expect(screen.getByText('static-card')).toBeInTheDocument();
  });
});

// ---- ImageDevelop: decode-gated develop (Program 3 MO-1, bug B13) -------------------------------------
// The develop used to start on mount (framer-motion, 0.9 s), whatever the <img> was doing, so a page that took
// longer than that to arrive finished its develop invisible and then popped in. Now nothing moves until the
// image has loaded and decoded; the motion is opacity and transform on the Web Animations API, never a filter;
// reduced motion swaps the picture in with no animation; a picture already in memory and a box with no picture
// never develop; a develop cut short cancels its animations.

interface PlayedAnimation {
  el: Element;
  keyframes: Keyframe[];
  timing: KeyframeAnimationOptions;
  finish: () => void;
  cancel: ReturnType<typeof vi.fn>;
}

describe('ImageDevelop waits for the art, then develops on the compositor', () => {
  let played: PlayedAnimation[] = [];
  let pendingDecode: { promise: Promise<void>; resolve: () => void };
  const realAnimate = (Element.prototype as unknown as { animate?: unknown }).animate;
  const realDecode = (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
  const realConnection = Object.getOwnPropertyDescriptor(navigator, 'connection');

  const newDecode = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    pendingDecode = { promise, resolve };
    return promise;
  };

  const setEnv = ({ reduce = false, coarse = false }: { reduce?: boolean; coarse?: boolean } = {}) => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      matches: (reduce && query.includes('prefers-reduced-motion')) || (coarse && query === '(pointer: coarse)'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
      onchange: null,
    });
  };

  const setWidth = (width: number) =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: width, top: 0, left: 0, right: width, bottom: width, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);

  beforeEach(() => {
    played = [];
    (Element.prototype as unknown as { animate?: unknown }).animate = function (this: Element, keyframes: Keyframe[], timing: KeyframeAnimationOptions) {
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      const cancel = vi.fn();
      played.push({ el: this, keyframes, timing, finish, cancel });
      return { finished, cancel } as unknown as Animation;
    };
    (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode = vi.fn(() => newDecode());
    setEnv();
    setWidth(320);
  });

  afterEach(() => {
    if (realAnimate === undefined) delete (Element.prototype as unknown as { animate?: unknown }).animate;
    else (Element.prototype as unknown as { animate?: unknown }).animate = realAnimate;
    if (realDecode === undefined) delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
    else (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode = realDecode;
    if (realConnection) Object.defineProperty(navigator, 'connection', realConnection);
    else delete (navigator as unknown as { connection?: unknown }).connection;
    vi.restoreAllMocks();
  });

  const box = (container: HTMLElement) => container.firstElementChild as HTMLElement;
  const layerOf = (img: HTMLElement) => img.parentElement as HTMLElement;
  const loadAndDecode = async (img: HTMLElement) => {
    act(() => {
      fireEvent.load(img);
    });
    await act(async () => {
      pendingDecode.resolve();
      await pendingDecode.promise;
    });
  };
  const finishAll = async () => {
    await act(async () => {
      for (const a of played) a.finish();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('does not animate before the image has loaded and decoded (B13)', async () => {
    const { container } = render(<ImageDevelop src="https://cdn.test/page.png" alt="page one" />);
    const img = screen.getByAltText('page one');
    expect(box(container)).toHaveAttribute('data-develop', 'loading');
    expect(layerOf(img).style.opacity).toBe('0');
    expect(container.querySelector('[data-develop-placeholder]')).not.toBeNull();
    expect(played).toEqual([]);

    act(() => {
      fireEvent.load(img);
    });
    expect(box(container)).toHaveAttribute('data-develop', 'decoding');
    expect(layerOf(img).style.opacity).toBe('0');
    expect(played).toEqual([]);

    await act(async () => {
      pendingDecode.resolve();
      await pendingDecode.promise;
    });
    expect(box(container)).toHaveAttribute('data-develop', 'revealed');
    expect(layerOf(img).style.opacity).toBe('');
    const develop = played.find((a) => a.el === layerOf(img));
    expect(develop?.keyframes[0]).toMatchObject({ opacity: 0 });
    expect(develop?.keyframes[1]).toMatchObject({ opacity: 1, transform: 'none' });
    expect(develop?.timing.duration).toBe(420);

    // The placeholder, the light and the sheen leave once the develop has finished.
    expect(played).toHaveLength(3);
    await finishAll();
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
    expect(box(container).querySelectorAll('[aria-hidden]')).toHaveLength(0);
  });

  it('waits for a picture handed over as an <img> child too (the board passes its own)', async () => {
    const { container } = render(
      <ImageDevelop className="h-full w-full" rounded="rounded-none">
        <img src="https://cdn.test/board.png" alt="board page" className="absolute inset-0" />
      </ImageDevelop>,
    );
    const img = screen.getByAltText('board page');
    expect(box(container)).toHaveAttribute('data-develop', 'loading');
    expect(played).toEqual([]);
    await loadAndDecode(img);
    expect(played.some((a) => a.el === layerOf(img))).toBe(true);
  });

  it('reduced motion: waits for the decode, then the picture simply appears (no animation at all)', async () => {
    setEnv({ reduce: true });
    const { container } = render(<ImageDevelop src="https://cdn.test/page.png" alt="page one" />);
    const img = screen.getByAltText('page one');
    expect(layerOf(img).style.opacity).toBe('0');
    await loadAndDecode(img);
    expect(played).toEqual([]);
    expect(layerOf(img).style.opacity).toBe('');
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
    expect(box(container).querySelectorAll('[aria-hidden]')).toHaveLength(0);
  });

  const developFrames = async (env: { coarse?: boolean; width?: number; saveData?: boolean } = {}) => {
    setEnv({ coarse: env.coarse });
    if (env.width !== undefined) setWidth(env.width);
    if (env.saveData) Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
    render(<ImageDevelop src="https://cdn.test/page.png" alt="page one" />);
    const img = screen.getByAltText('page one');
    await loadAndDecode(img);
    return played;
  };
  const filterIn = (anims: PlayedAnimation[]) => anims.some((a) => a.keyframes.some((k) => 'filter' in k));
  const props = (anims: PlayedAnimation[]) => new Set(anims.flatMap((a) => a.keyframes.flatMap((k) => Object.keys(k).filter((p) => p !== 'offset' && p !== 'easing'))));

  // The owner asked for transform and opacity only: no environment (not even small art on a fine pointer and
  // a capable desktop, where a blur would be cheapest) gets a filter, and coarse pointers, low power and wide
  // art (the row's rule) are covered by construction.
  it.each([
    ['small art, a fine pointer, a capable device', { width: 320 }],
    ['a coarse pointer', { coarse: true, width: 320 }],
    ['low power (Save-Data)', { saveData: true, width: 320 }],
    ['art wider than 640 px', { width: 900 }],
  ] as const)('never a filter: opacity and transform only (%s)', async (_label, env) => {
    const anims = await developFrames(env);
    expect(anims).toHaveLength(3);
    expect(filterIn(anims)).toBe(false);
    expect([...props(anims)].sort()).toEqual(['opacity', 'transform']);
  });

  // The sheen crosses the picture while it develops and ends with it, never after: it starts one fast step in and
  // runs for the slow step, cut to what is left of the develop. Under the skin's shorter entrances (develop 240 ms,
  // fast 100, slow 200) the plain sum would end at 300 ms, after the picture has finished developing.
  it.each([
    ['outside the skin (the index.css defaults)', {}, { develop: 420, delay: 120, sheen: 300 }],
    ['under the skin (develop 240, fast 100, slow 200)', { '--ds-motion-enter-slow': '240ms', '--ds-motion-fast': '100ms', '--ds-motion-slow': '200ms' }, { develop: 240, delay: 100, sheen: 140 }],
  ] as const)('the sheen ends with the develop, never after it (%s)', async (_label, tokens, want) => {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      const style = real(el, pseudo);
      const values = tokens as Record<string, string>;
      return new Proxy(style, {
        get(target, prop) {
          if (prop === 'getPropertyValue') return (name: string) => values[name] ?? target.getPropertyValue(name);
          const v = Reflect.get(target, prop, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    });
    const anims = await developFrames({ width: 320 });
    const sheen = anims.find((a) => (a.el as HTMLElement).hasAttribute('data-develop-sheen'));
    const develop = anims.find((a) => a.keyframes.some((k) => k.transform === 'none'));
    expect(develop?.timing.duration).toBe(want.develop);
    expect(sheen?.timing.delay).toBe(want.delay);
    expect(sheen?.timing.duration).toBe(want.sheen);
    expect(Number(sheen?.timing.delay) + Number(sheen?.timing.duration)).toBeLessThanOrEqual(Number(develop?.timing.duration));
  });

  it('a picture already in memory swaps in with no develop (fromCache: a remount, a second surface)', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(640);
    const { container } = render(<ImageDevelop src="https://cdn.test/page.png" alt="page one" />);
    const img = screen.getByAltText('page one');
    expect(box(container)).toHaveAttribute('data-develop', 'revealed');
    expect(layerOf(img).style.opacity).toBe('');
    expect(played).toEqual([]);
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
    expect(box(container).querySelectorAll('[aria-hidden]')).toHaveLength(0);
  });

  it('a box with no <img> (a tint block before the url arrives) never develops; the art develops once it arrives', async () => {
    const tint = <div data-testid="tint" className="h-16 w-16" />;
    const { container, rerender } = render(
      <ImageDevelop className="h-16 w-16">
        {tint}
      </ImageDevelop>,
    );
    expect(played).toEqual([]);
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
    expect(layerOf(screen.getByTestId('tint')).style.opacity).toBe('');
    expect(box(container).querySelectorAll('[aria-hidden]')).toHaveLength(0);

    // The cast card's shape: the same ImageDevelop gets its url later.
    rerender(
      <ImageDevelop src="https://cdn.test/cast.png" alt="cast" className="h-16 w-16">
        {tint}
      </ImageDevelop>,
    );
    const img = screen.getByAltText('cast');
    expect(box(container)).toHaveAttribute('data-develop', 'loading');
    expect(played).toEqual([]);
    await loadAndDecode(img);
    expect(played).toHaveLength(3);
    expect(played.some((a) => a.el === layerOf(img))).toBe(true);
  });

  it('a develop cut short (active drops) cancels every animation and drops its layers', async () => {
    const { container, rerender } = render(<ImageDevelop src="https://cdn.test/page.png" alt="page one" />);
    await loadAndDecode(screen.getByAltText('page one'));
    expect(played).toHaveLength(3);
    expect(container.querySelector('[data-develop-light]')).not.toBeNull();
    expect(container.querySelector('[data-develop-sheen]')).not.toBeNull();
    rerender(<ImageDevelop src="https://cdn.test/page.png" alt="page one" active={false} />);
    for (const a of played) expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-develop-light]')).toBeNull();
    expect(container.querySelector('[data-develop-sheen]')).toBeNull();
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
    expect(layerOf(screen.getByAltText('page one')).style.opacity).toBe('');
  });

  it('a new picture mid-develop cancels the old develop and waits for the new art', async () => {
    const { container, rerender } = render(<ImageDevelop src="https://cdn.test/one.png" alt="page" />);
    await loadAndDecode(screen.getByAltText('page'));
    const first = [...played];
    expect(first).toHaveLength(3);
    rerender(<ImageDevelop src="https://cdn.test/two.png" alt="page" />);
    for (const a of first) expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(box(container)).toHaveAttribute('data-develop', 'loading');
    expect(container.querySelector('[data-develop-light]')).toBeNull();
    expect(played).toHaveLength(3);
  });

  it('the light and the sheen read skin tokens, with the light-skin values as fallbacks', async () => {
    const { container } = render(<ImageDevelop src="https://cdn.test/page.png" alt="page one" />);
    await loadAndDecode(screen.getByAltText('page one'));
    const light = container.querySelector('[data-develop-light]') as HTMLElement;
    const sheen = container.querySelector('[data-develop-sheen]') as HTMLElement;
    expect(light.getAttribute('style')).toContain('var(--ds-develop-light, rgb(255 255 255))');
    expect(sheen.getAttribute('style')).toContain('var(--ds-develop-sheen, rgba(255,255,255,0.18))');
  });

  it('the img defaults to loading="lazy" and decoding="async"; loading, decoding, srcSet and sizes pass through', () => {
    const { rerender } = render(<ImageDevelop src="https://cdn.test/p.png" alt="tile" />);
    const img = screen.getByAltText('tile');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).not.toHaveAttribute('srcset');
    rerender(
      <ImageDevelop
        src="https://cdn.test/p.png"
        alt="tile"
        loading="eager"
        decoding="sync"
        srcSet="https://cdn.test/p@480.webp 480w, https://cdn.test/p.png 1600w"
        sizes="160px"
      />,
    );
    expect(img).toHaveAttribute('loading', 'eager');
    expect(img).toHaveAttribute('decoding', 'sync');
    expect(img).toHaveAttribute('srcset', 'https://cdn.test/p@480.webp 480w, https://cdn.test/p.png 1600w');
    expect(img).toHaveAttribute('sizes', '160px');
  });

  it('active={false} is static: no gate, no placeholder, no animation', () => {
    const { container } = render(<ImageDevelop src="https://cdn.test/p.png" alt="old take" active={false} />);
    const img = screen.getByAltText('old take');
    expect(box(container)).not.toHaveAttribute('data-develop');
    expect(layerOf(img).style.opacity).toBe('');
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
    act(() => {
      fireEvent.load(img);
    });
    expect(played).toEqual([]);
  });

  it('a re-signed url for the same file neither hides the picture nor develops it again', async () => {
    const { container, rerender } = render(<ImageDevelop src="https://cdn.test/p.png?token=one" alt="page" />);
    await loadAndDecode(screen.getByAltText('page'));
    await finishAll();
    const count = played.length;
    rerender(<ImageDevelop src="https://cdn.test/p.png?token=two" alt="page" />);
    expect(box(container)).toHaveAttribute('data-develop', 'revealed');
    expect(layerOf(screen.getByAltText('page')).style.opacity).toBe('');
    expect(played).toHaveLength(count);
  });

  it('a failed image is shown as it is (the caller’s error path), never held hidden', () => {
    const { container } = render(<ImageDevelop src="https://cdn.test/missing.png" alt="gone" />);
    const img = screen.getByAltText('gone');
    act(() => {
      fireEvent.error(img);
    });
    expect(box(container)).toHaveAttribute('data-develop', 'error');
    expect(layerOf(img).style.opacity).toBe('');
    expect(container.querySelector('[data-develop-placeholder]')).toBeNull();
    expect(played).toEqual([]);
  });
});
