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
// image has loaded and decoded; the motion is opacity and transform on the Web Animations API, with a blur only
// on small art, fine pointers and capable devices; reduced motion swaps the picture in with no animation.

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

  it('a blur only on small art with a fine pointer on a capable device', async () => {
    const anims = await developFrames({ width: 320 });
    expect(filterIn(anims)).toBe(true);
    expect([...props(anims)].sort()).toEqual(['filter', 'opacity', 'transform']);
  });

  it('no filter on a coarse pointer: opacity and transform only', async () => {
    const anims = await developFrames({ coarse: true, width: 320 });
    expect(anims.length).toBeGreaterThan(0);
    expect(filterIn(anims)).toBe(false);
    expect([...props(anims)].sort()).toEqual(['opacity', 'transform']);
  });

  it('no filter in low power (Save-Data)', async () => {
    const anims = await developFrames({ saveData: true, width: 320 });
    expect(anims.length).toBeGreaterThan(0);
    expect(filterIn(anims)).toBe(false);
  });

  it('no filter on art wider than 640 px', async () => {
    const anims = await developFrames({ width: 900 });
    expect(anims.length).toBeGreaterThan(0);
    expect(filterIn(anims)).toBe(false);
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
