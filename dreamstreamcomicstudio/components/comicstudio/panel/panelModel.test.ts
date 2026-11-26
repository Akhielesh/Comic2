import { describe, expect, it } from 'vitest';
import type { Project } from '../../../types';
import type { ComicActivityRow } from '../../../services/comicWorkspaceActivity';
import { comicActivityRow } from '../../../services/comicWorkspaceActivity';
import { STAGE_UNKNOWN, type StageFacts } from '../../../shared/comic/stage';
import { CLASSIC_LABEL, FINISHED_FRESH_MS, IN_PROGRESS_UNKNOWN, STALLED_LABEL, STALLED_MS, comicRowName, isFreshWork, panelComics } from './panelModel';

const NOW = Date.UTC(2026, 10, 26, 12);
const HOUR = 60 * 60 * 1000;

const drawing: StageFacts = { v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages: 12, planned: 12, drawn: 6, current: 6, outOfDate: 0, drawing: 6, withheld: 0, failed: 0, looks: 0, paused: false, next: 'watch_drawing' };
const planning: StageFacts = { v: 1, stage: 'plan', done: ['story', 'style'], pages: 6, planned: 4, drawn: 0, current: 0, outOfDate: 0, drawing: 0, withheld: 0, failed: 0, looks: 0, paused: false, next: 'plan_rest' };

const row = (id: string, extra: Partial<ComicActivityRow> = {}): ComicActivityRow => ({ v: 1, id, title: id, attention: null, working: false, finished: [], updatedAt: NOW - HOUR, ...extra });
const studioProject = (id: string, name: string, updatedAt: number): Project =>
  ({ id, name, createdAt: updatedAt - HOUR, updatedAt, state: { studioVersion: 4, studioPages: 0, studioRendered: 0 } }) as unknown as Project;
const classicProject = (id: string, name: string, updatedAt: number): Project => ({ id, name, createdAt: updatedAt - HOUR, updatedAt, state: {} }) as unknown as Project;

const groupsOf = (result: ReturnType<typeof panelComics>) => Object.fromEntries(result.groups.map((g) => [g.group, g.comics.map((c) => c.id)]));

describe('panelComics: grouping', () => {
  it('puts every comic in one group, the one that needs the person most: Needs you, In progress, Finished, Recent', () => {
    const rows = [
      row('needs', { attention: 'approval', working: true, finished: [{ kind: 'pages', at: NOW - HOUR, count: 2 }] }),
      row('working', { working: true, updatedAt: NOW - 60_000, stage: drawing, finished: [{ kind: 'pages', at: NOW - HOUR, count: 6 }] }),
      row('finished', { finished: [{ kind: 'cover', at: NOW - 2 * HOUR }] }),
      row('recent', { stage: planning })
    ];
    const result = panelComics({ projects: [], rows, now: NOW });
    expect(result.groups.map((g) => g.label)).toEqual(['Needs you', 'In progress', 'Finished', 'Recent']);
    expect(groupsOf(result)).toEqual({ needs: ['needs'], working: ['working'], finished: ['finished'], recent: ['recent'] });
    const [needs, working, finished, recent] = result.groups.map((g) => g.comics[0]);
    expect([needs.status, needs.task]).toEqual(['Review drawing estimate', 'conversation']);
    expect([working.status, working.task]).toEqual(['Drawing · 6 of 12 pages drawn', 'conversation']);
    expect([finished.status, finished.task]).toEqual(['Cover drawn', 'read']);
    expect([recent.status, recent.task]).toEqual(['Planning · 4 of 6 pages planned', undefined]);
  });

  it('lists a comic once when it is both in the project list and the activity, with the activity’s title', () => {
    const result = panelComics({ projects: [studioProject('a', 'Old name', NOW - 3 * HOUR)], rows: [row('a', { title: 'Night ferry', stage: planning })], now: NOW });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].comics.map((c) => c.title)).toEqual(['Night ferry']);
    // The listing's name stands in for a doc that never got a title.
    const untitled = panelComics({ projects: [studioProject('a', 'Harbour Lights', NOW)], rows: [row('a', { title: 'Untitled comic' })], now: NOW });
    expect(untitled.groups[0].comics[0].title).toBe('Harbour Lights');
  });

  it('names a stalled comic in progress, and one saved before stages, without a guess', () => {
    const rows = [row('quiet', { working: true, updatedAt: NOW - STALLED_MS - 1, stage: drawing }), row('old', { working: true, updatedAt: NOW - 1000 })];
    const working = panelComics({ projects: [], rows, now: NOW }).groups[0].comics;
    expect(working.map((c) => [c.id, c.status])).toEqual([
      ['old', IN_PROGRESS_UNKNOWN],
      ['quiet', STALLED_LABEL]
    ]);
  });
});

describe('panelComics: ordering', () => {
  it('orders Needs you and In progress by last update, Finished by finish time, Recent by last edit', () => {
    const rows = [
      row('n-old', { attention: 'plan', updatedAt: NOW - 5 * HOUR }),
      row('n-new', { attention: 'question', updatedAt: NOW - HOUR }),
      row('f-early', { finished: [{ kind: 'reply', at: NOW - 6 * HOUR }], updatedAt: NOW - 60_000 }),
      row('f-late', { finished: [{ kind: 'plan', at: NOW - 2 * HOUR }, { kind: 'reply', at: NOW - 9 * HOUR }], updatedAt: NOW - 8 * HOUR })
    ];
    const projects = [studioProject('r-old', 'Older', NOW - 9 * HOUR), classicProject('r-new', 'Newer', NOW - 2 * HOUR)];
    const result = panelComics({ projects, rows, now: NOW });
    expect(groupsOf(result)).toEqual({ needs: ['n-new', 'n-old'], finished: ['f-late', 'f-early'], recent: ['r-new', 'r-old'] });
    expect(result.groups[1].comics[0].status).toBe('Page plan ready');
  });

  it('shows five Recent comics and counts the rest, always keeping the open comic listed', () => {
    const projects = Array.from({ length: 8 }, (_, i) => studioProject(`p${i}`, `Comic ${i}`, NOW - i * HOUR));
    const plain = panelComics({ projects, rows: [], now: NOW });
    expect(groupsOf(plain).recent).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(plain.hiddenRecent).toBe(3);
    const open = panelComics({ projects, rows: [], now: NOW, current: { id: 'p7', title: 'Comic 7', facts: planning } });
    expect(groupsOf(open).recent).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p7']);
    expect(open.hiddenRecent).toBe(2);
  });

  it('the open comic reads its live stage and title, and is listed before the list has it', () => {
    const result = panelComics({ projects: [], rows: [row('c', { stage: planning })], now: NOW, current: { id: 'new', title: 'Just started', facts: drawing } });
    const open = result.groups[0].comics.find((c) => c.id === 'new')!;
    expect([open.title, open.status, open.studio]).toEqual(['Just started', 'Drawing · 6 of 12 pages drawn', true]);
    const same = panelComics({ projects: [], rows: [row('c', { stage: planning })], now: NOW, current: { id: 'c', title: 'c', facts: drawing } });
    expect(same.groups[0].comics[0].status).toBe('Drawing · 6 of 12 pages drawn');
  });
});

describe('panelComics: freshly finished, and older comics', () => {
  it('an older comic’s fallback page count (at 0) is never “Finished”; it reads “Open to see”', () => {
    const legacy = comicActivityRow({ project_id: 'legacy', title: 'Lantern', updated_at: new Date(NOW - 30 * HOUR).toISOString(), listing: { rendered: '4' } });
    expect(legacy.finished).toEqual([{ kind: 'pages', count: 4, at: 0 }]);
    const result = panelComics({ projects: [], rows: [legacy], now: NOW });
    expect(groupsOf(result)).toEqual({ recent: ['legacy'] });
    expect(result.groups[0].comics[0].status).toBe(STAGE_UNKNOWN);
    expect(result.groups[0].comics[0].fresh).toEqual([]);
  });

  it('finished work older than a week, or cleared by this viewer, is history: the comic is Recent', () => {
    const rows = [
      row('stale', { finished: [{ kind: 'pages', at: NOW - FINISHED_FRESH_MS - 1, count: 3 }], stage: drawing }),
      row('cleared', { finished: [{ kind: 'pages', at: NOW - HOUR, count: 3 }] }),
      row('newer', { finished: [{ kind: 'pages', at: NOW - HOUR, count: 4 }] })
    ];
    const isCleared = (id: string, work: { at: number; count?: number }) => (id === 'cleared' || id === 'newer') && work.at <= NOW - HOUR && (work.count ?? 0) <= 3;
    const result = panelComics({ projects: [], rows, now: NOW, isCleared });
    expect(groupsOf(result)).toEqual({ finished: ['newer'], recent: ['cleared', 'stale'] });
    expect(isFreshWork('x', { kind: 'reply', at: 0 }, NOW)).toBe(false);
    expect(isFreshWork('x', { kind: 'reply', at: Number.NaN }, NOW)).toBe(false);
    expect(isFreshWork('x', { kind: 'reply', at: NOW + 60_000 }, NOW)).toBe(true);
  });

  it('a studio comic without a readable stage reads “Open to see” once loaded, nothing before; a classic comic says so', () => {
    const projects = [studioProject('s', 'Studio comic', NOW), classicProject('k', 'Classic comic', NOW - HOUR)];
    const loading = panelComics({ projects, rows: null, now: NOW });
    expect(loading.groups[0].comics.map((c) => [c.id, c.status, c.studio])).toEqual([
      ['s', null, true],
      ['k', CLASSIC_LABEL, false]
    ]);
    const loaded = panelComics({ projects, rows: [], now: NOW });
    expect(loaded.groups[0].comics[0].status).toBe(STAGE_UNKNOWN);
    expect(panelComics({ projects: [], rows: [], now: NOW }).empty).toBe(true);
  });

  it('a kind of news a newer server writes still reads as words, never a blank line', () => {
    const rows = [row('a', { attention: 'later' as never }), row('b', { finished: [{ kind: 'later' as never, at: NOW - HOUR }] })];
    const result = panelComics({ projects: [], rows, now: NOW });
    expect(result.groups.map((g) => [g.group, g.comics[0].status])).toEqual([
      ['needs', STAGE_UNKNOWN],
      ['finished', 'Work finished']
    ]);
  });

  it('a row’s name carries its stage when the status is something else', () => {
    const [needs] = panelComics({ projects: [], rows: [row('a', { title: 'Salt Road', attention: 'approval', stage: drawing })], now: NOW }).groups[0].comics;
    expect(comicRowName(needs)).toBe('Salt Road · Review drawing estimate · Drawing · 6 of 12 pages drawn');
    const [recent] = panelComics({ projects: [], rows: [row('b', { title: 'Glass', stage: planning })], now: NOW }).groups[0].comics;
    expect(comicRowName(recent)).toBe('Glass · Planning · 4 of 6 pages planned');
  });
});
