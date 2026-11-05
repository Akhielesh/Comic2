import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import { ComicReader } from './ComicReader';
import { resetBackStack } from './comicstudio/mobile/backStack';

// Safe gestures in the classic reader's Page Flip (mobile-reading hotfix): a pinch released one finger at a time used
// to turn the page (the last finger's touchend read as a swipe), and after zooming in a sideways drag turned the page
// instead of panning. A pinch never turns a page now (either lift order), nothing turns while the page is zoomed in,
// and a mostly vertical drag is not a swipe.

vi.mock('./layout/StaticSiteHeader', () => ({ StaticSiteHeader: () => <div data-testid="static-header" /> }));
vi.mock('./layout/LegalMicroLinks', () => ({ LegalMicroLinks: () => <div data-testid="legal-links" /> }));
vi.mock('./PanelDialogue', () => ({ PanelDialogue: () => <div data-testid="panel-dialogue" /> }));
vi.mock('./CommentSection', () => ({ CommentSection: () => <div data-testid="comments" /> }));
vi.mock('./modals/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../services/db', () => ({
  loadReaderState: vi.fn(async () => ({ mode: 'flip', pageIndex: 1 })),
  saveReaderState: vi.fn(async () => undefined),
  submitReview: vi.fn(async () => true)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

const realMatchMedia = window.matchMedia;
const realVV = Object.getOwnPropertyDescriptor(window, 'visualViewport');
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
const setZoom = (scale: number) =>
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { scale, offsetLeft: 0, offsetTop: 0, width: 360, height: 740, addEventListener: () => undefined, removeEventListener: () => undefined }
  });

beforeEach(() => {
  window.history.pushState({}, '', '/?view=read&id=gestures');
  setZoom(1);
});
afterEach(() => {
  // v5: the reader is a Back-stack layer; no layer (or its deferred history pop) outlives its test.
  resetBackStack();
  window.matchMedia = realMatchMedia;
  if (realVV) Object.defineProperty(window, 'visualViewport', realVV);
  else delete (window as unknown as Record<string, unknown>).visualViewport;
});

const project = (): Project => ({
  id: 'gesture-project',
  name: 'Gestures',
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
    styleAspectRatio: '1:1',
    imageResolution: '1K',
    characters: [],
    items: [],
    locations: [],
    layoutType: 'grid',
    panels: [1, 2, 3].map((i) => ({ id: `p${i}`, sceneId: 1, description: '', dialogue: `Line ${i}`, imageUrl: `data:image/svg+xml,p${i}`, imageIdHistory: [] }))
  }
});

/** Opens Page Flip on page 2 of 3 (so a turn either way would show). */
const openFlip = async (phone = true) => {
  setPhone(phone);
  render(<ComicReader project={project()} onClose={vi.fn()} onUpdateProject={vi.fn()} onNavigate={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(counter()).toBe('2 / 3');
  return phone ? screen.getByTestId('flip-region') : screen.getByRole('img').closest('.select-none')!;
};
const counter = () => (document.body.textContent?.match(/\d+ \/ \d+/) || [''])[0];
type P = { x: number; y: number; id?: number };
const t = (p: P, i: number) => ({ clientX: p.x, clientY: p.y, identifier: p.id ?? i });
const start = (el: Element, touches: P[]) => fireEvent.touchStart(el, { touches: touches.map(t), changedTouches: touches.slice(-1).map(t) });
const move = (el: Element, touches: P[]) => fireEvent.touchMove(el, { touches: touches.map(t), changedTouches: touches.map(t) });
const end = (el: Element, remaining: P[], lifted: P[]) => fireEvent.touchEnd(el, { touches: remaining.map(t), changedTouches: lifted.map(t) });

describe('a pinch never turns a page', () => {
  for (const lift of ['right finger first', 'left finger first', 'both together']) {
    it(`lift order: ${lift}`, async () => {
      const el = await openFlip();
      const a = { x: 140, y: 380, id: 0 };
      const b = { x: 220, y: 380, id: 1 };
      start(el, [a]);
      start(el, [a, b]);
      const a2 = { x: 60, y: 380, id: 0 };
      const b2 = { x: 300, y: 380, id: 1 };
      move(el, [a2, b2]);
      if (lift === 'right finger first') {
        end(el, [a2], [b2]);
        end(el, [], [{ x: a2.x - 120, y: 380, id: 0 }]); // the left finger drifts 120 px as it lifts
      } else if (lift === 'left finger first') {
        end(el, [b2], [a2]);
        end(el, [], [{ x: b2.x + 120, y: 380, id: 1 }]);
      } else {
        end(el, [], [a2, b2]);
      }
      expect(counter()).toBe('2 / 3');
      // The next ordinary swipe still works.
      start(el, [{ x: 300, y: 400 }]);
      end(el, [], [{ x: 150, y: 405 }]);
      expect(counter()).toBe('3 / 3');
    });
  }
});

describe('zoomed in, drags pan', () => {
  it('a sideways drag never turns the page while visualViewport.scale > 1.01; at 1x it does', async () => {
    const el = await openFlip();
    setZoom(2);
    start(el, [{ x: 300, y: 400 }]);
    end(el, [], [{ x: 100, y: 400 }]);
    expect(counter()).toBe('2 / 3');
    setZoom(1);
    start(el, [{ x: 300, y: 400 }]);
    end(el, [], [{ x: 100, y: 400 }]);
    expect(counter()).toBe('3 / 3');
  });
});

describe('only real swipes turn', () => {
  it('a mostly vertical drag (scrolling the dialogue) is not a swipe; a short drag is not either', async () => {
    const el = await openFlip();
    start(el, [{ x: 200, y: 600 }]);
    end(el, [], [{ x: 140, y: 380 }]); // 60 px sideways, 220 px up
    expect(counter()).toBe('2 / 3');
    start(el, [{ x: 200, y: 400 }]);
    end(el, [], [{ x: 170, y: 400 }]);
    expect(counter()).toBe('2 / 3');
    start(el, [{ x: 100, y: 400 }]);
    end(el, [], [{ x: 220, y: 410 }]);
    expect(counter()).toBe('1 / 3');
  });

  it('a cancelled touch (the browser took the gesture) never turns later', async () => {
    const el = await openFlip();
    start(el, [{ x: 300, y: 400 }]);
    fireEvent.touchCancel(el, { touches: [], changedTouches: [t({ x: 300, y: 400 }, 0)] });
    end(el, [], [{ x: 100, y: 400 }]);
    expect(counter()).toBe('2 / 3');
  });

  it('desktop touchscreens get the same guards', async () => {
    const el = await openFlip(false);
    start(el, [{ x: 140, y: 380, id: 0 }]);
    start(el, [{ x: 140, y: 380, id: 0 }, { x: 220, y: 380, id: 1 }]);
    end(el, [{ x: 140, y: 380, id: 0 }], [{ x: 220, y: 380, id: 1 }]);
    end(el, [], [{ x: 20, y: 380, id: 0 }]);
    expect(counter()).toBe('2 / 3');
  });
});
