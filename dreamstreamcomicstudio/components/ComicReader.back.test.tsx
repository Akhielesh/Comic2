import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';
import { ComicReader } from './ComicReader';
import { historyLayers, resetBackStack } from './comicstudio/mobile/backStack';

// The phone Back gesture (iOS edge swipe, Android system Back) closes the reader instead of changing the URL
// under an open reader; the reader's own exits pop its history entry so a later Back behaves.
// v5: the reader's entry is a layer on the Back stack (components/comicstudio/mobile/backStack.ts) named after its
// comic ('reader:<id>'), and a full-screen fallback is a 'fullscreen' layer above it.

// The v4 delegate's PublicComicReader loads the doc over the network; here it is a stub, which for 'v4view…' ids
// renders the real v4 ComicReaderView (its full-viewport mode is what Back must leave first).
vi.mock('./comicstudio/PublicComicReader', async () => {
  const { ComicReaderView } = await import('./comicstudio/reader/ComicReaderView');
  const { fakeUrlFor, makeSampleDoc } = await import('./comicstudio/board/__fixtures__/sampleDoc');
  const doc = makeSampleDoc((d) => {
    d.pages.forEach((p, i) => {
      if (!p.render.asset) p.render = { ...p.render, status: 'ready', asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0 } };
    });
  });
  return {
    PublicComicReader: ({ source, onClose }: { source?: { kind: string; projectId?: string }; onClose?: () => void }) => {
      const projectId = source?.projectId ?? '';
      return (
        <div data-testid="v4-reader">
          v4 reader for {projectId}
          <button onClick={onClose}>close v4</button>
          {projectId.startsWith('v4view') && <ComicReaderView doc={doc} urlFor={fakeUrlFor} initialMode="page" autoFocus={false} />}
        </div>
      );
    }
  };
});
vi.mock('./layout/StaticSiteHeader', () => ({
  StaticSiteHeader: ({ onViewComics }: { onViewComics: () => void }) => (
    <div data-testid="static-header">
      <button onClick={onViewComics}>Header library</button>
    </div>
  )
}));
vi.mock('./layout/LegalMicroLinks', () => ({
  LegalMicroLinks: ({ onOpenPrivacy }: { onOpenPrivacy: () => void }) => (
    <div data-testid="legal-links">
      <button onClick={onOpenPrivacy}>Footer privacy</button>
    </div>
  )
}));
vi.mock('./PanelDialogue', () => ({ PanelDialogue: () => <div data-testid="panel-dialogue" /> }));
vi.mock('./CommentSection', () => ({ CommentSection: () => <div data-testid="comments" /> }));
vi.mock('./modals/ReviewModal', () => ({
  ReviewModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div role="dialog" aria-label="Review">
        <button onClick={onClose}>Skip review</button>
      </div>
    ) : null
}));
vi.mock('../services/db', () => ({
  loadReaderState: vi.fn(async () => null),
  saveReaderState: vi.fn(async () => undefined),
  submitReview: vi.fn(async () => true)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

const state = (extra: Record<string, unknown> = {}): ComicState =>
  ({
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
    panels: [{ id: 'p1', sceneId: 1, description: '', dialogue: 'Hi', imageUrl: 'data:image/svg+xml,p1' }],
    ...extra
  }) as ComicState;

const project = (id: string, extra: Record<string, unknown> = {}): Project => ({ id, name: `Comic ${id}`, createdAt: 1, updatedAt: 1, state: state(extra) });

const handlers = () => ({
  onClose: vi.fn(),
  onUpdateProject: vi.fn(),
  onNavigate: vi.fn(),
  onOpenPrivacy: vi.fn(),
  onOpenTerms: vi.fn(),
  onOpenFaq: vi.fn()
});

/** The comic whose reader entry the current history entry holds (its Back-stack layer), or undefined. */
const readerState = () => historyLayers().map((l) => /^reader:(.+)#\d+$/.exec(l)?.[1]).find(Boolean);
/** The current entry holds a full-screen fallback layer (the classic reading mode, the v4 viewport mode). */
const fullscreenEntry = () => historyLayers().some((l) => /^fullscreen#\d+$/.test(l));
const back = async () => {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 30));
  });
};

// The entry each test opens the reader from; its marker is unique, so landing one entry too far back is visible.
let opening: Record<string, unknown> = {};
let entryNo = 0;
/** Wait long enough for any further traversal to land, then check the reader popped exactly its own entry. */
const expectBackWhereOpened = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(readerState()).toBeUndefined();
  expect(window.history.state).toEqual(opening);
  expect(window.location.search).toBe('?view=read&id=x');
};

// v5's reader view is a far larger module graph than production's: load the (mocked) PublicComicReader module once
// up front, so the first lazy render is not racing findBy's 1 s default on a cold module cache.
beforeAll(async () => {
  await import('./comicstudio/PublicComicReader');
}, 30_000);

beforeEach(() => {
  // Each test starts on a plain entry, as App leaves it after opening ?view=read&id=… (a push, so entries an
  // earlier test left "forward" of the current one are dropped and history.length counts are exact).
  opening = { __testEntry: ++entryNo };
  window.history.pushState(opening, '', '/?view=read&id=x');
});
afterEach(() => {
  resetBackStack();
  vi.restoreAllMocks();
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});

describe('Back closes the classic reader', () => {
  it('pushes exactly one entry of its own on open, at the same URL', () => {
    const before = window.history.length;
    const url = window.location.href;
    render(<ComicReader project={project('c1')} {...handlers()} />);
    expect(window.history.length).toBe(before + 1);
    expect(readerState()).toBe('c1');
    expect(window.location.href).toBe(url);
  });

  it('Back closes the reader (no review prompt in the way)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // would prompt for a review on a normal close
    const h = handlers();
    render(<ComicReader project={project('c2')} {...h} isReadOnly />);
    await back();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Review' })).toBeNull();
  });

  it('closing with the Close button pops the entry first, then closes once', async () => {
    const h = handlers();
    render(<ComicReader project={project('c3')} {...h} />);
    expect(readerState()).toBe('c3');
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));
    await waitFor(() => expect(h.onClose).toHaveBeenCalledTimes(1));
    expect(readerState()).toBeUndefined();
    await back();
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('the review prompt still closes through the history entry', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const h = handlers();
    const before = window.history.length;
    render(<ComicReader project={project('c4')} {...h} isReadOnly />);
    expect(readerState()).toBe('c4');
    expect(window.history.length).toBe(before + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip review' }));
    await waitFor(() => expect(h.onClose).toHaveBeenCalledTimes(1));
    await expectBackWhereOpened();
    expect(window.history.length).toBe(before + 1); // the exit pushed nothing
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('leaving through Library, the site header or a legal link pops the entry before navigating', async () => {
    const h = handlers();
    const before = window.history.length;
    // The app navigates on the popped entry: the reader's own entry is gone by the time onNavigate runs.
    let atNavigate: unknown = 'not called';
    h.onNavigate.mockImplementation(() => {
      atNavigate = readerState();
    });
    render(<ComicReader project={project('c5')} {...h} />);
    expect(readerState()).toBe('c5');
    expect(window.history.length).toBe(before + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    await waitFor(() => expect(h.onNavigate).toHaveBeenCalledWith('gallery'));
    expect(atNavigate).toBeUndefined();
    await expectBackWhereOpened();
    expect(h.onNavigate).toHaveBeenCalledTimes(1);
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('a legal link in the footer also pops first', async () => {
    const h = handlers();
    const before = window.history.length;
    let atOpen: unknown = 'not called';
    h.onOpenPrivacy.mockImplementation(() => {
      atOpen = readerState();
    });
    render(<ComicReader project={project('c6')} {...h} />);
    expect(readerState()).toBe('c6');
    expect(window.history.length).toBe(before + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Footer privacy' }));
    await waitFor(() => expect(h.onOpenPrivacy).toHaveBeenCalledTimes(1));
    expect(atOpen).toBeUndefined();
    await expectBackWhereOpened();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('a navigation the app ignores leaves the reader working: Close still closes', async () => {
    const h = handlers(); // onNavigate is a mock: the reader stays open, as if the app ignored the view
    const before = window.history.length;
    render(<ComicReader project={project('c10')} {...h} />);
    expect(readerState()).toBe('c10');
    expect(window.history.length).toBe(before + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    await waitFor(() => expect(h.onNavigate).toHaveBeenCalledWith('gallery'));
    await expectBackWhereOpened();
    // The entry is already gone: Close closes at once and never traverses further back than the opening entry.
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));
    await waitFor(() => expect(h.onClose).toHaveBeenCalledTimes(1));
    await expectBackWhereOpened();
    expect(window.history.length).toBe(before + 1);
  });

  it('StrictMode (mount, unmount, mount) adopts its entry instead of pushing twice or closing', async () => {
    const before = window.history.length;
    const h = handlers();
    render(
      <React.StrictMode>
        <ComicReader project={project('c7')} {...h} />
      </React.StrictMode>
    );
    expect(window.history.length).toBe(before + 1);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(h.onClose).not.toHaveBeenCalled();
    await back();
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('in the reading mode, Back leaves the reading mode first; the next Back closes', async () => {
    const h = handlers();
    render(<ComicReader project={project('c8')} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full' })); // no API in jsdom → reading mode
    expect(screen.getByTestId('classic-reader')).toHaveAttribute('data-reading-mode', 'true');
    await back();
    expect(screen.getByTestId('classic-reader')).toHaveAttribute('data-reading-mode', 'false');
    expect(h.onClose).not.toHaveBeenCalled();
    await back();
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('closing from the reading mode pops both entries, even with two quick Esc presses', async () => {
    const h = handlers();
    const before = window.history.length;
    render(<ComicReader project={project('c9')} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full' }));
    expect(window.history.length).toBe(before + 2);
    fireEvent.keyDown(window, { key: 'Escape' }); // leaves the reading mode (pops its entry)…
    fireEvent.keyDown(window, { key: 'Escape' }); // …and, before that traversal lands, closes the comic
    await waitFor(() => expect(h.onClose).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(readerState()).toBeUndefined();
    // Never further back than where the reader was opened from.
    expect(window.location.search).toBe('?view=read&id=x');
  });
});

describe('Back closes the v4 reader too', () => {
  it('Back closes, and its own close pops the entry', async () => {
    const h = handlers();
    const { unmount } = render(<ComicReader project={project('v4a', { studioVersion: 4 })} {...h} />);
    expect(await screen.findByTestId('v4-reader')).toBeInTheDocument();
    expect(readerState()).toBe('v4a');
    await back();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    unmount();

    const h2 = handlers();
    render(<ComicReader project={project('v4b', { studioVersion: 4 })} {...h2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'close v4' }));
    await waitFor(() => expect(h2.onClose).toHaveBeenCalledTimes(1));
    expect(readerState()).toBeUndefined();
  });
});

describe('the v4 full-viewport mode: Back leaves it before it closes the comic', () => {
  // jsdom has no Fullscreen API, as on iPhone: Full screen falls back to the viewport mode.
  const openViewport = async (id: string) => {
    const h = handlers();
    const before = window.history.length;
    render(<ComicReader project={project(id, { studioVersion: 4 })} {...h} />);
    const view = await screen.findByTestId('comic-reader');
    expect(readerState()).toBe(id);
    fireEvent.click(within(view).getByRole('button', { name: 'Full screen' }));
    expect(view).toHaveAttribute('data-fullscreen', 'viewport');
    expect(window.history.length).toBe(before + 2);
    return { h, view, before };
  };

  it('Back leaves the viewport mode and the comic stays open; the next Back closes it', async () => {
    const { h, view } = await openViewport('v4view1');
    await back();
    expect(view).toHaveAttribute('data-fullscreen', 'off');
    expect(h.onClose).not.toHaveBeenCalled();
    expect(readerState()).toBe('v4view1');
    await back();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    await expectBackWhereOpened();
  });

  it('Exit pops the viewport entry; Back then closes the comic', async () => {
    const { h, view } = await openViewport('v4view2');
    fireEvent.click(within(view).getByRole('button', { name: 'Exit full screen' }));
    expect(view).toHaveAttribute('data-fullscreen', 'off');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(readerState()).toBe('v4view2');
    expect(fullscreenEntry()).toBe(false);
    expect(h.onClose).not.toHaveBeenCalled();
    await back();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    await expectBackWhereOpened();
  });

  it('closing the comic from the viewport mode pops both entries, never further', async () => {
    const { h, before } = await openViewport('v4view3');
    fireEvent.click(screen.getByRole('button', { name: 'close v4' }));
    await waitFor(() => expect(h.onClose).toHaveBeenCalledTimes(1));
    await expectBackWhereOpened();
    expect(window.history.length).toBe(before + 2);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});
