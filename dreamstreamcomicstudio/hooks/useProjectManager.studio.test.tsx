import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';

const db = vi.hoisted(() => ({
  loadProjects: vi.fn(),
  saveProject: vi.fn(),
  deleteProject: vi.fn(),
  getImageUrl: vi.fn(),
  saveImage: vi.fn(),
  createGenerationNotification: vi.fn()
}));

vi.mock('../services/db', () => db);
vi.mock('../services/generationManager', () => ({ startBackgroundGeneration: vi.fn(), cancelGeneration: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' }, loading: false }) }));

import { useProjectManager } from './useProjectManager';

const NOW = Date.UTC(2026, 9, 21);

/** The listing state the server mirrors onto a v4 projects row (store.ts buildLegacyProjectState). */
const studioRow = (): Project => ({
  id: 'studio-1',
  name: 'Spice Market',
  createdAt: NOW,
  updatedAt: NOW,
  state: {
    studioVersion: 4,
    pipelineMode: 'classic',
    step: 0,
    maxStepReached: 0,
    script: '',
    scenes: [],
    panels: [],
    characters: [],
    items: [],
    locations: [],
    styleVariants: [],
    stylePrompt: 'ink wash',
    styleCategory: 'Ink',
    styleAspectRatio: '2:3',
    imageResolution: '2K',
    layoutType: 'classic',
    overview: 'Rivals cook.',
    studioPages: 6,
    studioRendered: 2,
    coverImageId: 'u/user-1/p/studio-1/img/page1.webp'
  } as unknown as ComicState
});

const classicRow = (): Project => ({
  id: 'classic-1',
  name: 'Old Wizard Comic',
  createdAt: NOW,
  updatedAt: NOW,
  state: {
    step: 0,
    maxStepReached: 0,
    script: 'Once upon a time.',
    scenes: [],
    panels: [],
    characters: [],
    items: [],
    locations: [],
    styleVariants: [],
    stylePrompt: '',
    styleCategory: '',
    styleAspectRatio: '1:1',
    imageResolution: '1K',
    layoutType: 'grid'
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  db.loadProjects.mockResolvedValue([studioRow(), classicRow()]);
  db.saveProject.mockResolvedValue(undefined);
  db.deleteProject.mockResolvedValue(undefined);
  db.getImageUrl.mockImplementation(async (path: string) => `https://signed.example/${path}`);
});

const loaded = async () => {
  const hook = renderHook(() => useProjectManager());
  await waitFor(() => expect(hook.result.current.projectsLoaded).toBe(true));
  await waitFor(() => expect(hook.result.current.projects).toHaveLength(2));
  return hook;
};

describe('useProjectManager — Comic Studio v4 rows', () => {
  it('signs only the cover thumbnail and never rewrites the server-mirrored state on load', async () => {
    const { result } = await loaded();
    const studio = result.current.projects.find((p) => p.id === 'studio-1')!;

    expect(studio.state.coverImageUrl).toBe('https://signed.example/u/user-1/p/studio-1/img/page1.webp');
    expect(db.getImageUrl).toHaveBeenCalledWith('u/user-1/p/studio-1/img/page1.webp', expect.objectContaining({ transform: expect.any(Object) }));
    // Untouched mirror: no classic flow migration fields were grafted on.
    const state = studio.state as unknown as Record<string, unknown>;
    expect(state.studioVersion).toBe(4);
    expect(state.studioRendered).toBe(2);
    expect(state.agentRun).toBeUndefined();
    expect(state.flowVersion).toBeUndefined();
    expect(state.layoutType).toBe('classic');

    // The classic row still migrates (and saves its repaired state) as before; the v4 row is never saved.
    await waitFor(() => expect(db.saveProject).toHaveBeenCalled());
    expect(db.saveProject.mock.calls.map(([p]) => (p as Project).id)).not.toContain('studio-1');
  });

  it('keeps a studio row listed when its cover cannot be signed', async () => {
    db.getImageUrl.mockImplementation(async (path: string) => {
      if (path.includes('/p/studio-1/')) throw new Error('offline');
      return `https://signed.example/${path}`;
    });
    const { result } = await loaded();
    const studio = result.current.projects.find((p) => p.id === 'studio-1')!;
    expect(studio.state.coverImageUrl).toBeUndefined();
  });

  it('skips the heavy asset hydration for studio rows', async () => {
    const { result } = await loaded();
    db.getImageUrl.mockClear();
    let hydrated: Project | undefined;
    await act(async () => {
      hydrated = await result.current.hydrateProjectAssets('studio-1');
    });
    expect(hydrated?.id).toBe('studio-1');
    expect(db.getImageUrl).not.toHaveBeenCalled();
    expect(db.saveProject.mock.calls.map(([p]) => (p as Project).id)).not.toContain('studio-1');
  });

  it('refuses to duplicate a studio comic (its document lives server-side)', async () => {
    const { result } = await loaded();
    act(() => result.current.duplicateProject('studio-1'));
    expect(result.current.projects).toHaveLength(2);

    act(() => result.current.duplicateProject('classic-1'));
    expect(result.current.projects).toHaveLength(3);
    expect(result.current.projects[0].name).toBe('Old Wizard Comic (Copy)');
  });

  it('deletes studio comics like any project row (comic_docs cascades server-side)', async () => {
    const { result } = await loaded();
    act(() => result.current.deleteProject('studio-1'));
    expect(result.current.projects.map((p) => p.id)).toEqual(['classic-1']);
    expect(db.deleteProject).toHaveBeenCalledWith('studio-1');
  });
});
