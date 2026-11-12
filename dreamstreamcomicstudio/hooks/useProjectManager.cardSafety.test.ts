// EGRESS-DB E1 review findings: a library card (a state subset) must never become the source of a saved change.
// - A comic that failed to open is shown by App from its card: every change computed there is refused, and no load
//   is started that would let it land on the full state (review: safety 1, security 1).
// - A reload never replaces a full comic with its card, keeps one this tab is still saving, and takes the row
//   columns the server writes (safety 2, 4).
// - An update queued on a card that sets a key the card lacks to a value computed from the card is dropped.
// - The notice is placed by a fixed element (security 2).
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import { fakeSupabase } from '../services/projectRows.testkit';
import { assignImageTags, collectStateImageEntries } from '../services/imageTags';
import { TOAST } from '../components/chat/studioDesign';

vi.mock('../services/supabase', async () => ({ supabase: (await import('../services/projectRows.testkit')).fakeSupabase.client }));
vi.mock('../services/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/db')>()),
  getImageUrl: vi.fn(async (id: string) => `https://signed.test/${id}`),
  createGenerationNotification: vi.fn(async () => undefined)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' }, loading: false }) }));
vi.mock('../services/generationManager', () => ({ startBackgroundGeneration: vi.fn(), cancelGeneration: vi.fn() }));

const { useProjectManager, STATE_LOAD_FAILED, STATE_NOT_OPENED_SAVE, PROJECT_NOTICE_ID, OPEN_RETRY_DELAYS_MS } = await import('./useProjectManager');
const { isCardOnly, isCardState } = await import('../services/db');

const VERSIONS = [{ id: 'v1', name: 'Old', createdAt: 1, state: { script: 'an older draft' } }];
const TAGS = { 'user-1/p1.png': { imageId: 'user-1/p1.png', tag: 'PANEL-0007', category: 'PANEL', createdAt: 1 } };
const STYLE = { source: 'image', referenceDataUrl: 'data:image/png;base64,AAAA', brief: 'ink', tags: ['noir'], confirmed: true };
const fullState = {
  pipelineMode: 'classic', flowVersion: 4, step: 6, maxStepReached: 7, script: 'Script', scenes: [], overview: '', comments: [],
  isFeatured: false, panels: [{ id: 'p1', imageId: 'user-1/p1.png' }], styleVariants: [], characters: [], items: [], locations: [],
  layoutType: 'grid', textLayout: 'caption', styleCategory: 'noir', styleAspectRatio: '2:3', imageResolution: '2K',
  agentRun: { events: [] }, imageTags: TAGS, imageTagCounters: { PANEL: 7 }, versions: VERSIONS,
  pageStudio: { stage: 'edit', style: STYLE, layout: { source: 'preset' }, pages: [{ id: 'pg1', imageId: 'user-1/pg1.png' }], activePageId: 'pg1' }
};
const OLD = '2026-10-05T00:00:00.000Z';
const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', user_id: 'user-1', name: 'Comic', cover_image_url: null, is_public: true, is_forced_private: false, content_rating: null,
  likes_count: 0, views_count: 0, created_at: '2026-10-01T00:00:00.000Z', updated_at: OLD, state: fullState, ...over
});
const stored = () => fakeSupabase.state.tables.projects[0] as Record<string, any>;
const upserts = () => fakeSupabase.state.upserts.filter((u) => u.table === 'projects').map((u) => u.row as Record<string, any>);
const stateLoads = () => fakeSupabase.queriesOn('projects').filter((q) => q.columns === 'state,updated_at');
const isStateLoad = (q: { columns: string }) => q.columns === 'state,updated_at';
const failStateLoads = (times: number) => {
  for (let i = 0; i < times; i += 1) fakeSupabase.state.failures.push({ when: isStateLoad, error: { code: '57014', message: 'statement timeout' } });
};
const gate = (when: (q: { table: string; columns: string }) => boolean) => {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  fakeSupabase.state.gates.push({ when, release: released });
  return release;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const notice = () => document.getElementById(PROJECT_NOTICE_ID);
const ALL_ATTEMPTS = OPEN_RETRY_DELAYS_MS.length + 1;
const RETRIES_MS = OPEN_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

const mount = async () => {
  const hook = renderHook(() => useProjectManager());
  await waitFor(() => expect(hook.result.current.projects).toHaveLength(1));
  return hook;
};
type Hook = Awaited<ReturnType<typeof mount>>;
const listed = (hook: Hook) => hook.result.current.projects[0];

/** Opens the comic the way App does; returns what App then shows (the card, after a failed open). */
const openFails = async (hook: Hook) => {
  failStateLoads(ALL_ATTEMPTS);
  await act(async () => {
    await hook.result.current.hydrateProjectAssets('c1').catch(() => undefined);
  });
  return listed(hook);
};
/** Opens the comic and waits for the save its flow migration makes on open (hydrateProject). */
const openAndSettle = async (hook: Hook) => {
  await act(async () => {
    await hook.result.current.hydrateProjectAssets('c1');
  });
  await waitFor(() => expect(upserts()).toHaveLength(1));
  await sleep(20);
};

beforeEach(() => {
  fakeSupabase.reset();
  fakeSupabase.state.tables.projects = [row()];
  fakeSupabase.state.tables.profiles = [];
});
afterEach(() => notice()?.remove());

describe('a comic that failed to open (App shows its card in the workspace)', () => {
  it('an open retries a failed load while the app shows its loader: a blip opens the full comic', async () => {
    const hook = await mount();
    failStateLoads(1);
    let opened: Project | undefined;
    await act(async () => {
      opened = await hook.result.current.hydrateProjectAssets('c1');
    });
    expect(stateLoads()).toHaveLength(2);
    expect((opened!.state as any).versions).toEqual(VERSIONS);
    expect(isCardState(listed(hook).state)).toBe(false);
    expect(notice()).toBeNull();
  });

  it('after every retry fails it says so and keeps the card', async () => {
    const hook = await mount();
    const card = await openFails(hook);
    expect(stateLoads()).toHaveLength(ALL_ATTEMPTS);
    expect(isCardState(card.state)).toBe(true);
    expect(notice()).toHaveTextContent(STATE_LOAD_FAILED);
  }, 10_000);

  it('the image-tag rebuild, Save version, Next step and a Page Studio style patch made on the card are refused, start no load, and say so', async () => {
    const hook = await mount();
    const card = await openFails(hook);
    const cardState = card.state as any;
    // ComicEditor's image-tag effect: tags assigned from the card's (absent) map.
    const { tags, counters } = assignImageTags(cardState.imageTags || {}, cardState.imageTagCounters || {}, collectStateImageEntries(card.state));
    // ComicEditor's Save version (appendVersion reads `state.versions || []`) and Next step (Math.max on a missing key).
    const versions = [...(cardState.versions || []), { id: 'v2', name: 'New', createdAt: 2, state: {} }];
    const maxStepReached = Math.max(cardState.maxStepReached, 7);
    // PageStudio's patchStyle: `{ ...ps.style, ...next }` with ps from DEFAULT_STATE on a card.
    const ps = { style: {}, ...(cardState.pageStudio || {}) };
    act(() => {
      hook.result.current.updateProject('c1', (prev) => ({ state: { ...prev.state, imageTags: tags, imageTagCounters: counters } }));
      hook.result.current.updateProject('c1', (prev) => ({ state: { ...prev.state, versions } as any }));
      hook.result.current.updateProject('c1', (prev) => ({ state: { ...prev.state, step: 7, maxStepReached } }));
      hook.result.current.updateProject('c1', (prev) => ({
        state: { ...prev.state, pageStudio: { ...(prev.state.pageStudio || {}), style: { ...ps.style, prompt: 'brush' } } as any }
      }));
    });
    expect(notice()).toHaveTextContent(STATE_NOT_OPENED_SAVE);
    await sleep(800);
    expect(stateLoads()).toHaveLength(ALL_ATTEMPTS);
    expect(upserts()).toHaveLength(0);
    expect(stored().state).toEqual(fullState);
  }, 10_000);

  it('a stale closure from the card landing later is refused too: nothing in between loaded the full state', async () => {
    const hook = await mount();
    const card = await openFails(hook);
    const ps = { style: {}, ...((card.state as any).pageStudio || {}) }; // captured when an analysis started on the card
    act(() => hook.result.current.updateProject('c1', { name: 'Renamed' }));
    await sleep(300);
    act(() => hook.result.current.updateProject('c1', (prev) => ({
      state: { ...prev.state, pageStudio: { ...(prev.state.pageStudio || {}), style: { ...ps.style, brief: 'new brief' } } as any }
    })));
    await sleep(800);
    expect(upserts()).toHaveLength(0);
    expect(stateLoads()).toHaveLength(ALL_ATTEMPTS);
    expect(stored().state.pageStudio.style).toEqual(STYLE);
  }, 10_000);

  it('opening it again loads it; changes then save over the full comic', async () => {
    const hook = await mount();
    await openFails(hook);
    let opened: Project | undefined;
    await act(async () => {
      opened = await hook.result.current.hydrateProjectAssets('c1');
    });
    expect((opened!.state as any).versions).toEqual(VERSIONS);
    const before = upserts().length;
    act(() => hook.result.current.updateProject('c1', (prev) => ({
      state: { ...prev.state, versions: [...((prev.state as any).versions || []), { id: 'v2', name: 'New', createdAt: 2, state: {} }] } as any
    })));
    await waitFor(() => expect(upserts().length).toBeGreaterThan(before), { timeout: 2000 });
    const saved = upserts()[upserts().length - 1];
    expect(saved.state.versions.map((v: { id: string }) => v.id)).toEqual(['v1', 'v2']);
    expect(saved.state.imageTags).toEqual(TAGS);
    expect(saved.state.pageStudio.style).toEqual(STYLE);
    expect(saved.state.maxStepReached).toBe(7);
  }, 10_000);
});

describe('an update queued on a library card (the dashboard, the info modal)', () => {
  it('an image-tag map computed from the card is dropped; a change computed from the comic applies', async () => {
    const hook = await mount();
    const card = listed(hook);
    expect(isCardState(card.state)).toBe(true);
    // ProjectInfoModal's effect: tags assigned from the card's (absent) map, outside the updater.
    const { tags, counters } = assignImageTags(card.state.imageTags || {}, card.state.imageTagCounters || {}, collectStateImageEntries(card.state));
    const comment = { id: 'n1', text: 'Nice', createdAt: 3, likes: 0, dislikes: 0 };
    act(() => {
      hook.result.current.updateProject('c1', (prev) => ({ state: { ...prev.state, imageTags: tags, imageTagCounters: counters } }));
      hook.result.current.updateProject('c1', (prev) => ({ state: { ...prev.state, comments: [...(prev.state.comments || []), comment] } }));
      hook.result.current.updateProject('c1', (prev) => ({ state: { ...prev.state, isFeatured: !prev.state.isFeatured } }));
    });
    await waitFor(() => expect(upserts()).toHaveLength(1), { timeout: 2000 });
    const saved = upserts()[0].state;
    expect(saved.imageTags).toEqual(TAGS);
    expect(saved.imageTagCounters).toEqual({ PANEL: 7 });
    expect(saved.comments).toEqual([comment]);
    expect(saved.isFeatured).toBe(true);
    expect(saved.versions).toEqual(VERSIONS);
  });
});

describe('a reload never replaces a full comic with its card', () => {
  it('a list asked for before this tab\'s save landed keeps the comic full: no stale flag, no second load', async () => {
    const hook = await mount();
    await openAndSettle(hook);
    const loadsBefore = stateLoads().length;
    const releaseList = gate((q) => q.table === 'projects' && q.columns.includes('state->'));
    let reload: Promise<void> | undefined;
    act(() => {
      reload = hook.result.current.reloadProjects();
    });
    act(() => hook.result.current.updateProject('c1', { name: 'Typed' }));
    await waitFor(() => expect(upserts()).toHaveLength(2), { timeout: 2000 });
    await sleep(20);
    // The list's snapshot predates that save: the row it returns still has the older time.
    stored().updated_at = OLD;
    releaseList();
    await act(async () => {
      await reload;
    });
    expect(isCardOnly('c1')).toBe(false);
    expect(listed(hook).name).toBe('Typed');
    expect((listed(hook).state as any).versions).toEqual(VERSIONS);
    act(() => hook.result.current.updateProject('c1', { name: 'Again' }));
    await waitFor(() => expect(upserts()).toHaveLength(3), { timeout: 2000 });
    expect(stateLoads()).toHaveLength(loadsBefore);
  });

  it('a save still in flight during a reload keeps the comic full, so no edit is lost to a reload of the older row', async () => {
    const hook = await mount();
    await openAndSettle(hook);
    const releaseSave = gate((q) => q.table === 'projects' && q.columns === '');
    act(() => hook.result.current.updateProject('c1', (prev) => ({ state: { ...prev.state, overview: 'First edit' } })));
    await sleep(650); // the debounce has fired: the upsert is on the wire (held by the gate)
    await act(async () => {
      await hook.result.current.reloadProjects();
    });
    expect(isCardOnly('c1')).toBe(false);
    expect(isCardState(listed(hook).state)).toBe(false);
    act(() => hook.result.current.updateProject('c1', (prev) => ({ state: { ...prev.state, script: 'Second edit' } })));
    releaseSave();
    await waitFor(() => expect(upserts()).toHaveLength(3), { timeout: 2000 });
    expect(stored().state.overview).toBe('First edit');
    expect(stored().state.script).toBe('Second edit');
    expect(stored().state.versions).toEqual(VERSIONS);
  });
});

describe('a kept full comic takes the row columns the server writes', () => {
  it('a moderation hold (is_public false, no updated_at bump) is not undone by the next save', async () => {
    const hook = await mount();
    await openAndSettle(hook);
    // safety/store.ts forcePrivate: update({ is_public: false, is_forced_private: true }) without updated_at.
    Object.assign(stored(), { is_public: false, is_forced_private: true });
    await act(async () => {
      await hook.result.current.reloadProjects();
    });
    expect(listed(hook).isPublic).toBe(false);
    act(() => hook.result.current.updateProject('c1', { name: 'Edit after hold' }));
    await waitFor(() => expect(upserts()).toHaveLength(2), { timeout: 2000 });
    // In production projects_guard_client_writes refuses is_public true on a held row (42501), every save after it.
    expect(upserts()[1].is_public).toBe(false);
  });

  it('a classic public share made by the server, and new counters, are kept', async () => {
    fakeSupabase.state.tables.projects = [row({ is_public: false })];
    const hook = await mount();
    await openAndSettle(hook);
    Object.assign(stored(), { is_public: true, likes_count: 4, views_count: 9 });
    await act(async () => {
      await hook.result.current.reloadProjects();
    });
    expect(listed(hook)).toMatchObject({ isPublic: true, likesCount: 4, viewsCount: 9 });
    act(() => hook.result.current.updateProject('c1', { name: 'Edit after share' }));
    await waitFor(() => expect(upserts()).toHaveLength(2), { timeout: 2000 });
    expect(upserts()[1].is_public).toBe(true);
  });

  it('a visibility change made here and not yet saved wins over the list', async () => {
    fakeSupabase.state.tables.projects = [row({ is_public: false })];
    const hook = await mount();
    await openAndSettle(hook);
    act(() => hook.result.current.updateProject('c1', { isPublic: true }));
    await act(async () => {
      await hook.result.current.reloadProjects();
    });
    expect(listed(hook).isPublic).toBe(true);
    await waitFor(() => expect(upserts()).toHaveLength(2), { timeout: 2000 });
    expect(upserts()[1].is_public).toBe(true);
  });
});

describe('the notice', () => {
  it('is placed by a fixed outer element on the toast layer; the TOAST recipe (relative) styles the inner one', async () => {
    const hook = await mount();
    failStateLoads(1);
    act(() => hook.result.current.updateProject('c1', { name: 'Lost' }));
    await waitFor(() => expect(notice()).not.toBeNull());
    const place = notice()!;
    const classes = place.className.split(/\s+/);
    expect(classes).toContain('fixed');
    expect(classes).not.toContain('relative');
    expect(place.className).toContain('z-[var(--ds-z-toast)]');
    const inner = place.firstElementChild as HTMLElement;
    expect(inner.getAttribute('role')).toBe('alert');
    expect(inner.className).toBe(TOAST);
  });
});

it('the retry delays add up to a short wait', () => {
  expect(RETRIES_MS).toBeLessThanOrEqual(3000);
});
