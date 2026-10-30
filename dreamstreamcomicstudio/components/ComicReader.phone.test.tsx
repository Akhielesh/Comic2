import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicPanel, Project } from '../types';
import { ComicReader } from './ComicReader';
import { resetBackStack } from './comicstudio/mobile/backStack';
import { resetIosFullscreenNoteForTests } from '../services/fullscreen';

// Classic reader on phones (mobile-reading hotfix): phone reading mode, full screen that always works.

vi.mock('./layout/StaticSiteHeader', () => ({
  StaticSiteHeader: () => <div data-testid="static-header" />
}));
vi.mock('./layout/LegalMicroLinks', () => ({
  LegalMicroLinks: () => <div data-testid="legal-links" />
}));
vi.mock('./PanelDialogue', () => ({
  PanelDialogue: () => <div data-testid="panel-dialogue" />
}));
vi.mock('./CommentSection', () => ({
  CommentSection: () => <div data-testid="comments" />
}));
vi.mock('./modals/ReviewModal', () => ({
  ReviewModal: () => null
}));
vi.mock('../services/db', () => ({
  loadReaderState: vi.fn(async () => null),
  saveReaderState: vi.fn(async () => undefined),
  submitReview: vi.fn(async () => true)
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null })
}));

const realMatchMedia = window.matchMedia;
const realUA = window.navigator.userAgent;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0 Mobile/15E148 Safari/604.1';

/** Phone = coarse pointer / narrow viewport; everything else (reduced motion, standalone) stays false. */
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

const panel = (i: number): ComicPanel => ({
  id: `panel-${i}`,
  sceneId: 1,
  description: '',
  dialogue: `Line ${i}`,
  imageUrl: `data:image/svg+xml,panel${i}`,
  imageIdHistory: []
});

const makeProject = (n = 3): Project => ({
  id: 'project-phone',
  name: 'Phone Reader Test',
  createdAt: 1,
  updatedAt: 1,
  state: {
    step: 0,
    maxStepReached: 0,
    script: 'Once upon a time.',
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
    panels: Array.from({ length: n }, (_, i) => panel(i + 1))
  }
});

const props = () => ({
  onClose: vi.fn(),
  onUpdateProject: vi.fn(),
  onNavigate: vi.fn(),
  onOpenPrivacy: vi.fn(),
  onOpenTerms: vi.fn(),
  onOpenFaq: vi.fn()
});

const renderReader = (p = props()) => {
  render(<ComicReader project={makeProject()} {...p} />);
  return p;
};

const reader = () => screen.getByTestId('classic-reader');
const removeFsApi = () => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
};

beforeEach(() => {
  window.localStorage.clear();
  resetIosFullscreenNoteForTests();
  removeFsApi();
});
afterEach(() => {
  // v5: the reader is a Back-stack layer; no layer (or its deferred history pop) outlives its test.
  resetBackStack();
  window.matchMedia = realMatchMedia;
  Object.defineProperty(window.navigator, 'userAgent', { value: realUA, configurable: true });
  removeFsApi();
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
  vi.useRealTimers();
});

describe('desktop stays as it was', () => {
  it('keeps the site header, toolbar Full button and legal links', () => {
    setPhone(false);
    renderReader();
    expect(screen.getByTestId('static-header')).toBeInTheDocument();
    expect(screen.getByTestId('legal-links')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Full' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More reader options' })).toBeNull();
    expect(reader()).toHaveAttribute('data-phone', 'false');
  });
});

describe('phone reading mode', () => {
  beforeEach(() => setPhone(true));

  it('drops the site header and legal links, and pins 44 px Close and Full screen outside the scroller', () => {
    renderReader();
    expect(screen.queryByTestId('static-header')).toBeNull();
    expect(screen.queryByTestId('legal-links')).toBeNull();
    const close = screen.getByRole('button', { name: 'Close reader' });
    const full = screen.getByRole('button', { name: 'Full screen' });
    for (const b of [close, full, screen.getByRole('button', { name: 'More reader options' })]) {
      expect(b.className).toMatch(/\bh-11\b/);
      expect(b.className).toMatch(/\bw-11\b/);
      // Never inside a horizontally scrolling toolbar (that is what put Full at x=706 on a 393 px phone).
      expect(b.closest('.overflow-x-auto')).toBeNull();
    }
  });

  it('puts every other control in one "⋯" menu (sign-in included)', async () => {
    const p = renderReader();
    fireEvent.click(screen.getByRole('button', { name: 'More reader options' }));
    const menu = screen.getByRole('menu');
    for (const label of ['Library', 'Dashboard', 'Story', 'Info', 'Comments', 'Page Flip', 'Sign in']) {
      expect(within(menu).getByRole('menuitem', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(within(menu).getByRole('menuitemcheckbox', { name: /FX/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemcheckbox', { name: /sound/i })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Page Flip/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByText(/1 \/ 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More reader options' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Library/ }));
    // Leaving pops the reader's history entry first (Back closes the reader), then navigates.
    await waitFor(() => expect(p.onNavigate).toHaveBeenCalledWith('gallery'));
  });

  it('moves the legal links into the Info sheet', async () => {
    const p = renderReader();
    fireEvent.click(screen.getByRole('button', { name: 'More reader options' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Info/ }));
    const sheet = screen.getByRole('dialog', { name: 'Comic Info' });
    expect(within(sheet).getByRole('button', { name: 'Terms & Conditions' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'FAQs' })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Privacy Policy' }));
    await waitFor(() => expect(p.onOpenPrivacy).toHaveBeenCalled());
  });

  it('tapping the art toggles the chrome, which also hides itself after 2.5 s', () => {
    vi.useFakeTimers();
    renderReader();
    expect(reader()).toHaveAttribute('data-chrome', 'visible');
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(reader()).toHaveAttribute('data-chrome', 'hidden');
    // Hidden chrome is out of the accessibility tree (no invisible-but-focusable buttons).
    expect(screen.queryByRole('button', { name: 'Close reader' })).toBeNull();
    fireEvent.click(screen.getAllByRole('img')[0]);
    expect(reader()).toHaveAttribute('data-chrome', 'visible');
    fireEvent.click(screen.getAllByRole('img')[0]);
    expect(reader()).toHaveAttribute('data-chrome', 'hidden');
  });

  it('keeps the chrome up while the menu is open', () => {
    vi.useFakeTimers();
    renderReader();
    fireEvent.click(screen.getByRole('button', { name: 'More reader options' }));
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(reader()).toHaveAttribute('data-chrome', 'visible');
  });
});

describe('Full screen always does something', () => {
  it('iPhone (no API): enters the reading mode, no error, an Exit that is always visible, scroll locked', () => {
    setPhone(true);
    Object.defineProperty(window.navigator, 'userAgent', { value: IPHONE_UA, configurable: true });
    renderReader();
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))).not.toThrow();
    expect(reader()).toHaveAttribute('data-reading-mode', 'true');
    expect(reader()).toHaveAttribute('data-chrome', 'hidden');
    const exit = screen.getByRole('button', { name: 'Exit full screen' });
    expect(exit.className).toMatch(/\bh-11\b/);
    expect(document.documentElement.style.overflow).toBe('hidden');
    // One-time note, exact copy.
    expect(screen.getByRole('status')).toHaveTextContent('iPhone browsers keep their toolbars. Share → Add to Home Screen opens comics edge-to-edge.');
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText(/keep their toolbars/)).toBeNull();
    fireEvent.click(exit);
    expect(reader()).toHaveAttribute('data-reading-mode', 'false');
    expect(document.documentElement.style.overflow).toBe('');
    // Second time: no note.
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(screen.queryByText(/keep their toolbars/)).toBeNull();
  });

  it('a refused request falls back to the reading mode and never shows a false "Exit" first', async () => {
    setPhone(true);
    let reject!: (e: Error) => void;
    (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen = vi.fn(
      () => new Promise<void>((_, rej) => (reject = rej))
    );
    renderReader();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    // Pending: nothing is full screen yet, so the label must not flip.
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeInTheDocument();
    expect(reader()).toHaveAttribute('data-reading-mode', 'false');
    await act(async () => {
      reject(new TypeError('Permissions check failed'));
      await Promise.resolve();
    });
    expect(reader()).toHaveAttribute('data-reading-mode', 'true');
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();
  });

  it('native full screen: the label follows fullscreenchange only', () => {
    setPhone(false);
    const req = vi.fn(() => Promise.resolve());
    (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen = req;
    renderReader();
    fireEvent.click(screen.getByRole('button', { name: 'Full' }));
    expect(req).toHaveBeenCalledWith({ navigationUI: 'hide' });
    // Resolved but no change event yet: still "Full" (no optimistic setIsFullscreen(true)).
    expect(screen.getByRole('button', { name: 'Full' })).toBeInTheDocument();
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: reader(), configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(screen.getByRole('button', { name: 'Exit' })).toBeInTheDocument();
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(screen.getByRole('button', { name: 'Full' })).toBeInTheDocument();
  });

  it('native full screen on a phone: the chrome steps aside, and a 44 px Exit stays on screen', () => {
    setPhone(true);
    (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen = vi.fn(() => Promise.resolve());
    const exit = vi.fn(() => Promise.resolve());
    (document as unknown as Record<string, unknown>).exitFullscreen = exit;
    renderReader();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: reader(), configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(reader()).toHaveAttribute('data-chrome', 'hidden');
    const pill = screen.getByRole('button', { name: 'Exit full screen' });
    expect(pill.className).toMatch(/\bh-11\b/);
    fireEvent.click(pill);
    expect(exit).toHaveBeenCalledTimes(1);
    delete (document as unknown as Record<string, unknown>).exitFullscreen;
  });

  it('desktop without the API: reading mode hides header, toolbar and footer; Esc leaves the reading mode, not the comic', () => {
    setPhone(false);
    const p = renderReader();
    fireEvent.click(screen.getByRole('button', { name: 'Full' }));
    expect(reader()).toHaveAttribute('data-reading-mode', 'true');
    expect(screen.queryByTestId('static-header')).toBeNull();
    expect(screen.queryByTestId('legal-links')).toBeNull();
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(reader()).toHaveAttribute('data-reading-mode', 'false');
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('static-header')).toBeInTheDocument();
  });
});
