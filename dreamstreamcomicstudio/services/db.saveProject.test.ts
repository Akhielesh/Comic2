// P0-SEC: a Comic Studio (v4) projects upsert never carries is_public — visibility of v4
// comics is server-owned (studio Share sheet), and the database guard refuses client
// is_public changes on them. Classic projects keep sending it.
// EGRESS-DB E1: a comic listed as a card (a state subset) is never upserted over its full row,
// whatever object carries its id, until its full state has been loaded.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';
import { fakeSupabase } from './projectRows.testkit';

vi.mock('./supabase', async () => ({ supabase: (await import('./projectRows.testkit')).fakeSupabase.client }));

const { CardSaveRefusedError, isCardOnly, loadProjectState, loadProjects, saveProject } = await import('./db');

const sb = {
  get upserts() {
    return fakeSupabase.state.upserts.map((u) => u.row);
  }
};

const baseState = {
  step: 0,
  maxStepReached: 0,
  script: '',
  scenes: [],
  panels: [],
  characters: [],
  items: [],
  locations: [],
  styleVariants: [],
  stylePrompt: '',
  styleCategory: '',
  styleAspectRatio: '2:3',
  imageResolution: '2K',
  layoutType: 'classic'
} as unknown as ComicState;

const project = (state: Partial<ComicState> & Record<string, unknown>, isPublic: boolean): Project => ({
  id: 'p-1',
  name: 'Comic',
  createdAt: 1,
  updatedAt: 2,
  isPublic,
  state: { ...baseState, ...state } as ComicState
});

beforeEach(() => {
  fakeSupabase.reset();
});

describe('saveProject visibility', () => {
  it('omits is_public (and never stamps publishedAt) for a v4 studio row', async () => {
    await saveProject(project({ studioVersion: 4 }, true));
    expect(sb.upserts).toHaveLength(1);
    expect('is_public' in sb.upserts[0]).toBe(false);
    expect((sb.upserts[0].state as Record<string, unknown>).publishedAt).toBeUndefined();
  });

  it('keeps sending is_public for classic rows', async () => {
    await saveProject(project({}, true));
    expect(sb.upserts[0].is_public).toBe(true);
    await saveProject(project({}, false));
    expect(sb.upserts[1].is_public).toBe(false);
  });
});

describe('saveProject never writes a card over a full row (EGRESS-DB E1)', () => {
  const fullState = {
    ...baseState,
    script: 'The whole script',
    panels: [{ id: 'p1', imageId: 'user-1/p1.png' }],
    versions: [{ id: 'v1', state: { script: 'an older draft' } }]
  } as unknown as ComicState;

  beforeEach(() => {
    fakeSupabase.state.tables.projects = [
      {
        id: 'card-1',
        user_id: 'user-1',
        name: 'Listed',
        is_public: false,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-02T00:00:00.000Z',
        state: fullState
      }
    ];
  });

  it('refuses a listed card, and a state rebuilt from it, without any upsert', async () => {
    const [card] = await loadProjects();
    expect(isCardOnly('card-1')).toBe(true);
    await expect(saveProject(card)).rejects.toBeInstanceOf(CardSaveRefusedError);
    await expect(saveProject({ ...card, name: 'Renamed' })).rejects.toMatchObject({ code: 'CARD_ONLY', projectId: 'card-1' });
    // A brand-new state object (spread, edited, even "complete-looking") is still the card's: refused by id.
    const rebuilt = { ...card, state: { ...card.state, script: 'edited', panels: [...card.state.panels] } };
    await expect(saveProject(rebuilt)).rejects.toBeInstanceOf(CardSaveRefusedError);
    expect(sb.upserts).toHaveLength(0);
    // The stored row is untouched: versions and all.
    expect((fakeSupabase.state.tables.projects[0].state as Record<string, unknown>).versions).toEqual(fullState.versions);
  });

  it('saves once the full state is loaded, with the full state', async () => {
    const [card] = await loadProjects();
    const { state, updatedAt } = await loadProjectState('card-1');
    await saveProject({ ...card, state, updatedAt, name: 'Renamed' });
    expect(sb.upserts).toHaveLength(1);
    expect(sb.upserts[0]).toMatchObject({ id: 'card-1', name: 'Renamed' });
    expect((sb.upserts[0].state as Record<string, unknown>).versions).toEqual(fullState.versions);
    expect((sb.upserts[0].state as Record<string, unknown>).script).toBe('The whole script');
  });

  it('a reload flags the id card-only again', async () => {
    await loadProjects();
    await loadProjectState('card-1');
    expect(isCardOnly('card-1')).toBe(false);
    const [card] = await loadProjects();
    expect(isCardOnly('card-1')).toBe(true);
    await expect(saveProject(card)).rejects.toBeInstanceOf(CardSaveRefusedError);
    expect(sb.upserts).toHaveLength(0);
  });

  it('never refuses a project that was never listed (a new comic)', async () => {
    await saveProject({ ...project({}, false), id: 'brand-new' });
    expect(sb.upserts.map((r) => r.id)).toEqual(['brand-new']);
  });
});
