import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicPanel, Project } from '../types';
import { ComicReader } from './ComicReader';
import { resetBackStack } from './comicstudio/mobile/backStack';
import type { LegalDocId } from './legal/legalRoutes';

// The classic reader saves where it was when it closes, and a reader opened on the same comic again
// starts there (App's Back from a legal document to the comic remounts it: "shows it again as it
// was"). The save on close must use the latest mode, page and scroll position: an effect cleanup that
// captured the first render saved page 1 in scroll mode at the top, and the scroll debounce, firing
// after the reader was gone, saved a scroll position of 0.

vi.mock('./layout/StaticSiteHeader', () => ({ StaticSiteHeader: () => null }));
vi.mock('./PanelDialogue', () => ({ PanelDialogue: () => null }));
vi.mock('./CommentSection', () => ({ CommentSection: () => null }));
vi.mock('./modals/ReviewModal', () => ({ ReviewModal: () => null }));
type Saved = { projectId: string; mode: 'scroll' | 'flip'; pageIndex: number; scrollTop: number; updatedAt: number };
// What IndexedDB would hold: a reader mounted later reads what the last one saved.
const store = vi.hoisted(() => new Map<string, Saved>());
const writes = vi.hoisted(() => [] as Array<Pick<Saved, 'mode' | 'pageIndex' | 'scrollTop'>>);
// A plain function, not vi.fn: a spy handles the promises it returns, so a rejected save would never surface.
const saveReader = vi.hoisted(() => ({
  save: async (s: Saved): Promise<void> => {
    writes.push({ mode: s.mode, pageIndex: s.pageIndex, scrollTop: s.scrollTop });
    store.set(s.projectId, s);
  }
}));
vi.mock('../services/db', () => ({
  loadReaderState: vi.fn(async (id: string) => store.get(id)),
  saveReaderState: (s: Saved) => saveReader.save(s),
  submitReview: vi.fn(async () => true)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

const panel = (i: number): ComicPanel => ({ id: `p${i}`, sceneId: 1, description: '', dialogue: `L${i}`, imageUrl: `data:image/svg+xml,p${i}`, imageIdHistory: [] });
const project: Project = {
  id: 'c-pos',
  name: 'Position Test',
  createdAt: 1,
  updatedAt: 1,
  state: {
    step: 0,
    maxStepReached: 0,
    script: 's',
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
    panels: [1, 2, 3, 4, 5, 6, 7, 8].map(panel)
  }
};

let show: (view: string) => void = () => undefined;
/** App in miniature: the reader is mounted only while the view is 'reader'; a legal document replaces it. */
const Host: React.FC = () => {
  const [view, setView] = React.useState('reader');
  show = setView;
  return view === 'reader' ? (
    <ComicReader
      project={project}
      onClose={() => setView('dashboard')}
      onUpdateProject={vi.fn()}
      onNavigate={vi.fn()}
      onOpenPrivacy={() => setView('privacy')}
      onOpenTerms={() => setView('terms')}
      onOpenFaq={vi.fn()}
      onOpenLegal={(doc: LegalDocId) => setView(doc)}
    />
  ) : (
    <p>{`legal page ${view}`}</p>
  );
};
const tick = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const leaveForCookies = async () => {
  const swallow = (e: MouseEvent) => e.preventDefault();
  document.addEventListener('click', swallow);
  fireEvent.click(screen.getByRole('link', { name: 'Cookies' }));
  document.removeEventListener('click', swallow);
  await screen.findByText('legal page cookies');
};
const scrollBox = () => document.querySelector('[class*="overflow-y-auto"]') as HTMLElement | null;

afterEach(() => {
  // Unmount the test's reader first: its close save must land before the store is cleared, not in the next test.
  cleanup();
  resetBackStack();
  store.clear();
  writes.length = 0;
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});
// Each test starts from an empty store: no earlier test's reader saves into it after it was cleared.
beforeEach(() => {
  expect(writes).toEqual([]);
  expect([...store.keys()]).toEqual([]);
});

describe('the classic reader keeps its place when it closes', () => {
  it('flip mode on page 7 → the footer\'s Cookies → Back: the comic opens again in flip mode on page 7', async () => {
    store.set(project.id, { projectId: project.id, mode: 'flip', pageIndex: 5, scrollTop: 0, updatedAt: 1 });
    window.history.pushState({}, '', '/?view=read&id=c-pos');
    render(<Host />);
    await tick(30);
    expect(document.body.textContent).toContain('6 / 8');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await tick(30);
    expect(document.body.textContent).toContain('7 / 8');
    const before = writes.length;
    await leaveForCookies();
    await tick(500);
    expect(writes.slice(before)).toEqual([{ mode: 'flip', pageIndex: 6, scrollTop: expect.any(Number) }]);
    // Back: App shows the reader again, which mounts it afresh.
    act(() => show('reader'));
    await tick(30);
    expect(document.body.textContent).toContain('7 / 8');
  });

  it('scroll mode: the position scrolled to is what is saved on leaving, and the scroll debounce never writes after the reader is gone', async () => {
    store.set(project.id, { projectId: project.id, mode: 'scroll', pageIndex: 0, scrollTop: 0, updatedAt: 1 });
    render(<Host />);
    await tick(30);
    const box = scrollBox();
    expect(box).not.toBeNull();
    box!.scrollTop = 1234;
    fireEvent.scroll(box!);
    // Leave at once, before the 400 ms debounce has saved anything.
    await leaveForCookies();
    await tick(600);
    expect(writes.at(-1)).toEqual({ mode: 'scroll', pageIndex: 0, scrollTop: 1234 });
    expect(store.get(project.id)?.scrollTop).toBe(1234);
  });

  it('opened and closed before its saved place has loaded, the stored place is untouched (no write at mount either)', async () => {
    store.set(project.id, { projectId: project.id, mode: 'flip', pageIndex: 4, scrollTop: 0, updatedAt: 1 });
    const db = await import('../services/db');
    vi.mocked(db.loadReaderState).mockImplementationOnce(() => new Promise(() => undefined));
    const before = writes.length;
    const { unmount } = render(<Host />);
    unmount();
    await tick(10);
    expect(writes.slice(before)).toEqual([]);
    expect(store.get(project.id)).toMatchObject({ mode: 'flip', pageIndex: 4 });
  });

  it('a restored scroll position stays stored while the comic is open (a reload or a killed tab runs no close save)', async () => {
    store.set(project.id, { projectId: project.id, mode: 'scroll', pageIndex: 0, scrollTop: 900, updatedAt: 1 });
    render(<Host />);
    await tick(30);
    expect(store.get(project.id)?.scrollTop).toBe(900);
  });

  it('closed after its saved place has loaded but before it is shown, it saves that place, not page 1', async () => {
    store.set(project.id, { projectId: project.id, mode: 'flip', pageIndex: 4, scrollTop: 0, updatedAt: 1 });
    const db = await import('../services/db');
    let resolve!: (s: Saved) => void;
    vi.mocked(db.loadReaderState).mockImplementationOnce(() => new Promise<Saved>((r) => (resolve = r)) as ReturnType<typeof db.loadReaderState>);
    const { unmount } = render(<Host />);
    resolve(store.get(project.id)!);
    await Promise.resolve(); // the load's callback has run; React hasn't rendered it yet
    unmount();
    expect(store.get(project.id)).toMatchObject({ mode: 'flip', pageIndex: 4 });
  });

  it('under StrictMode (npm run dev mounts it twice), it still opens where it was left', async () => {
    store.set(project.id, { projectId: project.id, mode: 'flip', pageIndex: 5, scrollTop: 0, updatedAt: 1 });
    render(
      <React.StrictMode>
        <Host />
      </React.StrictMode>
    );
    await tick(30);
    expect(document.body.textContent).toContain('6 / 8');
    expect(store.get(project.id)).toMatchObject({ mode: 'flip', pageIndex: 5 });
  });

  it('in StrictMode (index.tsx wraps App in it), a comic saved on flip page 6 opens there, and Back from Cookies lands on page 7', async () => {
    store.set(project.id, { projectId: project.id, mode: 'flip', pageIndex: 5, scrollTop: 0, updatedAt: 1 });
    const before = writes.length;
    render(
      <React.StrictMode>
        <Host />
      </React.StrictMode>
    );
    await tick(30);
    expect(document.body.textContent).toContain('6 / 8');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await tick(30);
    await leaveForCookies();
    await tick(100);
    act(() => show('reader'));
    await tick(30);
    expect(document.body.textContent).toContain('7 / 8');
    // The first render's defaults (scroll mode, page 1, top) are never written.
    expect(writes.slice(before).filter((w) => w.mode === 'scroll' && w.pageIndex === 0 && w.scrollTop === 0)).toEqual([]);
  });

  it('given another comic without remounting, it keeps each comic\'s place to itself: no save under the new comic\'s key before its place loads, and the old comic\'s late load and pending scroll save are dropped', async () => {
    const other: Project = { ...project, id: 'c-pos-b', name: 'Other Comic' };
    const db = await import('../services/db');
    const reader = (p: Project) => (
      <ComicReader project={p} onClose={vi.fn()} onUpdateProject={vi.fn()} onNavigate={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />
    );
    // A switch before the new comic's place has loaded: closing then must not save A's place under B's key.
    store.set(project.id, { projectId: project.id, mode: 'flip', pageIndex: 5, scrollTop: 0, updatedAt: 1 });
    store.set(other.id, { projectId: other.id, mode: 'scroll', pageIndex: 0, scrollTop: 900, updatedAt: 1 });
    const first = render(reader(project));
    await tick(30);
    expect(document.body.textContent).toContain('6 / 8');
    vi.mocked(db.loadReaderState).mockImplementationOnce(() => new Promise(() => undefined));
    first.rerender(reader(other));
    first.unmount();
    expect(store.get(other.id)).toMatchObject({ mode: 'scroll', pageIndex: 0, scrollTop: 900 });

    // A's load answering after the switch to B must not move B to A's place.
    store.set(other.id, { projectId: other.id, mode: 'flip', pageIndex: 2, scrollTop: 0, updatedAt: 1 });
    let resolveA!: (s: Saved | undefined) => void;
    vi.mocked(db.loadReaderState).mockImplementationOnce(() => new Promise<Saved | undefined>((r) => (resolveA = r)) as ReturnType<typeof db.loadReaderState>);
    const second = render(reader(project));
    second.rerender(reader(other));
    await tick(30);
    expect(document.body.textContent).toContain('3 / 8');
    resolveA(store.get(project.id));
    await tick(30);
    expect(document.body.textContent).toContain('3 / 8');
    second.unmount();

    // A scroll save still pending when the comic changes must not write B's scroll position under A's key.
    store.set(project.id, { projectId: project.id, mode: 'scroll', pageIndex: 0, scrollTop: 0, updatedAt: 1 });
    store.set(other.id, { projectId: other.id, mode: 'scroll', pageIndex: 0, scrollTop: 700, updatedAt: 1 });
    const third = render(reader(project));
    await tick(30);
    scrollBox()!.scrollTop = 1500;
    fireEvent.scroll(scrollBox()!);
    third.rerender(reader(other));
    await tick(30);
    expect(scrollBox()!.scrollTop).toBe(700); // B is at its own place
    await tick(600);
    expect(store.get(project.id)?.scrollTop).toBe(0);
    third.unmount();
  });

  describe('a scroll position restored before the comic is tall enough (lazy images take their height as they load)', () => {
    /** The browser clamps scrollTop to what the content allows, and a scroll that moved fires a scroll event. */
    const clampScroll = (el: HTMLElement) => {
      const box = { max: 300, top: 0 };
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => box.top,
        set: (v: number) => {
          const next = Math.max(0, Math.min(v, box.max));
          if (next === box.top) return;
          box.top = next;
          setTimeout(() => el.dispatchEvent(new Event('scroll')), 0);
        }
      });
      return box;
    };
    const openWithPendingLoad = async (scrollTop: number) => {
      store.set(project.id, { projectId: project.id, mode: 'scroll', pageIndex: 0, scrollTop, updatedAt: 1 });
      const db = await import('../services/db');
      let resolve!: (s: Saved) => void;
      vi.mocked(db.loadReaderState).mockImplementationOnce(() => new Promise<Saved>((r) => (resolve = r)) as ReturnType<typeof db.loadReaderState>);
      render(<Host />);
      const el = scrollBox()!;
      const box = clampScroll(el);
      resolve(store.get(project.id)!);
      await tick(40);
      return { el, box };
    };

    it('is held and applied again as images load until it is reached, and the clamped position is never saved', async () => {
      const { el, box } = await openWithPendingLoad(900);
      expect(el.scrollTop).toBe(300); // clamped: the comic isn't tall enough yet
      await tick(500); // past the scroll debounce
      expect(store.get(project.id)?.scrollTop).toBe(900);
      box.max = 2000;
      act(() => {
        el.querySelector('img')!.dispatchEvent(new Event('load'));
      });
      expect(el.scrollTop).toBe(900);
      await tick(500);
      expect(store.get(project.id)?.scrollTop).toBe(900);
      // Once reached, the reader's own scrolling is saved again.
      el.scrollTop = 1200;
      await tick(500);
      expect(store.get(project.id)?.scrollTop).toBe(1200);
    });

    it('closed while it is still held, it saves the held position', async () => {
      const { el } = await openWithPendingLoad(900);
      expect(el.scrollTop).toBe(300);
      await leaveForCookies();
      await tick(30);
      expect(store.get(project.id)).toMatchObject({ mode: 'scroll', scrollTop: 900 });
    });

    it('scrolled by hand while it is held, the reader keeps (and saves) where they scrolled to', async () => {
      const { el, box } = await openWithPendingLoad(900);
      fireEvent.wheel(el, { deltaY: -100 });
      el.scrollTop = 120;
      await tick(500);
      expect(store.get(project.id)?.scrollTop).toBe(120);
      box.max = 2000;
      act(() => {
        el.querySelector('img')!.dispatchEvent(new Event('load'));
      });
      expect(el.scrollTop).toBe(120);
    });
  });

  it('a save that fails (IndexedDB unavailable) is never an unhandled rejection, while reading or on close (the status bar reports those as app errors)', async () => {
    const keep = saveReader.save;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let failed = 0;
    saveReader.save = () => {
      failed += 1;
      return Promise.reject(new Error('indexedDB.open failed'));
    };
    try {
      store.set(project.id, { projectId: project.id, mode: 'flip', pageIndex: 1, scrollTop: 0, updatedAt: 1 });
      render(<Host />);
      await tick(30);
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      await tick(30);
      expect(document.body.textContent).toContain('3 / 8');
      await leaveForCookies();
      await tick(30);
      expect(failed).toBeGreaterThanOrEqual(2); // the page turn's save and the close save
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      saveReader.save = keep;
      store.clear();
    }
  });

  it('a saved page beyond the comic\'s end (it has fewer pages now) opens on its last page, and that is what is saved', async () => {
    store.set(project.id, { projectId: project.id, mode: 'flip', pageIndex: 7, scrollTop: 0, updatedAt: 1 });
    const short: Project = { ...project, state: { ...project.state, panels: project.state.panels.slice(0, 5) } };
    const { unmount } = render(
      <ComicReader project={short} onClose={vi.fn()} onUpdateProject={vi.fn()} onNavigate={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />
    );
    await tick(30);
    expect(document.body.textContent).toContain('5 / 5');
    expect(document.body.textContent).not.toContain('Image missing');
    unmount();
    expect(store.get(project.id)).toMatchObject({ mode: 'flip', pageIndex: 4 });
  });
});
