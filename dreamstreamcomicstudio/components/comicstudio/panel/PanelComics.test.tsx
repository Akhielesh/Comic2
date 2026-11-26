// @vitest-environment jsdom
// "Your comics" (the merged AI activity): the old feed's behaviour, carried over (task targets, Clear finished across a
// reload, last results kept on a failure, offline and reconnect, a previous owner's late response dropped), plus when
// it fetches: on opening, after a run settles, on focus after a while, never on a timer.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelComics } from './PanelComics';
import { consumeTaskTarget, WORK_CHANGED_EVENT } from '../home/workspaceTaskTarget';
import { comicActivityRow, loadComicActivity, type ComicActivityRow } from '../../../services/comicWorkspaceActivity';
import { FOCUS_REFRESH_MS, resetPanelActivityForTests } from './usePanelActivity';
import type { StageFacts } from '../../../shared/comic/stage';

vi.mock('../../../services/comicWorkspaceActivity', async (original) => ({ ...(await original<typeof import('../../../services/comicWorkspaceActivity')>()), loadComicActivity: vi.fn() }));
const load = vi.mocked(loadComicActivity);

const recently = () => Date.now() - 60 * 60 * 1000;
const row = (id: string, title: string, extra: Partial<ComicActivityRow> = {}): ComicActivityRow => ({ v: 1, id, title, working: false, attention: null, finished: [], updatedAt: recently(), ...extra });
const result = (rows: ComicActivityRow[], hasMore = false) => ({ rows, hasMore, next: 25 });
const mount = (account: string, onOpen = vi.fn()) => (
  <PanelComics key={account} accountId={account} projects={[]} onOpenStudio={onOpen} onOpenProject={vi.fn()} onAllComics={vi.fn()} />
);
const link = (name: RegExp | string) => screen.findByRole('link', { name });
const group = (label: string) => screen.getByRole('list', { name: label });

beforeEach(() => {
  localStorage.clear();
  load.mockReset();
  resetPanelActivityForTests();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Your comics: opening, clearing', () => {
  it('opens a finished comic at its pages and a waiting estimate in the conversation, without approving anything', async () => {
    load.mockResolvedValue(result([row('c1', 'Night ferry', { attention: 'approval' }), row('c2', 'Salt Road', { finished: [{ kind: 'pages', at: recently(), count: 2 }] })]));
    const open = vi.fn();
    render(mount('owner', open));
    const pages = await link(/^Salt Road · 2 pages drawn/);
    expect(within(group('Finished')).getByRole('link')).toBe(pages);
    expect(pages.getAttribute('href')).toContain('task=pages');
    fireEvent.click(pages);
    expect(open).toHaveBeenCalledWith('c2');
    expect(consumeTaskTarget('owner', 'c2')).toBe('pages');
    const estimate = await link(/^Night ferry · Review drawing estimate/);
    expect(within(group('Needs you')).getByRole('link')).toBe(estimate);
    fireEvent.click(estimate);
    expect(consumeTaskTarget('owner', 'c1')).toBe('conversation');
  });

  it('Clear finished moves the comics to Recent and survives a reload; newer work brings one back', async () => {
    const finished = [{ kind: 'pages' as const, at: recently(), count: 2 }];
    load.mockResolvedValue(result([row('c2', 'Salt Road', { finished })]));
    const first = render(mount('owner'));
    await link(/^Salt Road · 2 pages drawn/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }));
    expect(screen.queryByRole('list', { name: 'Finished' })).toBeNull();
    expect(within(group('Recent')).getByRole('link', { name: /^Salt Road · Open to see/ })).toBeInTheDocument();
    first.unmount();
    resetPanelActivityForTests();
    render(mount('owner'));
    await link(/^Salt Road · Open to see/);
    expect(screen.queryByRole('list', { name: 'Finished' })).toBeNull();
    load.mockResolvedValue(result([row('c2', 'Salt Road', { finished: [{ kind: 'pages', at: Date.now() - 1000, count: 2 }] })]));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh your comics' }));
    expect(await link(/^Salt Road · 2 pages drawn/)).toBeInTheDocument();
  });

  it('an older comic whose saved count has no time is never shown as freshly finished', async () => {
    const legacy = comicActivityRow({ project_id: 'old', title: 'Lantern', updated_at: new Date(recently()).toISOString(), listing: { rendered: '4' } });
    load.mockResolvedValue(result([legacy]));
    render(mount('owner'));
    expect(await link(/^Lantern · Open to see/)).toBeInTheDocument();
    expect(within(group('Recent')).getByRole('link', { name: /^Lantern/ })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Finished' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear finished' })).toBeNull();
  });

  it('says where a comic in progress stands from its saved stage, and stays plain for one saved before stages', async () => {
    const stage: StageFacts = { v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages: 12, planned: 12, drawn: 6, current: 6, outOfDate: 0, drawing: 6, withheld: 0, failed: 0, looks: 0, paused: false, next: 'watch_drawing' };
    load.mockResolvedValue(result([row('c1', 'Night ferry', { working: true, stage, updatedAt: Date.now() }), row('c2', 'Old comic', { working: true, updatedAt: Date.now() })]));
    render(mount('owner'));
    expect(await link('Night ferry · Drawing · 6 of 12 pages drawn')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Old comic · Last reported in progress' })).toBeInTheDocument();
    // The five stage marks are drawn for the comic whose stage reads, in ink, and hidden from screen readers.
    const marks = screen.getByRole('link', { name: /^Night ferry/ }).querySelector('[data-stage-marks]')!;
    expect(marks.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(marks.querySelectorAll('[data-stage-mark]')).map((m) => m.getAttribute('data-stage-mark'))).toEqual(['done', 'done', 'done', 'current', 'upcoming']);
    expect(screen.getByRole('link', { name: /^Old comic/ }).querySelector('[data-stage-marks]')).toBeNull();
  });
});

describe('Your comics: loading', () => {
  it('keeps last checked results on failure, recovers on reconnect and never shows a previous owner’s late response', async () => {
    load.mockResolvedValueOnce(result([row('c1', 'Private A', { stage: undefined })])).mockRejectedValueOnce(new Error('network'));
    const view = render(mount('A'));
    await link(/^Private A/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh your comics' }));
    expect(await screen.findByText(/^Couldn’t refresh · Last checked /)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Private A/ })).toBeInTheDocument();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    fireEvent(window, new Event('offline'));
    expect(await screen.findByText(/^Offline/)).toBeInTheDocument();
    let late!: (value: ReturnType<typeof result>) => void;
    load.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(late).toBeTypeOf('function'));
    load.mockResolvedValueOnce(result([row('c9', 'Private B')]));
    view.rerender(mount('B'));
    await link(/^Private B/);
    await act(async () => late(result([row('c1', 'Private A')])));
    expect(screen.queryByText('Private A')).toBeNull();
  });

  it('fetches when it opens, after a run settles and on focus after a while', async () => {
    load.mockResolvedValue(result([row('c1', 'Night ferry')]));
    render(mount('owner'));
    await link(/^Night ferry/);
    expect(load).toHaveBeenCalledTimes(1);
    // Focus right away does not fetch again.
    fireEvent(window, new Event('focus'));
    expect(load).toHaveBeenCalledTimes(1);
    // A run settling in this tab (for this account) does, shortly after.
    fireEvent(window, new CustomEvent(WORK_CHANGED_EVENT, { detail: { accountId: 'someone-else' } }));
    fireEvent(window, new CustomEvent(WORK_CHANGED_EVENT, { detail: { accountId: 'owner' } }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    // Coming back after FOCUS_REFRESH_MS does too.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + FOCUS_REFRESH_MS + 1);
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  });

  it('never fetches on a timer: no interval anywhere in the panel (the backend and the database stay idle)', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(sources).toEqual(expect.arrayContaining(['usePanelActivity.ts', 'PanelComics.tsx', 'ComicSidePanel.tsx']));
    for (const file of sources) expect(readFileSync(path.join(dir, file), 'utf8'), file).not.toMatch(/setInterval|requestAnimationFrame/);
  });

  it('shows the last rows at once when it opens again, without fetching while they are fresh; Check older comics adds the next page', async () => {
    load.mockResolvedValueOnce(result([row('c1', 'Night ferry')], true));
    const first = render(mount('owner'));
    await link(/^Night ferry/);
    first.unmount();
    render(mount('owner'));
    expect(screen.getByRole('link', { name: /^Night ferry/ })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    load.mockResolvedValueOnce(result([row('c2', 'Salt Road', { updatedAt: recently() - 1000 })]));
    fireEvent.click(screen.getByRole('button', { name: 'Check older comics' }));
    await link(/^Salt Road/);
    expect(load).toHaveBeenLastCalledWith('owner', 25, expect.any(AbortSignal));
    expect(screen.getByRole('link', { name: /^Night ferry/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check older comics' })).toBeNull();
  });

  it('without an account it lists the project list alone, and says so when there is nothing yet', () => {
    render(<PanelComics projects={[]} onOpenStudio={vi.fn()} onOpenProject={vi.fn()} />);
    expect(screen.getByText('Your comics will appear here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh your comics' })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
