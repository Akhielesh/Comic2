// EGRESS-DB E1: the library list reads CARDS (the row's columns and a few state keys), never a comic's whole
// state: no `*`, no bare `state`, never the classic `versions` snapshots or the inline Page Studio style image.
// A card keeps every key the dashboard, the cover hydration and the deep-link routing read, and every listed id
// is flagged card-only until its full state is loaded.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { columnsRead, fakeSupabase, jsonBytes, projectRow } from './projectRows.testkit';

vi.mock('./supabase', async () => ({ supabase: (await import('./projectRows.testkit')).fakeSupabase.client }));

const db = await import('./db');
const { isStudioV4Project, resolveProjectView, studioPageProgress } = await import('./studioDeepLink');
const { PROJECT_CARD_SELECT, PROJECT_CARD_STATE_KEYS, isCardOnly, loadProjectState, loadProjects } = db;

const BIG_STYLE = `data:image/png;base64,${'A'.repeat(200_000)}`;

const classicState = {
  pipelineMode: 'classic',
  flowVersion: 4,
  step: 6,
  maxStepReached: 7,
  script: 'INT. TUNNEL - NIGHT. Salty and Pip enter.',
  scenes: [{ id: 1, rawText: 'Salty and Pip enter.', synopsis: 'They enter.', characters: ['SALTY'], setting: 'Tunnel' }],
  overview: 'Two friends go underground.',
  isFeatured: true,
  comments: [{ id: 'c1', text: 'Nice', createdAt: 1, likes: 2, dislikes: 0 }],
  coverImageId: 'user-1/cover.png',
  coverTemplateImageId: 'user-1/template.png',
  panels: [
    { id: 'p1', sceneId: 1, description: 'Wide shot', imageId: 'user-1/p1.png', imageIdHistory: ['user-1/p1-old.png'] },
    { id: 'p2', sceneId: 1, description: 'Close up' }
  ],
  styleVariants: [{ id: 's1', imageId: 'user-1/style.png', prompt: 'ink', category: 'noir', aspectRatio: '2:3', resolution: '2K' }],
  characters: [{ id: 'ch1', name: 'Salty', description: 'A sailor', imageId: 'user-1/salty.png', referenceImageIds: ['user-1/ref.jpg'] }],
  items: [],
  locations: [{ id: 'l1', name: 'Tunnel', description: 'Dark' }],
  layoutType: 'grid',
  textLayout: 'caption',
  styleCategory: 'noir',
  styleAspectRatio: '2:3',
  imageResolution: '2K',
  pricingConfig: { currency: 'USD', models: {} },
  imageTags: { 'user-1/p1.png': { tag: 'P1', createdAt: 1 } },
  continuity: { bible: { entities: [] } },
  versions: Array.from({ length: 20 }, (_, i) => ({ id: `v${i}`, state: { script: 'x'.repeat(5_000), panels: [] } }))
};

const pageStudioState = {
  pipelineMode: 'pagestudio',
  step: 0,
  maxStepReached: 0,
  script: '',
  scenes: [],
  panels: [],
  styleVariants: [],
  characters: [],
  items: [],
  locations: [],
  pageStudio: {
    brief: 'A page',
    style: { name: 'Inline', imageUrl: BIG_STYLE },
    layout: 'splash',
    aspectRatio: '2:3',
    resolution: '2K',
    pages: [{ id: 'pg1', prompt: 'Hero lands', imageId: 'user-1/page1.png', baseImageId: 'user-1/page1-base.png' }],
    activePageId: 'pg1'
  }
};

const studioState = {
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
  overview: 'A spice market heist',
  studioPages: 6,
  studioRendered: 2,
  coverImageId: 'u/user-1/p/studio-1/img/page1.webp',
  shareSlug: 'AbCdEfGhIjKlMnOpQ'
};

/** An old comic saved before several keys existed: no items/locations/comments/script. */
const oldState = { step: 2, scenes: [], panels: [{ id: 'o1', imageUrl: 'https://legacy.example/o1.png' }], styleVariants: [], characters: [] };

const row = (id: string, state: Record<string, unknown>, updated: string, extra: Record<string, unknown> = {}) => ({
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
  state,
  ...extra
});

beforeEach(() => {
  fakeSupabase.reset();
  fakeSupabase.state.tables.projects = [
    row('classic-1', classicState, '2026-10-05T00:00:00.000Z'),
    row('pagestudio-1', pageStudioState, '2026-10-04T00:00:00.000Z'),
    row('studio-1', studioState, '2026-10-06T00:00:00.000Z'),
    row('old-1', oldState, '2026-09-01T00:00:00.000Z'),
    row('theirs', classicState, '2026-10-07T00:00:00.000Z', { user_id: 'user-2' })
  ];
  fakeSupabase.state.tables.profiles = [{ id: 'user-1', username: 'mira' }];
});

describe('PROJECT_CARD_SELECT', () => {
  const items = PROJECT_CARD_SELECT.split(',');

  it('selects no `*`, no bare `state`, nothing of `versions` and never `pageStudio.style`', () => {
    expect(items).not.toContain('*');
    expect(items).not.toContain('state');
    expect(PROJECT_CARD_SELECT).not.toMatch(/versions/);
    expect(PROJECT_CARD_SELECT).not.toMatch(/state->pageStudio(?!->(?:pages|activePageId)\b)/);
    // Every read of the state column goes through a JSON path to one named key.
    for (const item of items) {
      if (columnsRead(item)[0] === 'state') expect(item).toMatch(/^[A-Za-z]+:state->[A-Za-z]+(->[A-Za-z]+)?$/);
    }
    expect((PROJECT_CARD_STATE_KEYS as readonly string[]).includes('versions')).toBe(false);
  });

  it('ships a small fraction of the full rows', () => {
    const own = fakeSupabase.state.tables.projects.filter((r) => r.user_id === 'user-1');
    const full = jsonBytes(own);
    const cards = jsonBytes(own.map((r) => projectRow(r, PROJECT_CARD_SELECT)));
    expect(cards).toBeLessThan(full / 20);
  });
});

describe('loadProjects (cards)', () => {
  it('asks for the cards of the signed-in user only, newest first', async () => {
    const projects = await loadProjects();
    expect(projects.map((p) => p.id)).toEqual(['studio-1', 'classic-1', 'pagestudio-1', 'old-1']);
    const [query] = fakeSupabase.queriesOn('projects');
    expect(query.columns).toBe(PROJECT_CARD_SELECT);
    expect(query.filters).toEqual(['user_id=eq.user-1', 'order=updated_at.desc']);
    expect(JSON.stringify(projects)).not.toContain('versions');
    expect(JSON.stringify(projects)).not.toContain(BIG_STYLE.slice(0, 64));
  });

  it('rebuilds a state the dashboard, the routing and the cover hydration can read', async () => {
    const byId = new Map((await loadProjects()).map((p) => [p.id, p]));
    const studio = byId.get('studio-1')!;
    const classic = byId.get('classic-1')!;
    const pages = byId.get('pagestudio-1')!;
    const old = byId.get('old-1')!;

    expect(isStudioV4Project(studio)).toBe(true);
    expect(isStudioV4Project(classic)).toBe(false);
    expect(studioPageProgress(studio)).toEqual({ pages: 6, rendered: 2 });
    expect(resolveProjectView(studio)).toBe('comicstudio');
    expect(resolveProjectView(pages)).toBe('pagestudio');
    expect(resolveProjectView(classic)).toBe('editor');
    expect((studio.state as unknown as { shareSlug?: string }).shareSlug).toBe('AbCdEfGhIjKlMnOpQ');

    // What the cover hydration signs and the dashboard filters on.
    expect(classic.state.coverImageId).toBe('user-1/cover.png');
    expect(classic.state.coverTemplateImageId).toBe('user-1/template.png');
    expect(classic.state.panels).toEqual(classicState.panels);
    expect(classic.state.styleVariants).toEqual(classicState.styleVariants);
    expect(classic.state.characters).toEqual(classicState.characters);
    expect(classic.state.step).toBe(6);
    expect(classic.state.overview).toBe('Two friends go underground.');
    expect(classic.state.isFeatured).toBe(true);
    expect(classic.state.comments).toHaveLength(1);
    expect(classic.state.scenes).toHaveLength(1);
    expect(classic.state.script).toBe(classicState.script);
    expect(pages.state.pageStudio).toEqual({ pages: pageStudioState.pageStudio.pages, activePageId: 'pg1' });
    expect('pageStudio' in classic.state).toBe(false);
    // Never on a card: the snapshots, the tags, the continuity bible, the inline style image.
    for (const key of ['versions', 'imageTags', 'continuity', 'maxStepReached', 'flowVersion']) expect(key in classic.state).toBe(false);

    // An old comic missing keys still reads as a full set of arrays and a script.
    expect(old.state.items).toEqual([]);
    expect(old.state.locations).toEqual([]);
    expect(old.state.comments).toEqual([]);
    expect(old.state.script).toBe('');
    expect(old.state.panels[0].imageUrl).toBe('https://legacy.example/o1.png');
    expect(old.name).toBe('Comic old-1');
    expect(old.authorName).toBe('mira');
  });

  it('flags every listed id card-only; loadProjectState returns the full state and clears the flag', async () => {
    await loadProjects();
    for (const id of ['studio-1', 'classic-1', 'pagestudio-1', 'old-1']) expect(isCardOnly(id)).toBe(true);
    const full = await loadProjectState('classic-1');
    expect(full.state).toEqual(classicState);
    expect(full.updatedAt).toBe(Date.parse('2026-10-05T00:00:00.000Z'));
    expect(isCardOnly('classic-1')).toBe(false);
    expect(isCardOnly('studio-1')).toBe(true);
    const [, stateQuery] = fakeSupabase.queriesOn('projects');
    expect(stateQuery).toMatchObject({ columns: 'state,updated_at', filters: ['id=eq.classic-1', 'user_id=eq.user-1'], single: true });
  });

  it('a failed state load leaves the id card-only', async () => {
    await loadProjects();
    fakeSupabase.state.failures.push({ when: (q) => q.columns === 'state,updated_at', error: { code: '57014', message: 'timeout' } });
    await expect(loadProjectState('classic-1')).rejects.toMatchObject({ code: '57014' });
    expect(isCardOnly('classic-1')).toBe(true);
  });

  it('falls back to the card without the moderation and counter columns on 42703', async () => {
    fakeSupabase.state.missingColumns = new Set(['is_forced_private']);
    const projects = await loadProjects();
    expect(projects).toHaveLength(4);
    const selects = fakeSupabase.queriesOn('projects').map((q) => q.columns);
    expect(selects).toHaveLength(2);
    expect(selects[0]).toBe(PROJECT_CARD_SELECT);
    for (const column of ['is_forced_private', 'content_rating', 'likes_count', 'views_count']) expect(columnsRead(selects[1])).not.toContain(column);
    expect(selects[1]).not.toContain('versions');
    expect((projects.find((p) => p.id === 'studio-1')?.state as unknown as Record<string, unknown>).studioPages).toBe(6);
  });

  it('rethrows any other error', async () => {
    fakeSupabase.state.failures.push({ when: (q) => q.table === 'projects', error: { code: '57014', message: 'timeout' } });
    await expect(loadProjects()).rejects.toMatchObject({ code: '57014' });
  });
});
