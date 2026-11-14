import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';

const studioApi = vi.hoisted(() => ({ streamStudio: vi.fn() }));

vi.mock('./comicstudio/studioApi', () => ({ streamStudio: studioApi.streamStudio }));
vi.mock('./DataRescue', () => ({ DataRescue: () => null }));
vi.mock('./ReadinessChecklist', () => ({ ReadinessChecklist: () => null }));
vi.mock('./common/SmartImage', () => ({
  SmartImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} />
}));
vi.mock('./modals/ProjectInfoModal', () => ({ ProjectInfoModal: () => null }));
vi.mock('../services/supabase', async () => ({ supabase: (await import('../services/projectRows.testkit')).fakeSupabase.client }));

import { DUPLICATE_UNAVAILABLE_FOR_STUDIO, ProjectDashboard, syncStudioTitle } from './ProjectDashboard';
import { fakeSupabase } from '../services/projectRows.testkit';
import { loadProjects } from '../services/db';
import { clearOtherComicIdeaDrafts } from './comicstudio/comicIdeaDraft';
import { FormFactorProvider, formFactorFor } from './comicstudio/mobile/useFormFactor';

const baseState = (): ComicState => ({
  step: 0,
  maxStepReached: 0,
  script: '',
  scenes: [],
  styleVariants: [],
  stylePrompt: '',
  styleCategory: '',
  styleAspectRatio: '2:3',
  imageResolution: '2K',
  characters: [],
  items: [],
  locations: [],
  layoutType: 'grid',
  panels: []
});

const NOW = Date.UTC(2026, 9, 21);

const studioProject = (patch: Record<string, unknown> = {}): Project => ({
  id: 'studio-1',
  name: 'Spice Market',
  createdAt: NOW,
  updatedAt: NOW,
  state: {
    ...baseState(),
    studioVersion: 4,
    studioPages: 6,
    studioRendered: 2,
    coverImageId: 'u/user/p/studio-1/img/page1.webp',
    coverImageUrl: 'https://cdn.example/page1.webp',
    ...patch
  } as ComicState
});

const classicProject = (): Project => ({
  id: 'classic-1',
  name: 'Old Wizard Comic',
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  state: { ...baseState(), pipelineMode: 'classic' }
});

const renderDashboard = (projects: Project[], overrides: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}) => {
  const props = {
    projects,
    onCreateProject: vi.fn(),
    onOpenProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onDuplicateProject: vi.fn(),
    onReadProject: vi.fn(),
    onUpdateProject: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides
  };
  const utils = render(<ProjectDashboard {...props} />);
  return { ...utils, props };
};

/** The card that holds a project's title. */
const cardFor = (name: string): HTMLElement => {
  const title = screen.getByRole('heading', { name });
  const card = title.closest('div.group') as HTMLElement | null;
  if (!card) throw new Error(`card for ${name} not found`);
  return card;
};

beforeEach(() => {
  sessionStorage.clear();
  clearOtherComicIdeaDrafts('author-a');
  studioApi.streamStudio.mockReset();
  studioApi.streamStudio.mockResolvedValue(undefined);
});

describe('Comic Studio idea workspace', () => {
  const options = { comicWorkspace: true, accountId: 'author-a', openNewComic: true };
  it('waits for the listing before choosing an empty-author entry', () => {
    const first = renderDashboard([], { comicWorkspace: true, projectsLoaded: false, accountId: 'author-a' });
    expect(screen.queryByLabelText('Your comic idea or script')).toBeNull();
    first.rerender(<ProjectDashboard {...first.props} projects={[studioProject()]} projectsLoaded />);
    expect(screen.getByRole('heading', { name: 'My comics' })).toBeVisible();
    expect(screen.queryByLabelText('Your comic idea or script')).toBeNull();
    first.unmount();
    const empty = renderDashboard([], { comicWorkspace: true, projectsLoaded: false, accountId: 'author-a' });
    empty.rerender(<ProjectDashboard {...empty.props} projectsLoaded />);
    expect(screen.getByLabelText('Your comic idea or script')).toBeVisible();
  });
  it('keeps the entry local until explicit Start and prevents double creation', async () => {
    let resolve!: () => void;
    const onCreateProject = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    renderDashboard([studioProject()], { ...options, onCreateProject });
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Comic name (optional)'), { target: { value: ' Observatory ' } });
    const idea = screen.getByLabelText('Your comic idea or script');
    fireEvent.change(idea, { target: { value: 'A botanist finds a garden on the moon.' } });
    expect(onCreateProject).not.toHaveBeenCalled();
    fireEvent.keyDown(idea, { key: 'Enter', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Preparing…' }));
    expect(onCreateProject).toHaveBeenCalledExactlyOnceWith('Observatory', 'studio', 'A botanist finds a garden on the moon.');
    await act(async () => resolve());
    fireEvent.click(screen.getByRole('button', { name: 'New comic' }));
    expect(screen.getByLabelText('Your comic idea or script')).toHaveValue('');
  });

  it('retains the idea and optional name after a failed create, then allows retry', async () => {
    const onCreateProject = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    renderDashboard([], { ...options, onCreateProject });
    fireEvent.change(screen.getByLabelText('Comic name (optional)'), { target: { value: 'Keep my name' } });
    fireEvent.change(screen.getByLabelText('Your comic idea or script'), { target: { value: 'Keep my script' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't create your comic");
    expect(screen.getByLabelText('Your comic idea or script')).toHaveValue('Keep my script');
    expect(screen.getByLabelText('Comic name (optional)')).toHaveValue('Keep my name');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(2));
  });

  it('restores an account-scoped entry after recent navigation and reload without serializing on each change', () => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const first = renderDashboard([studioProject()], options);
    const script = 'A long scene. '.repeat(12000);
    fireEvent.change(screen.getByLabelText('Your comic idea or script'), { target: { value: script } });
    expect(storageWrite).not.toHaveBeenCalledWith(expect.stringContaining('comicstudio.new-idea.'), expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Spice Market' }));
    expect(first.props.onOpenProject).toHaveBeenCalledWith('studio-1');
    first.unmount();
    const second = renderDashboard([studioProject()], options);
    expect(screen.getByLabelText('Your comic idea or script')).toHaveValue(script);
    fireEvent.click(screen.getByRole('button', { name: 'All comics' }));
    fireEvent.click(screen.getByRole('button', { name: 'New comic' }));
    expect(screen.getByLabelText('Your comic idea or script')).toHaveValue(script);
    fireEvent(window, new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('comicstudio.new-idea.author-a')!).idea).toBe(script);
    // Identity changes purge prior text, including a late cleanup from the old view.
    clearOtherComicIdeaDrafts('author-b');
    second.unmount();
    expect(sessionStorage.getItem('comicstudio.new-idea.author-a')).toBeNull();
    renderDashboard([], { ...options, accountId: 'author-b' });
    expect(screen.getByLabelText('Your comic idea or script')).toHaveValue('');
  });

  it('Start blank is explicit and leaves the unfinished entry available', async () => {
    const { props } = renderDashboard([], options);
    fireEvent.change(screen.getByLabelText('Your comic idea or script'), { target: { value: 'An idea for later' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start blank' }));
    await waitFor(() => expect(props.onCreateProject).toHaveBeenCalledExactlyOnceWith('', 'studio', undefined));
    fireEvent.click(screen.getByRole('button', { name: 'New comic' }));
    expect(screen.getByLabelText('Your comic idea or script')).toHaveValue('An idea for later');
  });

  it('keeps classic creation explicit and lets Cancel return to the unfinished idea', async () => {
    const { props } = renderDashboard([], options);
    fireEvent.change(screen.getByLabelText('Your comic idea or script'), { target: { value: 'A later idea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use the classic editor' }));
    expect(props.onCreateProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Your comic idea or script')).toHaveValue('A later idea');
    fireEvent.click(screen.getByRole('button', { name: 'Use the classic editor' }));
    fireEvent.change(screen.getByLabelText('Comic Title'), { target: { value: 'Classic title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(props.onCreateProject).toHaveBeenCalledExactlyOnceWith('Classic title', 'classic'));
  });

  it('uses a keyboard-accessible phone drawer and preserves the top context on entry', () => {
    const props = { projects: [], ...options, onCreateProject: vi.fn(), onOpenProject: vi.fn(), onDeleteProject: vi.fn(), onDuplicateProject: vi.fn(), onReadProject: vi.fn(), onUpdateProject: vi.fn() };
    render(<FormFactorProvider value={formFactorFor({ w: 320, h: 568, coarse: true })}><ProjectDashboard {...props} /></FormFactorProvider>);
    expect(screen.getByLabelText('Your comic idea or script')).not.toHaveFocus();
    const opener = screen.getByRole('button', { name: 'Open comic navigation' });
    opener.focus(); fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Comic navigation' })).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectDashboard — Comic Studio v4 cards', () => {
  it('the "My comics" heading uses the DS heading recipe, not the comic display face (DS-R0 note 10)', () => {
    renderDashboard([studioProject()]);
    const heading = screen.getByRole('heading', { level: 1, name: 'My comics' });
    expect(heading.className).toContain('ds-font-display');
    expect(heading.className).toContain('text-[var(--ds-ink)]');
    expect(heading.className).not.toMatch(/(^|\s)(font-display|text-black)(\s|$)/);
  });

  it('shows the Studio badge, page progress and the mirrored cover on v4 cards only', () => {
    renderDashboard([studioProject(), classicProject()]);

    const studioCard = cardFor('Spice Market');
    expect(within(studioCard).getByTestId('studio-badge')).toHaveTextContent('Studio');
    expect(within(studioCard).getByText('2 of 6 pages')).toBeInTheDocument();
    expect(within(studioCard).getByRole('progressbar', { name: 'Pages drawn' })).toHaveAttribute('aria-valuenow', '2');
    const cover = within(studioCard).getByAltText('Spice Market cover');
    expect(cover).toHaveAttribute('src', 'https://cdn.example/page1.webp');
    // Portrait pages are framed from the top in the 16:9 card.
    expect(cover.className).toContain('object-top');
    expect(within(studioCard).getByRole('button', { name: /open/i })).toBeInTheDocument();

    const classicCard = cardFor('Old Wizard Comic');
    expect(within(classicCard).queryByTestId('studio-badge')).toBeNull();
    expect(within(classicCard).queryByTestId('studio-progress')).toBeNull();
    expect(within(classicCard).getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });

  it('marks a fully drawn studio comic and handles an empty plan', () => {
    renderDashboard([
      studioProject({ studioPages: 3, studioRendered: 3 }),
      { ...studioProject({ studioPages: 0, studioRendered: 0, coverImageId: undefined, coverImageUrl: undefined }), id: 'studio-2', name: 'Blank Slate' }
    ]);
    const done = cardFor('Spice Market');
    expect(within(done).getByText('3 of 3 pages')).toBeInTheDocument();
    expect(within(done).getByText('Drawn')).toBeInTheDocument();

    const blank = cardFor('Blank Slate');
    expect(within(blank).getByText('No pages planned yet')).toBeInTheDocument();
    expect(within(blank).queryByRole('progressbar')).toBeNull();
    expect(within(blank).getByText('Nothing drawn yet')).toBeInTheDocument();
  });

  it('disables Duplicate for studio comics with an explanation, keeps it for classic ones', () => {
    const { props } = renderDashboard([studioProject(), classicProject()]);

    const studioDuplicate = within(cardFor('Spice Market')).getByRole('button', { name: DUPLICATE_UNAVAILABLE_FOR_STUDIO });
    expect(studioDuplicate).toBeDisabled();
    expect(studioDuplicate.parentElement).toHaveAttribute('title', DUPLICATE_UNAVAILABLE_FOR_STUDIO);
    fireEvent.click(studioDuplicate);
    expect(props.onDuplicateProject).not.toHaveBeenCalled();

    fireEvent.click(within(cardFor('Old Wizard Comic')).getByRole('button', { name: /duplicate/i }));
    expect(props.onDuplicateProject).toHaveBeenCalledWith('classic-1');
  });

  it('deletes studio comics after confirmation', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { props } = renderDashboard([studioProject()]);
    const remove = within(cardFor('Spice Market')).getByRole('button', { name: /delete/i });

    fireEvent.click(remove);
    expect(props.onDeleteProject).not.toHaveBeenCalled();
    fireEvent.click(remove);
    expect(props.onDeleteProject).toHaveBeenCalledWith('studio-1');
    expect(confirm).toHaveBeenCalledWith('Delete "Spice Market"? This can\'t be undone.');
  });

  it('routes Read and Open through the dashboard callbacks', () => {
    const { props } = renderDashboard([studioProject()]);
    const card = cardFor('Spice Market');
    fireEvent.click(within(card).getByRole('button', { name: /read/i }));
    fireEvent.click(within(card).getByRole('button', { name: /open/i }));
    expect(props.onReadProject).toHaveBeenCalledWith('studio-1');
    expect(props.onOpenProject).toHaveBeenCalledWith('studio-1');
  });
});

describe('ProjectDashboard — rename', () => {
  const rename = (from: string, to: string, key = 'Enter') => {
    fireEvent.click(screen.getByRole('button', { name: `Rename ${from}` }));
    const input = screen.getByRole('textbox', { name: 'Comic title' });
    fireEvent.change(input, { target: { value: to } });
    fireEvent.keyDown(input, { key });
  };

  it('renames a studio comic on the dashboard AND in its studio document', async () => {
    const { props } = renderDashboard([studioProject()]);
    rename('Spice Market', '  The   Spice Thief ');

    expect(props.onUpdateProject).toHaveBeenCalledTimes(1);
    expect(props.onUpdateProject).toHaveBeenCalledWith('studio-1', { name: 'The Spice Thief' });
    await waitFor(() => expect(studioApi.streamStudio).toHaveBeenCalledTimes(1));
    expect(studioApi.streamStudio).toHaveBeenCalledWith(
      'studio-1',
      { kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'The Spice Thief' } }] } },
      expect.any(Function)
    );
    // The editor closes after one commit (the unmount blur must not commit twice).
    expect(screen.queryByRole('textbox', { name: 'Comic title' })).toBeNull();
  });

  it('renames a classic comic without touching the studio API', () => {
    const { props } = renderDashboard([classicProject()]);
    rename('Old Wizard Comic', 'New Wizard Comic');
    expect(props.onUpdateProject).toHaveBeenCalledWith('classic-1', { name: 'New Wizard Comic' });
    expect(studioApi.streamStudio).not.toHaveBeenCalled();
  });

  it('ignores blank, unchanged and cancelled renames', () => {
    const { props } = renderDashboard([studioProject()]);
    rename('Spice Market', '   ');
    rename('Spice Market', 'Spice Market');
    rename('Spice Market', 'Something else', 'Escape');
    expect(props.onUpdateProject).not.toHaveBeenCalled();
    expect(studioApi.streamStudio).not.toHaveBeenCalled();
  });

  it('tells the user when the studio could not take the new title', async () => {
    studioApi.streamStudio.mockRejectedValueOnce(new Error("Couldn't reach the studio server."));
    renderDashboard([studioProject()]);
    rename('Spice Market', 'The Spice Thief');
    expect(await screen.findByRole('status')).toHaveTextContent("the studio couldn't save it (Couldn't reach the studio server.)");
  });

  it('treats an error event on the stream as a failed sync', async () => {
    studioApi.streamStudio.mockImplementationOnce(async (_id: string, _req: unknown, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'error', message: 'That edit was rejected.' });
    });
    await expect(syncStudioTitle('studio-1', 'X')).resolves.toBe('That edit was rejected.');
    studioApi.streamStudio.mockResolvedValueOnce(undefined);
    await expect(syncStudioTitle('studio-1', 'X')).resolves.toBeNull();
  });
});

describe('ProjectDashboard — new comic', () => {
  const openForm = (title: string) => {
    fireEvent.click(screen.getByRole('button', { name: /new comic/i }));
    fireEvent.change(screen.getByLabelText('Comic Title'), { target: { value: title } });
  };

  it('opens a requested creation form once and waits for explicit submission before creating a draft', async () => {
    const onCreateProject = vi.fn().mockResolvedValue(undefined);
    const onNewComicOpened = vi.fn();
    const { props, rerender } = renderDashboard([], { openNewComic: true, onNewComicOpened, onCreateProject });
    expect(screen.getByLabelText('Comic Title')).toHaveFocus();
    expect(onNewComicOpened).toHaveBeenCalledOnce();
    expect(onCreateProject).not.toHaveBeenCalled();

    rerender(<ProjectDashboard {...props} openNewComic={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Comic Title')).toBeNull();
    rerender(<ProjectDashboard {...props} openNewComic={false} projects={[classicProject()]} />);
    expect(screen.queryByLabelText('Comic Title')).toBeNull();
    expect(onCreateProject).not.toHaveBeenCalled();

    rerender(<ProjectDashboard {...props} openNewComic projects={[classicProject()]} />);
    expect(onNewComicOpened).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText('Comic Title'), { target: { value: 'Last light' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));
    expect(onCreateProject).toHaveBeenCalledExactlyOnceWith('Last light', 'studio');
  });

  it('creates a studio comic by default', async () => {
    const onCreateProject = vi.fn().mockResolvedValue(undefined);
    renderDashboard([classicProject()], { onCreateProject });
    openForm('  Moon Thieves ');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(onCreateProject).toHaveBeenCalledWith('Moon Thieves', 'studio');
    await waitFor(() => expect(screen.queryByLabelText('Comic Title')).toBeNull());
  });

  it('keeps the form open with a friendly error when creation fails', async () => {
    const failure = Object.assign(new Error("Couldn't reach the studio server. It may be waking up — check your connection and try again in a moment."), {
      kind: 'network'
    });
    const onCreateProject = vi.fn().mockRejectedValue(failure);
    renderDashboard([classicProject()], { onCreateProject });
    openForm('Moon Thieves');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the studio server.");
    expect(screen.getByLabelText('Comic Title')).toHaveValue('Moon Thieves');
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('hides technical errors behind a generic message', async () => {
    const onCreateProject = vi.fn().mockRejectedValue(new TypeError('x is undefined'));
    renderDashboard([classicProject()], { onCreateProject });
    openForm('Moon Thieves');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't create your comic. Check your connection and try again.");
  });

  it('still offers the classic editor', async () => {
    const onCreateProject = vi.fn().mockResolvedValue(undefined);
    renderDashboard([classicProject()], { onCreateProject });
    openForm('Old School');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use the classic editor instead' }));
    });
    expect(onCreateProject).toHaveBeenCalledWith('Old School', 'classic');
  });
});

describe('ProjectDashboard — new comic double submit', () => {
  it('creates exactly one comic when Enter and Create fire together', async () => {
    let resolve: () => void = () => undefined;
    const onCreateProject = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    renderDashboard([classicProject()], { onCreateProject });
    fireEvent.click(screen.getByRole('button', { name: /new comic/i }));
    const input = screen.getByLabelText('Comic Title');
    fireEvent.change(input, { target: { value: 'Moon Thieves' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /creat/i }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
  });
});

// EGRESS-DB E1: the library list holds cards (a few state keys per comic, never the classic snapshots); the
// dashboard renders them exactly as it renders the full comics.
describe('ProjectDashboard — library cards', () => {
  const toRow = (project: Project) => ({
    id: project.id,
    user_id: 'user-1',
    name: project.name,
    cover_image_url: project.coverImage ?? null,
    is_public: !!project.isPublic,
    is_forced_private: false,
    content_rating: null,
    likes_count: 0,
    views_count: 0,
    created_at: new Date(project.createdAt).toISOString(),
    updated_at: new Date(project.updatedAt).toISOString(),
    state: project.state
  });

  const fullComics = (): Project[] => {
    const classic = classicProject();
    return [
      studioProject(),
      { ...studioProject({ studioPages: 3, studioRendered: 3 }), id: 'studio-2', name: 'Done Deal', updatedAt: NOW - 10 },
      {
        ...classic,
        state: {
          ...classic.state,
          step: 6,
          overview: 'A wizard loses his hat.',
          isFeatured: true,
          comments: [{ id: 'c1', text: 'Great', createdAt: 1, likes: 1, dislikes: 0 }],
          panels: [{ id: 'p1', sceneId: 1, description: 'Hat flies', dialogue: '', imageUrl: 'https://cdn.example/p1.webp' }],
          generationStatus: { isActive: true, progress: 40, currentStepDescription: 'Drawing', estimatedTimeRemaining: '2m', logs: [] },
          versions: [{ id: 'v1', state: { script: 'old draft' } }]
        } as unknown as ComicState
      },
      {
        id: 'pages-1',
        name: 'Page Studio Story',
        createdAt: NOW - 5000,
        updatedAt: NOW - 5000,
        state: {
          ...baseState(),
          pipelineMode: 'pagestudio',
          pageStudio: { brief: 'b', style: { inline: 'data:image/png;base64,AAAA' }, layout: 'splash', aspectRatio: '2:3', resolution: '2K', pages: [{ id: 'pg1', prompt: 'p', imageUrl: 'https://cdn.example/pg1.webp' }], activePageId: 'pg1' }
        } as unknown as ComicState
      }
    ];
  };

  /** What a person sees on each card: its text and its images. */
  const snapshot = (container: HTMLElement) => ({
    text: container.textContent,
    images: Array.from(container.querySelectorAll('img')).map((img) => `${img.getAttribute('alt')} ${img.getAttribute('src')}`)
  });

  it('renders the same dashboard from the projected cards as from the full comics', async () => {
    fakeSupabase.reset();
    const full = fullComics();
    fakeSupabase.state.tables.projects = full.map(toRow);
    const cards = await loadProjects();
    expect(cards.map((p) => p.id)).toEqual(full.map((p) => p.id));
    expect(JSON.stringify(cards)).not.toContain('old draft');
    expect(JSON.stringify(cards)).not.toContain('data:image/png');

    const fromFull = renderDashboard(full);
    const expected = snapshot(fromFull.container);
    fromFull.unmount();
    const fromCards = renderDashboard(cards);
    expect(snapshot(fromCards.container)).toEqual(expected);

    expect(within(cardFor('Spice Market')).getByText('2 of 6 pages')).toBeInTheDocument();
    expect(within(cardFor('Done Deal')).getByText('Drawn')).toBeInTheDocument();
    expect(within(cardFor('Old Wizard Comic')).getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(within(cardFor('Old Wizard Comic')).getByText('BUILDING')).toBeInTheDocument();
    expect(expected.images.join(' ')).toContain('https://cdn.example/pg1.webp');
    expect(expected.images.join(' ')).toContain('https://cdn.example/p1.webp');
  });
});
