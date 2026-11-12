import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStep, ComicState } from '../types';
import { fakeSupabase } from '../services/projectRows.testkit';

vi.mock('../services/supabase', async () => ({ supabase: (await import('../services/projectRows.testkit')).fakeSupabase.client }));
vi.mock('../services/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/db')>()),
  getImageUrl: vi.fn(async (id: string, options?: { transform?: unknown }) => `https://signed.test/${id}${options?.transform ? '?thumb' : ''}`),
  createGenerationNotification: vi.fn(async () => undefined)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' }, loading: false }) }));
vi.mock('../services/generationManager', () => ({ startBackgroundGeneration: vi.fn(), cancelGeneration: vi.fn() }));

const { migrateComicStateForFlow, useProjectManager, STATE_LOAD_FAILED_SAVE } = await import('./useProjectManager');
const { isCardOnly } = await import('../services/db');
const generation = await import('../services/generationManager');

const makeState = (overrides?: Partial<ComicState>): ComicState => ({
  step: 1,
  maxStepReached: 6,
  flowVersion: 3,
  script: 'Scene 1: SALTY and PIP enter the tunnel.',
  scenes: [
    {
      id: 1,
      rawText: 'SALTY and PIP enter the tunnel.',
      synopsis: 'SALTY and PIP enter the tunnel.',
      characters: ['SALTY', 'PIP'],
      setting: 'Tunnel'
    }
  ],
  continuitySummary: '',
  continuity: undefined,
  overview: '',
  comments: [],
  isFeatured: false,
  coverPrompt: '',
  styleVariants: [],
  stylePrompt: '',
  styleCategory: '',
  styleAspectRatio: '1:1',
  imageResolution: '1K',
  characters: [],
  items: [],
  locations: [],
  layoutType: 'grid',
  panels: [],
  textLayout: 'caption',
  pricingConfig: undefined,
  ...overrides
});

describe('flow migration v4', () => {
  it('migrates legacy projects without gating them on the removed planning stage', () => {
    const migrated = migrateComicStateForFlow(makeState());

    expect(migrated.flowVersion).toBe(4);
    // flow v3 step 1 (old STYLE position) shifts +1 to the current STYLE_SELECTION —
    // and is never parked on the retired STORY_PLANNING stage.
    expect(migrated.step).toBe(AppStep.STYLE_SELECTION);
    expect(migrated.maxStepReached).toBeGreaterThanOrEqual(AppStep.STYLE_SELECTION);
    expect(migrated.step).not.toBe(AppStep.STORY_PLANNING);
    expect(migrated.storyPlanning).toBeDefined();
  });

  it('allows migrated projects with approved planning to continue', () => {
    const migrated = migrateComicStateForFlow(makeState({
      storyPlanning: {
        formFactor: 'us_comic',
        recommendedRange: { min: 6, max: 10 },
        userRange: { min: 6, max: 10 },
        recommendedPageCount: 8,
        approvedPageCount: 8,
        feasibility: {
          status: 'ok',
          reason: 'Valid range.',
          estimatedPanels: { min: 24, max: 60 }
        },
        estimatedCostRange: { currency: 'USD', minUsd: 1.1, maxUsd: 2.8 },
        approved: true,
        approvedAt: Date.now(),
        resumeStep: AppStep.STYLE_SELECTION
      }
    }));

    expect(migrated.step).toBe(AppStep.STYLE_SELECTION);
    expect(migrated.maxStepReached).toBeGreaterThanOrEqual(AppStep.STYLE_SELECTION);
  });
});

// EGRESS-DB E1: the library holds cards; a comic's full state loads when it is opened, changed, duplicated or
// generated, and a card is never saved over the full row.
describe('useProjectManager with library cards', () => {
  const VERSIONS = [{ id: 'v1', state: { script: 'an older draft' } }];
  const classicState = {
    pipelineMode: 'classic',
    flowVersion: 4,
    step: 6,
    maxStepReached: 7,
    script: 'The whole script',
    scenes: [{ id: 1, rawText: 'x', synopsis: 'x', characters: [], setting: 'x' }],
    overview: '',
    comments: [],
    isFeatured: false,
    panels: [{ id: 'p1', imageId: 'user-1/p1.png' }],
    styleVariants: [{ id: 's1', imageId: 'user-1/style.png', prompt: 'ink', category: 'noir', aspectRatio: '2:3', resolution: '2K' }],
    characters: [{ id: 'c1', name: 'Salty', description: 'A sailor', referenceImageIds: ['user-1/ref.jpg'] }],
    items: [],
    locations: [],
    layoutType: 'grid',
    textLayout: 'caption',
    styleCategory: 'noir',
    styleAspectRatio: '2:3',
    imageResolution: '2K',
    coverImageId: 'user-1/cover.png',
    selectedStyleId: 's1',
    stylePrompt: 'ink',
    styleImageId: 'user-1/style.png',
    styleLockStatus: 'resolved',
    styleLockResolvedAt: 1,
    agentRun: { events: [] },
    imageTags: { 'user-1/p1.png': { tag: 'P1', createdAt: 1 } },
    versions: VERSIONS
  };
  /** A classic comic saved under an older flow: the list must not migrate (or save) it. */
  const legacyState = { ...classicState, flowVersion: 3, step: 2, versions: [] };

  const row = (id: string, state: Record<string, unknown>, updated = '2026-10-05T00:00:00.000Z') => ({
    id,
    user_id: 'user-1',
    name: `Comic ${id}`,
    cover_image_url: null,
    is_public: false,
    is_forced_private: false,
    content_rating: null,
    likes_count: 0,
    views_count: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: updated,
    state
  });

  const stateLoads = () => fakeSupabase.queriesOn('projects').filter((q) => q.columns === 'state,updated_at');
  const cardLoads = () => fakeSupabase.queriesOn('projects').filter((q) => q.columns.includes('state->'));
  const upserts = () => fakeSupabase.state.upserts.filter((u) => u.table === 'projects').map((u) => u.row);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const mount = async () => {
    const hook = renderHook(() => useProjectManager());
    await waitFor(() => expect(hook.result.current.projectsLoaded).toBe(true));
    await waitFor(() => expect(hook.result.current.projects).toHaveLength(fakeSupabase.state.tables.projects.length));
    return hook;
  };
  const listed = (hook: Awaited<ReturnType<typeof mount>>, id: string) => hook.result.current.projects.find((p) => p.id === id)!;

  beforeEach(() => {
    fakeSupabase.reset();
    fakeSupabase.state.tables.projects = [row('classic-1', classicState), row('legacy-1', legacyState, '2026-09-01T00:00:00.000Z')];
    fakeSupabase.state.tables.profiles = [];
    vi.mocked(generation.startBackgroundGeneration).mockClear();
  });
  afterEach(() => {
    document.getElementById('project-state-notice')?.remove();
  });

  it('lists cards, signs their previews, and never migrates or saves one', async () => {
    const hook = await mount();
    expect(cardLoads()).toHaveLength(1);
    expect(stateLoads()).toHaveLength(0);
    const classic = listed(hook, 'classic-1');
    expect('versions' in classic.state).toBe(false);
    expect(classic.state.coverImageUrl).toBe('https://signed.test/user-1/cover.png?thumb');
    expect(classic.state.panels[0].imageUrl).toBe('https://signed.test/user-1/p1.png?thumb');
    expect(listed(hook, 'legacy-1').state.step).toBe(2);
    await sleep(700);
    expect(upserts()).toHaveLength(0);
  });

  it('a rename on a card loads the state once, then saves the full state', async () => {
    const hook = await mount();
    act(() => {
      hook.result.current.updateProject('classic-1', { name: 'Renamed' });
      hook.result.current.updateProject('classic-1', (prev) => ({ state: { ...prev.state, isFeatured: !prev.state.isFeatured } }));
    });
    await waitFor(() => expect(upserts()).toHaveLength(1), { timeout: 2000 });
    expect(stateLoads()).toHaveLength(1);
    const saved = upserts()[0];
    expect(saved).toMatchObject({ id: 'classic-1', name: 'Renamed' });
    const savedState = saved.state as Record<string, unknown>;
    expect(savedState.versions).toEqual(VERSIONS);
    expect(savedState.imageTags).toEqual(classicState.imageTags);
    expect(savedState.script).toBe('The whole script');
    expect(savedState.isFeatured).toBe(true);
    expect(isCardOnly('classic-1')).toBe(false);
    // The dashboard card keeps its signed cover after the swap to the full state.
    expect(listed(hook, 'classic-1').state.coverImageUrl).toBe('https://signed.test/user-1/cover.png?thumb');
    // Now full: the next change saves without another load.
    act(() => hook.result.current.updateProject('classic-1', { name: 'Again' }));
    await waitFor(() => expect(upserts()).toHaveLength(2), { timeout: 2000 });
    expect(stateLoads()).toHaveLength(1);
  });

  it('a failed load drops the update, says so, and saves nothing', async () => {
    const hook = await mount();
    fakeSupabase.state.failures.push({ when: (q) => q.columns === 'state,updated_at', error: { code: '57014', message: 'timeout' } });
    act(() => hook.result.current.updateProject('classic-1', { name: 'Lost' }));
    await waitFor(() => expect(document.getElementById('project-state-notice')).toHaveTextContent(STATE_LOAD_FAILED_SAVE));
    await sleep(700);
    expect(upserts()).toHaveLength(0);
    expect(listed(hook, 'classic-1').name).toBe('Comic classic-1');
    expect(isCardOnly('classic-1')).toBe(true);
  });

  it('opening a card loads its full state once; an unchanged row keeps it across a reload, a changed one discards it', async () => {
    const hook = await mount();
    let opened: Awaited<ReturnType<typeof hook.result.current.hydrateProjectAssets>>;
    await act(async () => {
      [opened] = await Promise.all([hook.result.current.hydrateProjectAssets('classic-1'), hook.result.current.hydrateProjectAssets('classic-1')]);
    });
    expect(stateLoads()).toHaveLength(1);
    expect((opened!.state as unknown as Record<string, unknown>).versions).toEqual(VERSIONS);
    expect(opened!.state.characters[0].referenceImageIds).toEqual(['user-1/ref.jpg']);

    // Unchanged row: the reload keeps the full comic (no second state load, saves go straight through).
    await act(async () => {
      await hook.result.current.reloadProjects();
    });
    expect(cardLoads()).toHaveLength(2);
    expect((listed(hook, 'classic-1').state as unknown as Record<string, unknown>).versions).toEqual(VERSIONS);
    expect(isCardOnly('classic-1')).toBe(false);

    // Edited elsewhere (newer updated_at): the reload takes the card, and the next change loads the new state.
    const stored = fakeSupabase.state.tables.projects.find((r) => r.id === 'classic-1')!;
    stored.updated_at = '2026-10-06T00:00:00.000Z';
    stored.state = { ...classicState, script: 'Edited on another device' };
    await act(async () => {
      await hook.result.current.reloadProjects();
    });
    expect('versions' in listed(hook, 'classic-1').state).toBe(false);
    expect(isCardOnly('classic-1')).toBe(true);
    const before = upserts().length;
    act(() => hook.result.current.updateProject('classic-1', { name: 'After remote edit' }));
    await waitFor(() => expect(upserts()).toHaveLength(before + 1), { timeout: 2000 });
    expect(stateLoads()).toHaveLength(2);
    const saved = upserts()[before];
    expect(saved.name).toBe('After remote edit');
    expect((saved.state as Record<string, unknown>).script).toBe('Edited on another device');
    expect((saved.state as Record<string, unknown>).versions).toEqual(VERSIONS);
  });

  it('a change still waiting to save keeps its full comic across a reload', async () => {
    const hook = await mount();
    await act(async () => {
      await hook.result.current.hydrateProjectAssets('classic-1');
    });
    await sleep(50);
    const before = upserts().length;
    act(() => hook.result.current.updateProject('classic-1', { name: 'Typing' }));
    await act(async () => {
      await hook.result.current.reloadProjects();
    });
    expect(listed(hook, 'classic-1').name).toBe('Typing');
    expect(isCardOnly('classic-1')).toBe(false);
    await waitFor(() => expect(upserts()).toHaveLength(before + 1), { timeout: 2000 });
    expect(upserts()[before]).toMatchObject({ id: 'classic-1', name: 'Typing' });
    expect((upserts()[before].state as Record<string, unknown>).versions).toEqual(VERSIONS);
  });

  it('duplicate loads the full state first and copies it', async () => {
    const hook = await mount();
    await act(async () => {
      await hook.result.current.duplicateProject('classic-1');
    });
    expect(stateLoads()).toHaveLength(1);
    expect(upserts()).toHaveLength(1);
    const copy = upserts()[0];
    expect(copy.id).not.toBe('classic-1');
    expect(copy.name).toBe('Comic classic-1 (Copy)');
    const copyState = copy.state as Record<string, unknown>;
    expect(copyState.versions).toEqual(VERSIONS);
    expect(copyState.script).toBe('The whole script');
    expect(copyState.characters).toEqual(classicState.characters);
    expect(copyState.panels).toEqual([]);
  });

  it('a v4 card opens without a state load; a rename loads its mirror state, then saves it whole without is_public', async () => {
    const mirror = { studioVersion: 4, pipelineMode: 'classic', step: 0, maxStepReached: 0, script: '', scenes: [], panels: [], characters: [], items: [], locations: [], styleVariants: [], stylePrompt: 'ink wash', overview: 'Rivals cook.', studioPages: 6, studioRendered: 2, coverImageId: 'u/user-1/p/studio-1/img/page1.webp' };
    fakeSupabase.state.tables.projects.push(row('studio-1', mirror, '2026-10-07T00:00:00.000Z'));
    const hook = await mount();
    expect('stylePrompt' in listed(hook, 'studio-1').state).toBe(false);
    await act(async () => {
      await hook.result.current.hydrateProjectAssets('studio-1');
    });
    expect(stateLoads()).toHaveLength(0);
    act(() => hook.result.current.updateProject('studio-1', { name: 'Spice Thief', isPublic: true }));
    await waitFor(() => expect(upserts()).toHaveLength(1), { timeout: 2000 });
    expect(stateLoads()).toHaveLength(1);
    expect(upserts()[0]).toMatchObject({ id: 'studio-1', name: 'Spice Thief' });
    expect('is_public' in upserts()[0]).toBe(false);
    expect(upserts()[0].state).toMatchObject({ studioVersion: 4, stylePrompt: 'ink wash', overview: 'Rivals cook.', studioPages: 6 });
  });

  it('startGeneration loads the full state before the run starts', async () => {
    const hook = await mount();
    await act(async () => {
      await hook.result.current.startGeneration('classic-1');
    });
    expect(stateLoads()).toHaveLength(1);
    expect(generation.startBackgroundGeneration).toHaveBeenCalledTimes(1);
    const [project] = vi.mocked(generation.startBackgroundGeneration).mock.calls[0];
    expect((project.state as unknown as Record<string, unknown>).versions).toEqual(VERSIONS);
    expect(project.state.script).toBe('The whole script');
  });
});
