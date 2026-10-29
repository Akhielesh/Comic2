import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicPanel, Project, TextLayout } from '../types';
import { ComicReader } from './ComicReader';
import { resetBackStack } from './comicstudio/mobile/backStack';
import { loadReaderState } from '../services/db';

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
      vi.mocked(loadReaderState).mockResolvedValueOnce(undefined);
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
