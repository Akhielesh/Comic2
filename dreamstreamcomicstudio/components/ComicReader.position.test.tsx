import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../services/db', () => ({
  loadReaderState: vi.fn(async (id: string) => store.get(id)),
  saveReaderState: vi.fn(async (s: Saved) => {
    writes.push({ mode: s.mode, pageIndex: s.pageIndex, scrollTop: s.scrollTop });
    store.set(s.projectId, s);
  }),
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
  resetBackStack();
  store.clear();
  writes.length = 0;
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
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

  it('closed before its saved place has loaded, it saves nothing (it would overwrite that place with page 1)', async () => {
    store.set(project.id, { projectId: project.id, mode: 'flip', pageIndex: 4, scrollTop: 0, updatedAt: 1 });
    const db = await import('../services/db');
    vi.mocked(db.loadReaderState).mockImplementationOnce(() => new Promise(() => undefined));
    const { unmount } = render(<Host />);
    const before = writes.length;
    unmount();
    expect(writes.slice(before).filter((w) => w.mode === 'scroll' && w.pageIndex === 0 && w.scrollTop === 0)).toHaveLength(0);
  });
});
