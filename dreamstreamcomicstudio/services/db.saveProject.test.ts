// P0-SEC: a Comic Studio (v4) projects upsert never carries is_public — visibility of v4
// comics is server-owned (studio Share sheet), and the database guard refuses client
// is_public changes on them. Classic projects keep sending it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';

const sb = vi.hoisted(() => ({ upserts: [] as Record<string, unknown>[] }));

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        sb.upserts.push(row);
        return { error: null };
      }
    })
  }
}));

const { saveProject } = await import('./db');

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
  sb.upserts = [];
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
