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

import { DUPLICATE_UNAVAILABLE_FOR_STUDIO, ProjectDashboard, syncStudioTitle } from './ProjectDashboard';

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
  studioApi.streamStudio.mockReset();
  studioApi.streamStudio.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectDashboard — Comic Studio v4 cards', () => {
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
