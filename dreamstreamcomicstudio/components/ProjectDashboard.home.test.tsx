import { fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(card.querySelector('[data-variant="create"], [data-variant="default"]')).toBeNull();
    expect(container.querySelectorAll('[data-variant="create"]')).toHaveLength(0);
  });
});
