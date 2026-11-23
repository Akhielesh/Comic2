import { describe, expect, it } from 'vitest';
import type { ComicState, Project } from '../../../types';
import { CONTINUE_WINDOW_MS, HOME_START_HELP, continueLine, coverCandidates, editedAgo, pickContinue } from './homeModel';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 19, 12);

const state = (patch: Record<string, unknown> = {}): ComicState => ({
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
  ...patch
}) as ComicState;

const studio = (id: string, updatedAt: number, patch: Record<string, unknown> = {}, row: Partial<Project> = {}): Project => ({
  id,
  name: `Comic ${id}`,
  createdAt: updatedAt - DAY,
  updatedAt,
  state: state({ studioVersion: 4, studioPages: 10, studioRendered: 3, ...patch }),
  ...row
});

const classic = (id: string, updatedAt: number): Project => ({
  id,
  name: `Classic ${id}`,
  createdAt: updatedAt - DAY,
  updatedAt,
  state: state({ pipelineMode: 'classic' })
});

describe('pickContinue', () => {
  it('never chooses a classic comic, even the newest one', () => {
    expect(pickContinue([classic('c1', NOW - HOUR)], NOW)).toBeNull();
    expect(pickContinue([classic('c1', NOW - HOUR), studio('s1', NOW - 2 * HOUR)], NOW)?.id).toBe('s1');
  });

  it('chooses the most recently edited studio comic without meta', () => {
    const projects = [studio('old', NOW - 3 * DAY), studio('new', NOW - HOUR), studio('mid', NOW - DAY)];
    expect(pickContinue(projects, NOW)?.id).toBe('new');
  });

  it('returns null when every studio comic is older than 14 days', () => {
    expect(pickContinue([studio('stale', NOW - CONTINUE_WINDOW_MS - HOUR)], NOW)).toBeNull();
    expect(pickContinue([studio('edge', NOW - CONTINUE_WINDOW_MS + HOUR)], NOW)?.id).toBe('edge');
    expect(pickContinue([], NOW)).toBeNull();
  });

  it('with meta, a comic waiting on the member beats a newer one that is drawing', () => {
    const projects = [studio('drawing', NOW - HOUR), studio('waiting', NOW - 2 * DAY), studio('newest', NOW - 60_000)];
    const meta = { drawing: { status: { phase: 'drawing' } }, waiting: { status: { phase: 'waiting' } } };
    expect(pickContinue(projects, NOW, meta)?.id).toBe('waiting');
  });

  it('with meta, attention beats drawing and drawing beats an idle newer comic', () => {
    const projects = [studio('idle', NOW - 60_000), studio('drawing', NOW - HOUR), studio('attention', NOW - 2 * HOUR)];
    expect(pickContinue(projects, NOW, new Map([['drawing', { status: { phase: 'drawing' } }], ['attention', { status: { phase: 'attention' } }]]))?.id).toBe('attention');
    expect(pickContinue(projects, NOW, { drawing: { status: { phase: 'drawing' } } })?.id).toBe('drawing');
    // Rows without a phase that needs the member fall back to the newest edit.
    expect(pickContinue(projects, NOW, { idle: { status: { phase: 'idle' } }, drawing: { status: {} } })?.id).toBe('idle');
  });

  it('a comic waiting on the member is offered even when it was last edited long ago; an idle stale one is not', () => {
    const stale = studio('stale', NOW - 40 * DAY);
    expect(pickContinue([stale], NOW, { stale: { status: { phase: 'waiting' } } })?.id).toBe('stale');
    expect(pickContinue([stale], NOW, { stale: { status: { phase: 'idle' } } })).toBeNull();
  });

  it('meta never promotes a classic comic', () => {
    expect(pickContinue([classic('c1', NOW - HOUR)], NOW, { c1: { status: { phase: 'waiting' } } })).toBeNull();
  });
});

describe('continueLine', () => {
  it('names partial progress and the time of the last edit', () => {
    expect(continueLine(studio('a', NOW - 2 * HOUR), NOW, 'en')).toBe('3 of 10 pages · edited 2 hours ago');
  });

  it('says when no pages are planned yet', () => {
    expect(continueLine(studio('a', NOW - 30 * HOUR, { studioPages: 0, studioRendered: 0 }), NOW, 'en')).toBe('No pages planned yet · edited yesterday');
  });

  it('says when every page is drawn', () => {
    expect(continueLine(studio('a', NOW - 5 * 60_000, { studioPages: 4, studioRendered: 4 }), NOW, 'en')).toBe('All 4 pages drawn · edited 5 minutes ago');
    expect(continueLine(studio('a', NOW - 5 * 60_000, { studioPages: 1, studioRendered: 1 }), NOW, 'en')).toBe('1 page drawn · edited 5 minutes ago');
  });

  it('says Published for a published comic', () => {
    expect(continueLine(studio('a', NOW - 3 * DAY, {}, { isPublic: true }), NOW, 'en')).toBe('Published · edited 3 days ago');
  });

  it('formats the relative time in the given locale and never crashes on an unknown one', () => {
    expect(continueLine(studio('a', NOW - 2 * HOUR), NOW, 'hi')).toContain('घंटे');
    expect(() => continueLine(studio('a', NOW - 2 * HOUR), NOW, 'not a locale!')).not.toThrow();
    expect(continueLine(studio('a', NOW - 2 * HOUR), NOW, 'not a locale!')).toBe('3 of 10 pages · edited 2 hours ago');
  });
});

describe('editedAgo', () => {
  it('uses the largest whole unit and never a future time', () => {
    expect(editedAgo(NOW - 10_000, NOW, 'en')).toBe('edited just now');
    expect(editedAgo(NOW + HOUR, NOW, 'en')).toBe('edited just now');
    expect(editedAgo(NOW - 59 * 60_000, NOW, 'en')).toBe('edited 59 minutes ago');
    expect(editedAgo(NOW - 9 * DAY, NOW, 'en')).toBe('edited last week');
    expect(editedAgo(NOW - 70 * DAY, NOW, 'en')).toBe('edited 2 months ago');
  });
});

describe('coverCandidates', () => {
  it('keeps the grid order: cover, first drawn panel, first Page Studio page, first style variant', () => {
    const project = studio('a', NOW, {
      coverImageUrl: 'https://cdn.test/cover.webp',
      panels: [{ id: 'p1' }, { id: 'p2', imageUrl: 'https://cdn.test/panel.webp' }],
      pageStudio: { pages: [{ id: 'g1', imageUrl: 'https://cdn.test/page.webp' }] },
      styleVariants: [{ id: 'v1', imageUrl: 'https://cdn.test/style.webp' }]
    });
    expect(coverCandidates(project)).toEqual(['https://cdn.test/cover.webp', 'https://cdn.test/panel.webp', 'https://cdn.test/page.webp', 'https://cdn.test/style.webp']);
    expect(coverCandidates(studio('b', NOW))).toEqual([]);
  });
});

describe('HOME_START_HELP', () => {
  it('explains the writing allowance and the drawing approval without a fixed price', () => {
    expect(HOME_START_HELP).toMatch(/writing allowance/i);
    expect(HOME_START_HELP).toMatch(/approve one drawing estimate/i);
    expect(HOME_START_HELP).toMatch(/private comic/i);
    expect(HOME_START_HELP).not.toMatch(/\$|¢/);
  });
});
