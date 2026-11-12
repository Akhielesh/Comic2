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

  describe('a scroll place reopens on the picture it was on: every picture has its box before it loads, and the place is an anchor', () => {
    type Place = Saved & { anchor?: { key: string; frac: number }; boxes?: Record<string, [number, number]> };
    /** Opens `p` with `place` stored, the load answered once `prepare` has laid out the scroll box. */
    const openAt = async (place: Partial<Place>, opts: { p?: Project; prepare?: (el: HTMLElement) => void } = {}) => {
      const p = opts.p ?? project;
      store.set(p.id, { projectId: p.id, mode: 'scroll', pageIndex: 0, scrollTop: 0, updatedAt: 1, ...place } as Saved);
      const db = await import('../services/db');
      let resolve!: (s: Saved) => void;
      vi.mocked(db.loadReaderState).mockImplementationOnce(() => new Promise<Saved>((r) => (resolve = r)) as ReturnType<typeof db.loadReaderState>);
      const view = render(
        <ComicReader project={p} onClose={vi.fn()} onUpdateProject={vi.fn()} onNavigate={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />
      );
      const el = scrollBox()!;
      opts.prepare?.(el);
      await act(async () => resolve(store.get(p.id)!));
      return { el, view };
    };
    /** The panels as a browser lays them out: `height` px each from 100 px down (the box's top is 0). */
    const layOut = (height: number) => (el: HTMLElement) =>
      el.querySelectorAll<HTMLElement>('[data-panel-key]').forEach((item, i) => {
        item.getBoundingClientRect = () => ({ top: 100 + i * height - el.scrollTop, bottom: 100 + (i + 1) * height - el.scrollTop, height }) as DOMRect;
      });
    const imgs = () => [...document.querySelectorAll('img')];
    const box = (img: HTMLImageElement) => [img.getAttribute('width'), img.getAttribute('height')];

    it('each picture gets the box this browser saw it at, else the ratio it was made at (a custom crop, its layout slot, the style ratio; a Page Studio page: the studio\'s), as width and height', async () => {
      const panels = [1, 2, 3, 4].map(panel);
      panels[1] = { ...panels[1], imageId: 'img-2' };
      const seen: Partial<Place> = { boxes: { 'img-2': [800, 1200], cover: [1200, 800] } };
      const comic = (state: Partial<Project['state']>): Project => ({ ...project, id: `c-box-${Object.keys(state).join('-')}`, state: { ...project.state, panels, ...state } });

      const first = await openAt(seen, { p: comic({ coverImageUrl: 'data:image/svg+xml,cover' }) });
      expect(imgs().map(box)).toEqual([['1200', '800'], ['1000', '1000'], ['800', '1200'], ['1000', '1000'], ['1000', '1000']]);
      first.view.unmount();
      const custom = await openAt(seen, { p: comic({ customAspectRatioEnabled: true, customAspectRatio: '16:9' }) });
      expect(imgs().map(box)).toEqual([['1000', '563'], ['800', '1200'], ['1000', '563'], ['1000', '563']]);
      custom.view.unmount();
      const grid = await openAt(seen, { p: comic({ gridTemplateId: 'portrait-hero-2-insets' }) });
      expect(imgs().map(box)).toEqual([['1000', '667'], ['800', '1200'], ['1000', '1000'], ['1000', '667']]);
      grid.view.unmount();
      const pageStudio = { aspectRatio: '2:3', pages: [{ id: 'pg1', prompt: '', imageUrl: 'data:image/svg+xml,pg1', edits: [], createdAt: 1 }] } as unknown as Project['state']['pageStudio'];
      await openAt({}, { p: comic({ panels: [], pageStudio }) });
      expect(imgs().map(box)).toEqual([['1000', '1500']]);
    });

    it('reopens on the anchored panel, as far into it, where the saved scrollTop now shows another (another width, or pictures of another size)', async () => {
      const { el } = await openAt({ scrollTop: 900, anchor: { key: 'p6:5', frac: 0.5 } }, { prepare: layOut(300) });
      expect(el.scrollTop).toBe(100 + 5 * 300 + 150);
    });

    it('a place saved before anchors were kept (or one whose panel is gone) reopens at its scrollTop', async () => {
      const old = await openAt({ scrollTop: 900 }, { prepare: layOut(300) });
      expect(old.el.scrollTop).toBe(900);
      old.view.unmount();
      const gone = await openAt({ scrollTop: 700, anchor: { key: 'not-here', frac: 0.2 } }, { prepare: layOut(300) });
      expect(gone.el.scrollTop).toBe(700);
    });

    it('both saves (the scroll save and the close) write the anchor and the boxes, pruned to the pictures in the comic now', async () => {
      const { el, view } = await openAt({ scrollTop: 0, boxes: { 'p2:1': [800, 1200], 'gone-img': [10, 10] } }, { prepare: layOut(300) });
      const loaded = imgs()[2];
      for (const [k, v] of [['complete', true], ['naturalWidth', 640], ['naturalHeight', 480]] as const) Object.defineProperty(loaded, k, { configurable: true, value: v });
      el.scrollTop = 1750;
      fireEvent.scroll(el);
      await tick(500);
      const expected = { anchor: { key: 'p6:5', frac: 0.5 }, boxes: { 'p2:1': [800, 1200], 'p3:2': [640, 480] } };
      expect(store.get(project.id)).toMatchObject({ mode: 'scroll', scrollTop: 1750, ...expected });
      expect(Object.keys((store.get(project.id) as Place).boxes!).sort()).toEqual(['p2:1', 'p3:2']);
      el.scrollTop = 100 + 2 * 300 + 30;
      store.clear();
      view.unmount();
      expect(store.get(project.id)).toMatchObject({ mode: 'scroll', scrollTop: 730, anchor: { key: 'p3:2', frac: 0.1 }, boxes: expected.boxes });
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
