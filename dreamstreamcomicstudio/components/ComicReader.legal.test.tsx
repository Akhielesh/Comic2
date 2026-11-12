import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicPanel, Project } from '../types';
import { ComicReader } from './ComicReader';
import { SharedViewer } from './SharedViewer';
import { historyLayers, resetBackStack } from './comicstudio/mobile/backStack';
import type { LegalDocId } from './legal/legalRoutes';

// The classic reader's footer is the shared LegalMicroLinks (rendered for real here). Every one of its
// six documents opens inside the app: Privacy and Terms through onOpenPrivacy/onOpenTerms, the other
// four through onOpenLegal, each after the reader has left its back-stack layer (leaveTo), so App's
// openLegal pushes the document's entry above the comic's and Back returns to the comic. Without
// onOpenLegal those four were plain links: a full page load out of the comic.

vi.mock('./layout/StaticSiteHeader', () => ({ StaticSiteHeader: () => null }));
vi.mock('./PanelDialogue', () => ({ PanelDialogue: () => null }));
vi.mock('./CommentSection', () => ({ CommentSection: () => null }));
vi.mock('./modals/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../services/db', () => ({
  loadReaderState: vi.fn(async () => null),
  saveReaderState: vi.fn(async () => undefined),
  submitReview: vi.fn(async () => true)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../services/apiClient', async (importOriginal) => ({ ...(await importOriginal<typeof import('../services/apiClient')>()), get: apiGet }));

const panel = (i: number): ComicPanel => ({
  id: `panel-${i}`,
  sceneId: 1,
  description: '',
  dialogue: `Line ${i}`,
  imageUrl: `data:image/svg+xml,panel${i}`,
  imageIdHistory: []
});

const project: Project = {
  id: 'c-legal',
  name: 'Footer Links Test',
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
    panels: [panel(1), panel(2)]
  }
};

const OTHER_DOCS: [LegalDocId, string][] = [
  ['acceptable-use', 'Acceptable Use'],
  ['copyright', 'Copyright'],
  ['cookies', 'Cookies'],
  ['subprocessors', 'Subprocessors']
];

let entryNo = 0;
beforeEach(() => {
  window.history.pushState({ __testEntry: ++entryNo }, '', '/?view=read&id=c-legal');
});
afterEach(() => {
  resetBackStack();
  vi.clearAllMocks();
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});

describe("the comic reader's footer", () => {
  it.each(OTHER_DOCS)('opens %s in the app (no page load), after the reader has left its layer', async (doc, label) => {
    let layersAtOpen: string[] | null = null;
    const onOpenLegal = vi.fn(() => {
      layersAtOpen = historyLayers();
    });
    render(<ComicReader project={project} onClose={vi.fn()} onUpdateProject={vi.fn()} onNavigate={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} onOpenLegal={onOpenLegal} />);
    expect(historyLayers()).toHaveLength(1); // the reader's own entry
    // false: the click's default (following the link, a full page load) was prevented.
    expect(fireEvent.click(screen.getByRole('link', { name: label }))).toBe(false);
    await waitFor(() => expect(onOpenLegal).toHaveBeenCalledWith(doc));
    expect(onOpenLegal).toHaveBeenCalledTimes(1);
    expect(layersAtOpen).toEqual([]);
    expect(window.location.search).toBe('?view=read&id=c-legal');
  });

  it('keeps Privacy and Terms on their own handlers', async () => {
    const onOpenPrivacy = vi.fn();
    const onOpenLegal = vi.fn();
    render(<ComicReader project={project} onClose={vi.fn()} onUpdateProject={vi.fn()} onNavigate={vi.fn()} onOpenPrivacy={onOpenPrivacy} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} onOpenLegal={onOpenLegal} />);
    expect(fireEvent.click(screen.getByRole('link', { name: 'Privacy Policy' }))).toBe(false);
    await waitFor(() => expect(onOpenPrivacy).toHaveBeenCalledTimes(1));
    expect(onOpenLegal).not.toHaveBeenCalled();
  });
});

describe("a shared comic's reader (SharedViewer)", () => {
  it('passes onOpenLegal through, so its footer opens the other documents in the app too', async () => {
    apiGet.mockResolvedValue({ project, share: { allowDownload: false } });
    const onOpenLegal = vi.fn();
    render(<SharedViewer shareToken="tok-legal" onNavigate={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} onOpenLegal={onOpenLegal} />);
    const link = await screen.findByRole('link', { name: 'Copyright' });
    expect(apiGet).toHaveBeenCalledWith('/shares/token/tok-legal');
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(onOpenLegal).toHaveBeenCalledWith('copyright'));
  });
});
