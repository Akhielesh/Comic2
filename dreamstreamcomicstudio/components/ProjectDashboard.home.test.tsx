import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';

vi.mock('./comicstudio/studioApi', () => ({ streamStudio: vi.fn() }));
vi.mock('./DataRescue', () => ({ DataRescue: () => <div data-testid="data-rescue" /> }));
vi.mock('./ReadinessChecklist', () => ({ ReadinessChecklist: () => <div data-testid="readiness-checklist" /> }));
vi.mock('./common/SmartImage', () => ({
  SmartImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} />
}));
vi.mock('./modals/ProjectInfoModal', () => ({ ProjectInfoModal: () => null }));
vi.mock('../services/supabase', async () => ({ supabase: (await import('../services/projectRows.testkit')).fakeSupabase.client }));

import { ProjectDashboard } from './ProjectDashboard';
import { clearOtherComicIdeaDrafts } from './comicstudio/comicIdeaDraft';
import { HOME_START_HELP } from './comicstudio/home/homeModel';
import { addKey, clearAllKeys, recordKeyUsage } from '../services/apiKeys';

const HOUR = 3_600_000;

const studioProject = (id: string, name: string, updatedAt = Date.now() - 2 * HOUR): Project => ({
  id,
  name,
  createdAt: updatedAt - 24 * HOUR,
  updatedAt,
  state: {
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
    panels: [],
    studioVersion: 4,
    studioPages: 10,
    studioRendered: 3,
    coverImageUrl: `/assets/comic-sample/${id}.webp`
  } as ComicState
});

const renderDashboard = (projects: Project[], overrides: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}) => {
  const props = {
    projects,
    accountId: 'author-home',
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

const brand = () => screen.getAllByRole('button', { name: 'Comic Studio, home' })[0];

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  clearAllKeys();
  clearOtherComicIdeaDrafts('author-home');
});

describe('ProjectDashboard in Comic Studio: the brand opens your comics', () => {
  it('from the idea form, the brand shows All comics when comics exist and never leaves for the landing', () => {
    const { props } = renderDashboard([studioProject('a', 'Harbour Lights')], { comicWorkspace: true, openNewComic: true });
    expect(screen.getByLabelText('Your comic idea or script')).toBeInTheDocument();
    fireEvent.click(brand());
    expect(props.onNavigate).not.toHaveBeenCalledWith('home');
    expect(props.onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Your comic idea or script')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'My comics' })).toBeInTheDocument();
  });

  it('with no comics, the brand shows the idea form', () => {
    const { props } = renderDashboard([], { comicWorkspace: true });
    // The classic form is reachable from the idea form; the brand brings the member back to the idea.
    fireEvent.click(screen.getByRole('button', { name: 'Use the classic editor' }));
    expect(screen.getByLabelText('Comic Title')).toBeInTheDocument();
    fireEvent.click(brand());
    expect(screen.getByLabelText('Your comic idea or script')).toBeInTheDocument();
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it('from All comics, the brand stays on All comics', () => {
    const { props } = renderDashboard([studioProject('a', 'Harbour Lights')], { comicWorkspace: true });
    expect(screen.getByRole('heading', { level: 1, name: 'My comics' })).toBeInTheDocument();
    fireEvent.click(brand());
    expect(screen.getByRole('heading', { level: 1, name: 'My comics' })).toBeInTheDocument();
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it('while the list is still loading, the brand waits for it before choosing the idea form', () => {
    const first = renderDashboard([], { comicWorkspace: true, projectsLoaded: false, openNewComic: true });
    fireEvent.click(brand());
    expect(screen.queryByLabelText('Your comic idea or script')).toBeNull();
    first.rerender(<ProjectDashboard {...first.props} projects={[studioProject('a', 'Harbour Lights')]} projectsLoaded />);
    expect(screen.getByRole('heading', { level: 1, name: 'My comics' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Your comic idea or script')).toBeNull();
  });

  it('does nothing while a create runs: the idea form keeps its Preparing… and then shows the create error', async () => {
    let fail!: (error: Error) => void;
    const onCreateProject = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    renderDashboard([studioProject('a', 'Harbour Lights')], { comicWorkspace: true, openNewComic: true, onCreateProject });
    fireEvent.change(screen.getByLabelText('Your comic idea or script'), { target: { value: 'A lighthouse keeper finds a map.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onCreateProject).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled();
    fireEvent.click(brand());
    expect(screen.getByLabelText('Your comic idea or script')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'My comics' })).toBeNull();
    await act(async () => fail(new Error('offline')));
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't create your comic.");
    expect(screen.getByLabelText('Your comic idea or script')).toHaveValue('A lighthouse keeper finds a map.');
  });
});

describe('ProjectDashboard in Comic Studio: Continue, and no setup box', () => {
  it('does not mount the setup checklist in Comic Studio, and still does on the main dashboard', () => {
    const studio = renderDashboard([studioProject('a', 'Harbour Lights')], { comicWorkspace: true });
    expect(screen.queryByTestId('readiness-checklist')).toBeNull();
    expect(screen.getByTestId('data-rescue')).toBeInTheDocument();
    studio.unmount();
    renderDashboard([studioProject('a', 'Harbour Lights')]);
    expect(screen.getByTestId('readiness-checklist')).toBeInTheDocument();
    expect(screen.getByTestId('data-rescue')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Continue/ })).toBeNull();
  });

  it('shows one Continue card for the newest studio comic, above the grid', () => {
    const { props } = renderDashboard(
      [studioProject('older', 'Older Tale', Date.now() - 30 * HOUR), studioProject('newest', 'Harbour Lights', Date.now() - 2 * HOUR)],
      { comicWorkspace: true }
    );
    const card = screen.getByRole('region', { name: 'Continue Harbour Lights' });
    expect(screen.getAllByRole('region', { name: /^Continue/ })).toHaveLength(1);
    const grid = screen.getAllByRole('heading', { level: 3, name: 'Older Tale' })[0];
    expect(card.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /^Continue/ }));
    expect(props.onOpenProject).toHaveBeenCalledExactlyOnceWith('newest');
    fireEvent.click(within(card).getByRole('button', { name: /Read/ }));
    expect(props.onReadProject).toHaveBeenCalledExactlyOnceWith('newest');
  });

  it('shows no Continue card when nothing was edited in the last 14 days, or while the idea form is open', () => {
    const stale = renderDashboard([studioProject('old', 'Older Tale', Date.now() - 20 * 24 * HOUR)], { comicWorkspace: true });
    expect(screen.queryByRole('region', { name: /^Continue/ })).toBeNull();
    stale.unmount();
    renderDashboard([studioProject('a', 'Harbour Lights')], { comicWorkspace: true, openNewComic: true });
    expect(screen.queryByRole('region', { name: /^Continue/ })).toBeNull();
  });

  it('adds one quiet line when the member’s own key is over its limit, and Manage keys opens the API keys settings', () => {
    addKey({ provider: 'openrouter', key: 'test-key-not-real', limitUsd: 5 });
    recordKeyUsage('openrouter', 5);
    const { props } = renderDashboard([studioProject('a', 'Harbour Lights')], { comicWorkspace: true });
    expect(screen.getByText('Your OpenRouter key reached its monthly limit.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage keys' }));
    expect(props.onNavigate).toHaveBeenCalledExactlyOnceWith('settings', 'settings');
  });

  it('keeps the frame’s New comic as the only fill on All comics', () => {
    const { container } = renderDashboard([studioProject('a', 'Harbour Lights')], { comicWorkspace: true });
    const card = screen.getByRole('region', { name: 'Continue Harbour Lights' });
    // The frame's own fills come from comicCreationWorkspace.css: New comic is filled unless its view is open
    // (aria-current), and Start is always filled. The rest of the app marks a fill with the class or the variant.
    const FILLS = '.comics-primary-action, [data-variant="create"], .comic-project-nav .comic-project-new:not([aria-current="page"]), .comic-idea-start';
    const fills = container.querySelectorAll(FILLS);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toHaveAccessibleName('New comic');
    expect(card.contains(fills[0])).toBe(false);
    expect(card.querySelector(`${FILLS}, [data-variant="default"]`)).toBeNull();
  });

  it('starts the page outline at the h1 "My comics"; the Continue card and the key line come after it, above the filters', () => {
    addKey({ provider: 'openrouter', key: 'test-key-not-real', limitUsd: 5 });
    recordKeyUsage('openrouter', 5);
    renderDashboard([studioProject('a', 'Harbour Lights')], { comicWorkspace: true });
    const h1 = screen.getByRole('heading', { level: 1, name: 'My comics' });
    expect(screen.getAllByRole('heading')[0]).toBe(h1);
    const card = screen.getByRole('region', { name: 'Continue Harbour Lights' });
    const line = screen.getByText('Your OpenRouter key reached its monthly limit.');
    const search = screen.getByRole('textbox', { name: 'Search projects' });
    expect(h1.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no Continue card while the classic form is open over My comics', () => {
    renderDashboard([studioProject('a', 'Harbour Lights')], { comicWorkspace: true });
    expect(screen.getByRole('region', { name: 'Continue Harbour Lights' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New comic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use the classic editor' }));
    expect(screen.getByLabelText('Comic Title')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'My comics' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Continue/ })).toBeNull();
  });

  it('keeps the Continue comic when another comic is starred, which stamps its updatedAt', () => {
    // As useProjectManager.updateProject: every change, a star included, sets updatedAt to now.
    function Live({ initial }: { initial: Project[] }) {
      const [projects, setProjects] = React.useState(initial);
      const onUpdateProject = (id: string, updates: Partial<Project> | ((prev: Project) => Partial<Project>)) =>
        setProjects((prev) => prev.map((p) => (p.id !== id ? p : { ...p, ...(typeof updates === 'function' ? updates(p) : updates), updatedAt: Date.now() })));
      return (
        <ProjectDashboard projects={projects} accountId="author-home" comicWorkspace onCreateProject={vi.fn()} onOpenProject={vi.fn()}
          onDeleteProject={vi.fn()} onDuplicateProject={vi.fn()} onReadProject={vi.fn()} onUpdateProject={onUpdateProject} onNavigate={vi.fn()} />
      );
    }
    render(<Live initial={[studioProject('older', 'Older Tale', Date.now() - 30 * HOUR), studioProject('newest', 'Harbour Lights', Date.now() - 2 * HOUR)]} />);
    expect(screen.getByRole('region', { name: 'Continue Harbour Lights' })).toBeInTheDocument();
    const olderCard = screen.getByRole('heading', { level: 3, name: 'Older Tale' }).closest('.group') as HTMLElement;
    fireEvent.click(within(olderCard).getByRole('button', { name: 'Mark as featured' }));
    expect(within(olderCard).getByRole('button', { name: 'Unmark as featured' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Continue Harbour Lights' });
    expect(within(card).getByText('3 of 10 pages · edited 2 hours ago')).toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: /^Continue/ })).toHaveLength(1);
  });

  it('keeps the Continue comic through a rename of another comic, shows its own rename, and picks again when it is deleted', () => {
    const older = studioProject('older', 'Older Tale', Date.now() - 30 * HOUR);
    const newest = studioProject('newest', 'Harbour Lights', Date.now() - 2 * HOUR);
    const view = renderDashboard([older, newest], { comicWorkspace: true });
    const olderRenamed = { ...older, name: 'Older Tale, renamed', updatedAt: Date.now() };
    view.rerender(<ProjectDashboard {...view.props} projects={[olderRenamed, newest]} />);
    expect(screen.getByRole('region', { name: 'Continue Harbour Lights' })).toBeInTheDocument();
    view.rerender(<ProjectDashboard {...view.props} projects={[olderRenamed, { ...newest, name: 'Harbour Lights II' }]} />);
    expect(screen.getByRole('region', { name: 'Continue Harbour Lights II' })).toBeInTheDocument();
    view.rerender(<ProjectDashboard {...view.props} projects={[olderRenamed]} />);
    expect(screen.getByRole('region', { name: 'Continue Older Tale, renamed' })).toBeInTheDocument();
  });

  it('keeps the card while the list reloads, and picks again once it has loaded', () => {
    const older = studioProject('older', 'Older Tale', Date.now() - 30 * HOUR);
    const newest = studioProject('newest', 'Harbour Lights', Date.now() - 2 * HOUR);
    const view = renderDashboard([older, newest], { comicWorkspace: true });
    // Edited on another device: the reload brings the newer row.
    const editedElsewhere = { ...older, updatedAt: Date.now() - 60_000 };
    view.rerender(<ProjectDashboard {...view.props} projects={[editedElsewhere, newest]} projectsLoaded={false} />);
    expect(screen.getByRole('region', { name: 'Continue Harbour Lights' })).toBeInTheDocument();
    view.rerender(<ProjectDashboard {...view.props} projects={[editedElsewhere, newest]} projectsLoaded />);
    expect(screen.getByRole('region', { name: 'Continue Older Tale' })).toBeInTheDocument();
  });

  it('the idea form’s help line is HOME_START_HELP, the one copy Home reads too', () => {
    renderDashboard([], { comicWorkspace: true });
    expect(screen.getByLabelText('Your comic idea or script')).toHaveAccessibleDescription(HOME_START_HELP);
  });
});
