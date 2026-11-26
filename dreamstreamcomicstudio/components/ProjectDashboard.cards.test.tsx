/**
 * My comics, rebuilt (SH-B), the page: every card's stage from ONE read of the saved summaries (never a full comic, never
 * a request per card), comics that need the person first, the next step as a deep link, the filters kept (and the
 * studio's stages added to Step), 150 comics in pages of 24, the empty state's one wash, and a read made when the view
 * opens or the list reloads, never on a timer. Synthetic comics only.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';
import type { StageFacts } from '../shared/comic/stage';

vi.mock('./comicstudio/studioApi', () => ({ streamStudio: vi.fn() }));
vi.mock('./DataRescue', () => ({ DataRescue: () => null }));
vi.mock('./ReadinessChecklist', () => ({ ReadinessChecklist: () => null }));
vi.mock('./common/SmartImage', () => ({
  SmartImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} />
}));
vi.mock('./modals/ProjectInfoModal', () => ({ ProjectInfoModal: () => null }));
vi.mock('../services/supabase', async () => ({ supabase: (await import('../services/projectRows.testkit')).fakeSupabase.client, isStoredSession: () => true }));

import { ProjectDashboard } from './ProjectDashboard';
import { fakeSupabase } from '../services/projectRows.testkit';
import { STAGE_SELECT, type ComicStageRow } from '../services/comicWorkspaceActivity';
import { ComicStagesSource, type ComicStagesLoader } from './comicstudio/home/useComicStages';
import { consumeTaskTarget } from './comicstudio/home/workspaceTaskTarget';
import { WASH_EMPTY } from './chat/studioDesign';
import { clearOtherComicIdeaDrafts } from './comicstudio/comicIdeaDraft';

const HOUR = 3_600_000;
const ACCOUNT = 'user-1';

const baseState = (patch: Record<string, unknown> = {}): ComicState =>
  ({
    step: 0, maxStepReached: 0, script: '', scenes: [], styleVariants: [], stylePrompt: '', styleCategory: '', styleAspectRatio: '2:3',
    imageResolution: '2K', characters: [], items: [], locations: [], layoutType: 'grid', panels: [], ...patch
  }) as ComicState;
const studio = (id: string, name: string, ageHours: number, pages = 12, drawn = 6): Project => {
  const updatedAt = Date.now() - ageHours * HOUR;
  return { id, name, createdAt: updatedAt - 24 * HOUR, updatedAt, state: baseState({ studioVersion: 4, studioPages: pages, studioRendered: drawn }) };
};
const draw = (pages: number, drawn: number, next: StageFacts['next'] = 'draw_rest'): StageFacts => ({
  v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages, planned: pages, drawn, current: drawn, outOfDate: 0, drawing: 0, withheld: 0, failed: 0, looks: 0, paused: false, next
});
const docRow = (id: string, ageHours: number, activity: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  project_id: id,
  user_id: ACCOUNT,
  updated_at: new Date(Date.now() - ageHours * HOUR).toISOString(),
  doc: { brief: { title: id, premise: 'A long, private premise the list never reads.' }, conversation: [{ role: 'user', text: 'private words' }], ...(activity ? { workspaceActivity: activity } : {}), ...extra }
});

const renderDashboard = (projects: Project[], overrides: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}, loader?: ComicStagesLoader) => {
  const props = {
    projects,
    accountId: ACCOUNT,
    onCreateProject: vi.fn(),
    onOpenProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onDuplicateProject: vi.fn(),
    onReadProject: vi.fn(),
    onUpdateProject: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides
  };
  const ui = (p: typeof props) => (loader ? <ComicStagesSource.Provider value={loader}><ProjectDashboard {...p} /></ComicStagesSource.Provider> : <ProjectDashboard {...p} />);
  const utils = render(ui(props));
  return { ...utils, props, rerenderWith: (next: Partial<typeof props>) => utils.rerender(ui({ ...props, ...next })) };
};

/** The grid's titles in order (a plain selector: role queries over 150 cards are slow in jsdom, not in a browser). */
const gridTitles = () => [...document.querySelectorAll('ul[aria-label="Your comics"] > li article h3')].map((h) => h.textContent);
const showMore = () => document.querySelector<HTMLButtonElement>('button[data-show-more]');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  fakeSupabase.reset();
  sessionStorage.clear();
  clearOtherComicIdeaDrafts(ACCOUNT);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('My comics: one stage read, Needs you first', () => {
  it('reads every stage in one narrow request, holds the grid briefly, then shows the cards with what needs you first', async () => {
    fakeSupabase.state.tables.comic_docs = [
      docRow('newest', 1, { v: 1, attention: null, working: false, finished: [], stage: draw(12, 6) }),
      docRow('waiting', 30, { v: 1, attention: 'approval', working: false, finished: [], stage: draw(12, 6, 'review_estimate') }),
      // Saved before summaries existed, with an approval open: still first, from the activity data.
      docRow('older-waiting', 50, null, { gate: { status: 'open' } }),
      docRow('middle', 10, { v: 1, attention: null, working: false, finished: [] })
    ];
    renderDashboard([studio('newest', 'Newest', 1), studio('middle', 'Middle', 10), studio('waiting', 'Waiting', 30), studio('older-waiting', 'Older Waiting', 50)]);
    // Placeholders of the same footprint while the read runs: the cards then land in their final order.
    expect(screen.getByRole('list', { name: 'Your comics, loading' })).toHaveAttribute('aria-busy', 'true');
    await screen.findByRole('list', { name: 'Your comics' });
    expect(gridTitles()).toEqual(['Waiting', 'Older Waiting', 'Newest', 'Middle']);

    const queries = fakeSupabase.queriesOn('comic_docs');
    expect(queries).toHaveLength(1);
    expect(queries[0].columns).toBe(STAGE_SELECT);
    expect(queries[0].filters).toEqual(expect.arrayContaining(['user_id=eq.user-1', 'order=updated_at.desc']));

    const waiting = screen.getByRole('article', { name: 'Waiting' });
    expect(within(waiting).getByText('Needs you')).toBeInTheDocument();
    expect(within(waiting).getByText('Drawing')).toBeInTheDocument();
    expect(within(waiting).getByRole('link', { name: 'Next: review the estimate, Waiting' })).toBeInTheDocument();
    const older = screen.getByRole('article', { name: 'Older Waiting' });
    expect(within(older).getByText('Open to see')).toBeInTheDocument();
    expect(within(older).getByText('Needs you')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Middle' })).getByText('Open to see')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Newest' })).queryByText('Needs you')).toBeNull();
  });

  it('an explicit sort is exactly that; the default puts Needs you first again', async () => {
    const loader: ComicStagesLoader = async () => new Map([['b', { id: 'b', attention: 'question', working: false }]]);
    renderDashboard([studio('a', 'Alpha', 1), studio('b', 'Bravo', 5), studio('c', 'Charlie', 3)], {}, loader);
    await screen.findByRole('list', { name: 'Your comics' });
    expect(gridTitles()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), { target: { value: 'za' } });
    expect(gridTitles()).toEqual(['Charlie', 'Bravo', 'Alpha']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort by' }), { target: { value: 'updated' } });
    expect(gridTitles()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(screen.getByRole('option', { name: 'Needs you, then recent' })).toBeInTheDocument();
  });

  it('a failed read leaves every card working: row counts, "Open to see", recency order', async () => {
    fakeSupabase.state.failures.push({ when: (q) => q.table === 'comic_docs', error: { code: '42501' } });
    renderDashboard([studio('a', 'Alpha', 5), studio('b', 'Bravo', 1)]);
    await screen.findByRole('list', { name: 'Your comics' });
    expect(gridTitles()).toEqual(['Bravo', 'Alpha']);
    expect(within(screen.getByRole('article', { name: 'Alpha' })).getByText('Open to see')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Alpha' })).getByText(/^6 of 12 pages drawn · /)).toBeInTheDocument();
  });

  it('the next step deep-links: the studio opens at that place, and nothing else happens', async () => {
    const loader: ComicStagesLoader = async () => new Map([['a', { id: 'a', stage: draw(12, 6), attention: null, working: false }]]);
    const { props } = renderDashboard([studio('a', 'Alpha', 1)], {}, loader);
    await screen.findByRole('list', { name: 'Your comics' });
    fireEvent.click(within(screen.getByRole('article', { name: 'Alpha' })).getByRole('link', { name: 'Next: draw the rest, Alpha' }));
    expect(props.onOpenProject).toHaveBeenCalledExactlyOnceWith('a');
    expect(consumeTaskTarget(ACCOUNT, 'a')).toBe('pages');
    expect(props.onUpdateProject).not.toHaveBeenCalled();
    expect(props.onReadProject).not.toHaveBeenCalled();
  });

  it('the Step filter takes the studio’s stages from the saved summary; a comic without one matches none', async () => {
    const ready: StageFacts = { ...draw(4, 4, 'publish'), stage: 'publish', done: ['story', 'style', 'plan', 'draw'] };
    const loader: ComicStagesLoader = async () => new Map([
      ['a', { id: 'a', stage: draw(12, 6), attention: null, working: false }],
      ['b', { id: 'b', stage: ready, attention: null, working: false }]
    ]);
    renderDashboard([studio('a', 'Alpha', 1), studio('b', 'Bravo', 2), studio('c', 'Charlie', 3)], {}, loader);
    await screen.findByRole('list', { name: 'Your comics' });
    fireEvent.click(screen.getByRole('button', { name: /More Filters/ }));
    const step = screen.getByRole('combobox', { name: 'Step' });
    fireEvent.change(step, { target: { value: 'stage:draw' } });
    expect(gridTitles()).toEqual(['Alpha']);
    fireEvent.change(step, { target: { value: 'stage:publish' } });
    expect(gridTitles()).toEqual(['Bravo']);
    fireEvent.change(step, { target: { value: 'stage:story' } });
    expect(screen.getByRole('status')).toHaveTextContent('No comics match');
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(gridTitles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});

describe('My comics: 150 comics', () => {
  it('one stage read for all of them, 24 cards at a time, and no request per card', async () => {
    const projects = Array.from({ length: 150 }, (_, i) => studio(`c${i}`, `Comic ${String(i).padStart(3, '0')}`, i + 1));
    fakeSupabase.state.tables.comic_docs = projects.map((p, i) => docRow(p.id, i + 1, { v: 1, attention: i === 120 ? 'plan' : null, working: false, finished: [], stage: draw(12, 6) }));
    renderDashboard(projects);
    await screen.findByRole('list', { name: 'Your comics' });
    expect(gridTitles()).toHaveLength(24);
    // The one comic that needs the person, from the far end of the list, is first.
    expect(gridTitles()[0]).toBe('Comic 120');
    expect(showMore()).toHaveAccessibleName('Show more comics, 126 more');
    for (let shown = 24; shown < 150; shown += 24) fireEvent.click(showMore()!);
    expect(gridTitles()).toHaveLength(150);
    expect(showMore()).toBeNull();
    expect(fakeSupabase.queriesOn('comic_docs')).toHaveLength(1);
    expect(fakeSupabase.queriesOn('projects')).toHaveLength(0);
    // Only the first row's covers load at once.
    expect(document.querySelectorAll('[data-slot="my-comic-cover"] img[loading="eager"]').length).toBeLessThanOrEqual(3);
  });

  it('a star on one card re-renders that card alone', async () => {
    const projects = Array.from({ length: 30 }, (_, i) => studio(`c${i}`, `Comic ${i}`, i + 1));
    const loader: ComicStagesLoader = async () => new Map();
    const { rerenderWith } = renderDashboard(projects, {}, loader);
    await screen.findByRole('list', { name: 'Your comics' });
    const before = screen.getAllByRole('article');
    const statuses = before.map((card) => card.querySelector('[data-slot="card-status"]'));
    const starred = projects.map((p, i) => (i === 3 ? { ...p, state: { ...p.state, isFeatured: true } } : p));
    rerenderWith({ projects: starred });
    expect(within(screen.getByRole('article', { name: 'Comic 3' })).getByRole('img', { name: 'Featured' })).toBeInTheDocument();
    // The same DOM nodes for every other card (memoised: React kept them as they were).
    screen.getAllByRole('article').forEach((card, i) => expect(card.querySelector('[data-slot="card-status"]')).toBe(statuses[i]));
  });
});

describe('My comics: when the stage read runs', () => {
  it('when the view opens and when the list reloads; never on a timer', async () => {
    vi.useFakeTimers();
    const loader = vi.fn<ComicStagesLoader>(async () => new Map());
    const { rerenderWith } = renderDashboard([studio('a', 'Alpha', 1)], {}, loader);
    await act(async () => void (await Promise.resolve()));
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(30 * 60_000));
    expect(loader).toHaveBeenCalledTimes(1);
    rerenderWith({ projectsLoaded: false });
    await act(async () => void (await Promise.resolve()));
    expect(loader).toHaveBeenCalledTimes(2);
    rerenderWith({ projectsLoaded: true });
    await act(async () => void vi.advanceTimersByTime(30 * 60_000));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('a slow read stops holding the grid after a moment; its answer still lands', async () => {
    vi.useFakeTimers();
    let answer!: (rows: ReadonlyMap<string, ComicStageRow>) => void;
    const loader: ComicStagesLoader = () => new Promise((resolve) => (answer = resolve));
    renderDashboard([studio('a', 'Alpha', 1)], {}, loader);
    expect(screen.getByRole('list', { name: 'Your comics, loading' })).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(1300));
    expect(screen.getByRole('list', { name: 'Your comics' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Alpha' }).querySelector('[data-slot="stage-line"] [data-slot="skeleton"]')).not.toBeNull();
    await act(async () => {
      answer(new Map());
      await Promise.resolve();
    });
    expect(within(screen.getByRole('article', { name: 'Alpha' })).getByText('Open to see')).toBeInTheDocument();
  });
});

describe('My comics: empty', () => {
  it('no comics yet: the empty state warms the page with its one wash, and Create a new comic opens the form', () => {
    const { container } = renderDashboard([], { accountId: undefined });
    const empty = screen.getByRole('region', { name: 'No comics yet' });
    expect(empty.className).toContain(WASH_EMPTY);
    expect(container.querySelectorAll('[class*="--ds-wash-"]')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'No comics yet' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create a new comic' }));
    expect(screen.getByLabelText('Comic Title')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'No comics yet' })).toBeNull();
  });

  it('nothing matching is a working view: no wash, and Reset filters brings every comic back', async () => {
    const { container } = renderDashboard([studio('a', 'Alpha', 1)], { accountId: undefined });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), { target: { value: 'zzz' } });
    expect(screen.getByRole('status')).toHaveTextContent('No comics match');
    expect(container.querySelectorAll('[class*="--ds-wash-"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(gridTitles()).toEqual(['Alpha']);
  });
});
