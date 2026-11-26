import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicPanel, Project, TextLayout } from '../types';
import { ComicReader } from './ComicReader';
import { resetBackStack } from './comicstudio/mobile/backStack';
import { loadReaderState, saveReaderState } from '../services/db';

// Page Flip on phones (mobile-reading hotfix): chat-bubble dialogue used to sit BESIDE the art in an inline-flex row,
// completely off-screen to the right on a phone, and in landscape the art shrank to a 13-30 px strip. On phones the
// dialogue now goes under the art and the art gets what the dialogue leaves; desktop Page Flip is unchanged.

vi.mock('./layout/StaticSiteHeader', () => ({ StaticSiteHeader: () => <div data-testid="static-header" /> }));
vi.mock('./layout/LegalMicroLinks', () => ({ LegalMicroLinks: () => <div data-testid="legal-links" /> }));
vi.mock('./PanelDialogue', () => ({
  PanelDialogue: ({ panel, placement, reader }: { panel: ComicPanel; placement?: string; reader?: boolean }) => (
    <div data-testid="panel-dialogue" data-placement={placement ?? 'unset'} data-reader={reader ? 'true' : 'false'}>
      {panel.dialogue}
    </div>
  )
}));
vi.mock('./CommentSection', () => ({ CommentSection: () => <div data-testid="comments" /> }));
vi.mock('./modals/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../services/db', () => ({
  loadReaderState: vi.fn(async () => ({ mode: 'flip', pageIndex: 0 })),
  saveReaderState: vi.fn(async () => undefined),
  submitReview: vi.fn(async () => true)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

const realMatchMedia = window.matchMedia;
const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const setPhone = (phone: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: phone && /pointer:\s*coarse|max-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
};

// Layout stubs (jsdom has none): the flip region's size and the dialogue box's height.
const geo = { regionW: 0, regionH: 0, dialogueH: 0 };
const roCallbacks: Array<() => void> = [];
const descs: Array<[string, PropertyDescriptor | undefined]> = [];
const stub = (prop: 'clientWidth' | 'clientHeight' | 'offsetHeight', get: (el: HTMLElement) => number) => {
  descs.push([prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)]);
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return get(this);
    }
  });
};

beforeEach(() => {
  window.history.pushState({}, '', '/?view=read&id=flip');
  geo.regionW = 0;
  geo.regionH = 0;
  geo.dialogueH = 0;
  roCallbacks.length = 0;
  stub('clientWidth', (el) => (el.dataset.testid === 'flip-region' ? geo.regionW : 0));
  stub('clientHeight', (el) => (el.dataset.testid === 'flip-region' ? geo.regionH : 0));
  stub('offsetHeight', (el) => (el.dataset.testid === 'flip-dialogue' ? geo.dialogueH : 0));
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(cb: () => void) {
      roCallbacks.push(cb);
    }
    observe() {}
    disconnect() {}
  };
});
afterEach(() => {
  // v5: the reader is a Back-stack layer; no layer (or its deferred history pop) outlives its test.
  resetBackStack();
  window.matchMedia = realMatchMedia;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  for (const [prop, d] of descs.splice(0)) {
    if (d) Object.defineProperty(HTMLElement.prototype, prop, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
});

const makeProject = (textLayout: TextLayout = 'chat_bubbles'): Project => ({
  id: 'flip-project',
  name: 'Flip Test',
  createdAt: 1,
  updatedAt: 1,
  state: {
    step: 0,
    maxStepReached: 0,
    script: '',
    scenes: [],
    styleVariants: [],
    stylePrompt: '',
    styleCategory: '',
    styleAspectRatio: '4:3',
    imageResolution: '1K',
    characters: [],
    items: [],
    locations: [],
    layoutType: 'grid',
    textLayout,
    panels: [1, 2].map((i) => ({ id: `p${i}`, sceneId: 1, description: '', dialogue: `Line ${i}`, imageUrl: `data:image/svg+xml,p${i}`, imageIdHistory: [] }))
  }
});

/** Unmount every reader (and its Back-stack layer) before the next one in the same test. */
const cleanupReaders = () => {
  cleanup();
  resetBackStack();
};

const props = () => ({ onClose: vi.fn(), onUpdateProject: vi.fn(), onNavigate: vi.fn(), onOpenPrivacy: vi.fn(), onOpenTerms: vi.fn(), onOpenFaq: vi.fn() });

const openFlip = async (textLayout?: TextLayout) => {
  render(<ComicReader project={makeProject(textLayout)} {...props()} />);
  await act(async () => {
    await Promise.resolve(); // loadReaderState → Page Flip
  });
};
const relayout = (g: Partial<typeof geo>) =>
  act(() => {
    Object.assign(geo, g);
    roCallbacks.forEach((cb) => cb());
  });
const art = () => within(screen.getByTestId('flip-art')).getByRole('img');

describe('Page Flip on phones', () => {
  beforeEach(() => setPhone(true));

  it('puts the dialogue UNDER the art (a column), never in the art row beside it', async () => {
    await openFlip('chat_bubbles');
    const page = screen.getByTestId('flip-page');
    expect(page.className).toMatch(/\bflex-col\b/);
    const artBox = screen.getByTestId('flip-art');
    const dialogueBox = screen.getByTestId('flip-dialogue');
    expect(artBox.nextElementSibling).toBe(dialogueBox);
    expect(within(artBox).queryByTestId('panel-dialogue')).toBeNull();
    expect(within(dialogueBox).getByTestId('panel-dialogue')).toHaveAttribute('data-placement', 'below');
    // The dialogue scrolls inside itself instead of pushing past the screen.
    expect(dialogueBox.className).toMatch(/overflow-y-auto/);
  });

  it('every text layout goes under the art on phones (speech bubbles and captions too)', async () => {
    for (const layout of ['speech_bubbles', 'caption'] as TextLayout[]) {
      const { unmount } = render(<ComicReader project={makeProject(layout)} {...props()} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(within(screen.getByTestId('flip-dialogue')).getByTestId('panel-dialogue')).toHaveAttribute('data-placement', 'below');
      unmount();
    }
  });

  it('portrait: the art gets the region minus the dialogue (no percentage guesswork)', async () => {
    await openFlip();
    relayout({ regionW: 377, regionH: 700, dialogueH: 120 });
    expect(art().style.maxWidth).toBe('377px');
    expect(art().style.maxHeight).toBe(`${700 - 120 - 8}px`);
    expect(screen.getByTestId('flip-dialogue').style.maxHeight).toBe(`${Math.round(700 * 0.4)}px`);
  });

  it('landscape: the dialogue is capped at 35% so the art stays large (no strip)', async () => {
    await openFlip();
    relayout({ regionW: 836, regionH: 377, dialogueH: 260 });
    const cap = Math.round(377 * 0.35);
    expect(screen.getByTestId('flip-dialogue').style.maxHeight).toBe(`${cap}px`);
    const artH = parseFloat(art().style.maxHeight);
    expect(artH).toBe(377 - cap - 8);
    expect(artH / 377).toBeGreaterThan(0.6);
  });

  it('no dialogue box (and the whole height for the art) when the layout is "none"', async () => {
    await openFlip('none');
    expect(screen.queryByTestId('flip-dialogue')).toBeNull();
    relayout({ regionW: 377, regionH: 700 });
    expect(art().style.maxHeight).toBe('700px');
  });
});

describe('desktop Page Flip is unchanged', () => {
  it('keeps the art and its dialogue together in the inline-flex page, as an overlay', async () => {
    setPhone(false);
    await openFlip('speech_bubbles');
    expect(screen.queryByTestId('flip-region')).toBeNull();
    const dialogue = screen.getByTestId('panel-dialogue');
    expect(dialogue).toHaveAttribute('data-placement', 'overlay');
    const page = dialogue.parentElement!;
    expect(page.className).toMatch(/\brelative inline-flex max-h-full max-w-full\b/);
    expect(page.querySelector('img')).not.toBeNull();
    expect(page.querySelector('img')!.getAttribute('style')).toBeNull();
  });
});

// PanelDialogue renders as it did before the hotfix unless the caller opts in (the studio's Review/Export step and its
// Book/PDF export do not): every classic reader surface must pass its placement and `reader`.
describe('every classic reader surface opts in to the reader dialogue', () => {
  const expectReader = (placement: string, count: number) => {
    const all = screen.getAllByTestId('panel-dialogue');
    expect(all).toHaveLength(count);
    all.forEach((d) => {
      expect(d).toHaveAttribute('data-placement', placement);
      expect(d).toHaveAttribute('data-reader', 'true');
    });
  };

  for (const phone of [true, false]) {
    it(`Scroll mode (${phone ? 'phone' : 'desktop'}): placement "auto" (phones stack narrow panels), description filter on`, async () => {
      setPhone(phone);
      vi.mocked(loadReaderState).mockResolvedValueOnce({projectId:'flip-project',mode:'scroll',updatedAt:0});
      render(<ComicReader project={makeProject('speech_bubbles')} {...props()} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByTestId('flip-region')).toBeNull();
      expectReader('auto', 2);
    });
  }

  it('Page Flip: "below" on phones, "overlay" on desktop, description filter on both', async () => {
    setPhone(true);
    const { unmount } = render(<ComicReader project={makeProject('speech_bubbles')} {...props()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expectReader('below', 1);
    unmount();
    setPhone(false);
    await openFlip('speech_bubbles');
    expectReader('overlay', 1);
  });
});

describe('historical Classic projects', () => {
  const mixed = () => {
    const p = makeProject();
    p.state.coverImageUrl = '/real-cover';
    p.state.pageStudio = { pages: [{ id: 'composed', imageUrl: '/composed', edits: [], prompt: '', createdAt: 1 }] } as typeof p.state.pageStudio;
    return p;
  };

  it('keeps authored cover, both panels and a later composed page in both reading modes', async () => {
    setPhone(false);
    vi.mocked(loadReaderState).mockResolvedValueOnce(null);
    const p = mixed();
    render(<ComicReader project={p} {...props()} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Page flip' })).toHaveAttribute('aria-pressed','true');
    const sources = [p.state.coverImageUrl!, ...p.state.panels.map(panel => panel.imageUrl!), '/composed'];
    for (let i = 0; i < sources.length; i++) {
      expect(screen.getByRole('img')).toHaveAttribute('src',sources[i]);
      if (i < sources.length - 1) fireEvent.click(screen.getByRole('button', {name: 'Next'}));
    }
    fireEvent.click(screen.getByRole('button', {name:'Scroll'}));
    expect(screen.getAllByRole('img').map(img => img.getAttribute('src'))).toEqual(sources);
  });

  it('opens old Page Studio projects with no panels property or duplicate cover thumbnail', async () => {
    const p = mixed();
    Reflect.deleteProperty(p.state,'panels');
    delete p.state.coverImageUrl;
    p.coverImage='/composed';
    render(<ComicReader project={p} {...props()} />);
    await act(async () => {});
    expect(screen.getByRole('img')).toHaveAttribute('src','/composed');
    expect(screen.getByRole('button', {name:'Next'})).toBeDisabled();
  });

  it('restores an explicitly saved mode and ignores a late restore once the reader chose a new page', async () => {
    setPhone(false);
    let resolve!: (value: Awaited<ReturnType<typeof loadReaderState>>) => void;
    vi.mocked(loadReaderState).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    vi.mocked(saveReaderState).mockClear();
    const p = mixed();
    render(<ComicReader project={p} {...props()} />);
    expect(saveReaderState).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Next'}));
    await act(async () => resolve({projectId:p.id,mode:'scroll',scrollTop:200,pageIndex:3,updatedAt:0}));
    expect(screen.getByRole('button',{name:'Page flip'})).toHaveAttribute('aria-pressed','true');
    expect(screen.getByRole('img')).toHaveAttribute('src',p.state.panels[0].imageUrl);
    expect(saveReaderState).toHaveBeenLastCalledWith(expect.objectContaining({projectId:p.id,pageIndex:1,mode:'flip'}));
  });
});

// ── The page flip, restored (fx-reader): the new page swings in from the spine, as it did before the paper turn ──
describe('the page flip', () => {
  const FLIP_NEXT = 'animate-page-flip-next';
  const FLIP_PREV = 'animate-page-flip-prev';
  let reduceOs = false;
  let phone = false;
  beforeEach(() => {
    reduceOs = false;
    phone = false;
    window.localStorage.clear();
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduceOs : phone && /pointer:\s*coarse|max-width/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;
    // jsdom lays nothing out: the stage gets a box (a swing is played only on a visible stage), pictures count as loaded.
    const rect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-paper-turn-surface')) return { x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON: () => ({}) } as DOMRect;
      return rect.call(this);
    });
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  const many = (layoutType: Project['state']['layoutType'] = 'grid') => {
    const p = makeProject('speech_bubbles');
    p.state.layoutType = layoutType;
    p.state.panels = [1, 2, 3, 4, 5].map((i) => ({ id: `p${i}`, sceneId: 1, description: '', dialogue: `Line ${i}`, imageUrl: `/panel-${i}`, imageIdHistory: [] }));
    return p;
  };
  const open = async (p = many()) => {
    vi.mocked(loadReaderState).mockResolvedValueOnce({ projectId: p.id, mode: 'flip', pageIndex: 1, updatedAt: 0 });
    render(<ComicReader project={p} {...props()} />);
    await act(async () => {});
  };
  /** The page element that swings: the sheet (desktop) or the art-over-dialogue column (phones). */
  const sheet = () => screen.getByRole('img').closest<HTMLElement>(phone ? '[data-testid="flip-page"]' : '.relative.inline-flex')!;
  const src = () => screen.getByRole('img').getAttribute('src');
  const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k }));
  const land = () => act(() => void vi.advanceTimersByTime(700));

  it('Next and Prev swing the new page in from the spine; it lands and the class comes off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await open();
      expect(src()).toBe('/panel-2');
      fireEvent.click(screen.getByRole('button', { name: /Next/ }));
      expect(src()).toBe('/panel-3');
      expect(sheet().classList.contains(FLIP_NEXT)).toBe(true);
      land();
      expect(sheet().classList.contains(FLIP_NEXT)).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: /Prev/ }));
      expect(src()).toBe('/panel-2');
      expect(sheet().classList.contains(FLIP_PREV)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the keys flip too: arrows, Space, PageDown / PageUp, and Home and End jump with the swing', async () => {
    await open();
    key('ArrowRight');
    expect([src(), sheet().classList.contains(FLIP_NEXT)]).toEqual(['/panel-3', true]);
    key(' ');
    expect([src(), sheet().classList.contains(FLIP_NEXT)]).toEqual(['/panel-4', true]);
    key('PageUp');
    expect([src(), sheet().classList.contains(FLIP_PREV)]).toEqual(['/panel-3', true]);
    key('ArrowLeft');
    key('PageDown');
    expect([src(), sheet().classList.contains(FLIP_NEXT)]).toEqual(['/panel-3', true]);
    key('End');
    expect([src(), sheet().classList.contains(FLIP_NEXT)]).toEqual(['/panel-5', true]);
    key('Home');
    expect([src(), sheet().classList.contains(FLIP_PREV)]).toEqual(['/panel-1', true]);
  });

  it('a swipe flips; a short or vertical one, or a pinch, never turns', async () => {
    await open();
    const stage = document.querySelector<HTMLElement>('[data-paper-turn-surface]')!;
    const swipe = (from: number, to: number, y1 = 300) => {
      fireEvent.touchStart(stage, { touches: [{ identifier: 0, clientX: from, clientY: 300 }] });
      fireEvent.touchMove(stage, { touches: [{ identifier: 0, clientX: to, clientY: y1 }] });
      fireEvent.touchEnd(stage, { touches: [], changedTouches: [{ identifier: 0, clientX: to, clientY: y1 }] });
    };
    swipe(500, 470);
    swipe(500, 440, 520);
    fireEvent.touchStart(stage, { touches: [{ identifier: 0, clientX: 500, clientY: 300 }, { identifier: 1, clientX: 300, clientY: 300 }] });
    fireEvent.touchEnd(stage, { touches: [], changedTouches: [{ identifier: 0, clientX: 200, clientY: 300 }] });
    expect(src()).toBe('/panel-2');
    swipe(600, 300);
    expect([src(), sheet().classList.contains(FLIP_NEXT)]).toEqual(['/panel-3', true]);
    swipe(200, 500);
    expect([src(), sheet().classList.contains(FLIP_PREV)]).toEqual(['/panel-2', true]);
  });

  it('right-to-left (manga) mirrors the swing and the keys', async () => {
    await open(many('manga'));
    key('ArrowLeft');
    expect([src(), sheet().classList.contains(FLIP_PREV)]).toEqual(['/panel-3', true]);
    key('ArrowRight');
    expect([src(), sheet().classList.contains(FLIP_NEXT)]).toEqual(['/panel-2', true]);
  });

  it('phones: the art and the dialogue under it swing in together', async () => {
    phone = true;
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    const column = screen.getByTestId('flip-page');
    expect(column.classList.contains(FLIP_NEXT)).toBe(true);
    expect(column).toContainElement(screen.getByTestId('flip-art'));
    expect(column).toContainElement(screen.getByTestId('flip-dialogue'));
    expect(within(screen.getByTestId('flip-dialogue')).getByTestId('panel-dialogue')).toHaveTextContent('Line 3');
  });

  it('reduced motion (the OS, or the reader’s own setting) turns at once with no swing', async () => {
    reduceOs = true;
    const { unmount } = render(<ComicReader project={many()} {...props()} />);
    await act(async () => {});
    key('ArrowRight');
    expect(src()).toBe('/panel-2');
    expect(document.querySelector(`.${FLIP_NEXT}, .${FLIP_PREV}`)).toBeNull();
    unmount();
    reduceOs = false;
    window.localStorage.setItem('comicstudio.reader.prefs.v1', JSON.stringify({ reduceMotion: true }));
    await open();
    key('End');
    expect(src()).toBe('/panel-5');
    expect(document.querySelector(`.${FLIP_NEXT}, .${FLIP_PREV}`)).toBeNull();
  });

  it('plays the page-turn sound when it is on (and never when it is off)', async () => {
    const made = vi.fn();
    class FakeAudio {
      sampleRate = 8000;
      currentTime = 0;
      destination = {};
      constructor() { made(); }
      createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
      createBufferSource() { return { connect: () => undefined, start: () => undefined, stop: () => undefined }; }
      createBiquadFilter() { return { connect: () => undefined, frequency: {}, Q: {} }; }
      createGain() { return { connect: () => undefined, gain: {} }; }
      close() { return Promise.resolve(); }
    }
    vi.stubGlobal('AudioContext', FakeAudio);
    await open();
    key('ArrowRight');
    expect(made).toHaveBeenCalledTimes(1);
    // Home and End are turns too: they sound like one.
    key('End');
    await waitFor(() => expect(made).toHaveBeenCalledTimes(2));
    key('Home');
    await waitFor(() => expect(made).toHaveBeenCalledTimes(3));
    window.localStorage.setItem('reader_sound', 'off');
    cleanupReaders();
    await open();
    key('ArrowRight');
    key('End');
    await act(async () => {});
    expect(made).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it('the toolbar toggle and the phone menu read “Page flip” / “Scroll”', async () => {
    await open();
    expect(within(screen.getByRole('group', { name: 'Reading mode' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Page flip', 'Scroll']);
    cleanupReaders();
    phone = true;
    vi.mocked(loadReaderState).mockResolvedValueOnce({ projectId: 'flip-project', mode: 'scroll', updatedAt: 0 });
    render(<ComicReader project={many()} {...props()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'More reader options' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Page flip/ }));
    expect(screen.getByTestId('flip-page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More reader options' }));
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Scroll$/ })).toBeInTheDocument();
  });
});
