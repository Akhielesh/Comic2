// getPublicProjectsByUser (gate S4 follow-up — PublicProfile's rating badge): a listing row's
// server-set `content_rating` column reaches Project.contentRating, validated (G / PG / PG-13 only),
// so no card can ever render a rating word the publish gate never assigned. The cards then honour it
// only beside the row's share slug (PublicGallery / PublicProfile).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { columnsRead, fakeSupabase } from './projectRows.testkit';

vi.mock('./supabase', async () => ({ supabase: (await import('./projectRows.testkit')).fakeSupabase.client }));

/** The fake projects table and the tables queried, in order (the fake applies select, filters and order). */
const sb = {
  get rows() {
    return fakeSupabase.state.tables.projects ?? [];
  },
  set rows(next: Record<string, unknown>[]) {
    fakeSupabase.state.tables.projects = next;
  },
  get tables() {
    return fakeSupabase.state.queries.map((q) => q.table);
  }
};

const { GALLERY_CARD_SELECT, getPublicProjectsByUser } = await import('./db');

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  state: { studioVersion: 4, shareSlug: 'AbCdEfGhIjKlMnOpQ' },
  is_public: true,
  user_id: 'u1',
  likes_count: 3,
  views_count: 9,
  ...extra
});

beforeEach(() => {
  fakeSupabase.reset();
  sb.rows = [];
});

describe('getPublicProjectsByUser — content_rating', () => {
  it('carries a valid gate rating as Project.contentRating', async () => {
    sb.rows = [row('pg', { content_rating: 'PG' }), row('g', { content_rating: 'G' }), row('pg13', { content_rating: 'PG-13' })];
    const projects = await getPublicProjectsByUser('u1');
    expect(projects.map((p) => [p.id, p.contentRating])).toEqual([
      ['pg', 'PG'],
      ['g', 'G'],
      ['pg13', 'PG-13']
    ]);
    // The rest of the mapping is untouched.
    expect(projects[0]).toMatchObject({ name: 'pg', isPublic: true, userId: 'u1', likesCount: 3, viewsCount: 9 });
    expect(sb.tables).toEqual(['projects', 'profiles']);
  });

  it('ignores anything that is not a gate rating (absent, null, the wrong case, another word, a number)', async () => {
    sb.rows = [row('none'), row('null', { content_rating: null }), row('lower', { content_rating: 'pg' }), row('r', { content_rating: 'R' }), row('num', { content_rating: 13 })];
    const projects = await getPublicProjectsByUser('u1');
    expect(projects).toHaveLength(5);
    for (const p of projects) {
      expect(p.contentRating).toBeUndefined();
      expect('contentRating' in p).toBe(false);
    }
  });
});

// EGRESS-DB E3: a creator's public profile reads cards (the columns and state keys a card reads), never a comic's
// whole state, and never a comic held by moderation.
describe('getPublicProjectsByUser — cards', () => {
  const classic = {
    coverImageUrl: 'https://cdn.test/cover.png',
    coverImageId: 'u1/cover.png',
    panels: [{ id: 'p1', imageId: 'u1/p1.png' }],
    styleVariants: [{ id: 's1', imageUrl: 'https://cdn.test/style.png' }],
    publishedAt: 1_700_000_000_000,
    script: 'x'.repeat(5_000),
    imageTags: { 'u1/p1.png': { tag: 'P1' } },
    versions: [{ id: 'v1', state: { script: 'old draft' } }]
  };

  it('selects no `*`, no bare `state` and no `versions`, and asks for unheld public comics of this creator', async () => {
    sb.rows = [row('classic', { state: classic }), row('v4', { content_rating: 'PG', state: { studioVersion: 4, shareSlug: 'AbCdEfGhIjKlMnOpQ', publicCover: `pub/${'A'.repeat(22)}/cover.webp` } })];
    const projects = await getPublicProjectsByUser('u1');
    const [query] = fakeSupabase.queriesOn('projects');
    expect(query.columns).toBe(GALLERY_CARD_SELECT);
    const items = query.columns.split(',');
    expect(items).not.toContain('*');
    expect(items).not.toContain('state');
    expect(query.columns).not.toMatch(/versions|script|imageTags/);
    for (const item of items) if (columnsRead(item)[0] === 'state') expect(item).toMatch(/^[A-Za-z]+:state->[A-Za-z]+$/);
    expect(query.filters).toEqual(['user_id=eq.u1', 'is_public=eq.true', 'is_forced_private=not.is.true', 'order=created_at.desc']);

    // The card keeps every field the profile card and its cover fallbacks read.
    const card = projects.find((p) => p.id === 'classic')!;
    expect(card.state).toEqual({ coverImageUrl: classic.coverImageUrl, coverImageId: classic.coverImageId, panels: classic.panels, styleVariants: classic.styleVariants, publishedAt: classic.publishedAt });
    expect(card.publishedAt).toBe(classic.publishedAt);
    const v4 = projects.find((p) => p.id === 'v4')!;
    expect(v4.state).toMatchObject({ studioVersion: 4, shareSlug: 'AbCdEfGhIjKlMnOpQ', panels: [], styleVariants: [] });
    expect(v4.contentRating).toBe('PG');
    expect(JSON.stringify(projects)).not.toContain('old draft');
  });

  it('never returns a comic held by moderation, nor another creator\'s or a private one', async () => {
    sb.rows = [
      row('mine', { state: classic }),
      row('held', { is_forced_private: true, state: classic }),
      row('unset', { is_forced_private: null, state: classic }),
      row('private', { is_public: false, state: classic }),
      row('theirs', { user_id: 'u2', state: classic })
    ];
    const projects = await getPublicProjectsByUser('u1');
    expect(projects.map((p) => p.id).sort()).toEqual(['mine', 'unset']);
  });
});

// EGRESS-DB E3: the landing stats count public comics with a HEAD request on one column (no `*`).
describe('getStudioStats', () => {
  it('counts public comics with a HEAD on id, then reads only user ids', async () => {
    const { getStudioStats } = await import('./stats');
    sb.rows = [row('a', { state: {} }), row('b', { state: {}, user_id: 'u2' }), row('c', { state: {}, is_public: false })];
    expect(await getStudioStats()).toEqual({ comicCount: 2, userCount: 2 });
    const [count, users] = fakeSupabase.queriesOn('projects');
    expect(count).toMatchObject({ columns: 'id', head: true, count: 'exact', filters: ['is_public=eq.true'] });
    expect(users).toMatchObject({ columns: 'user_id', head: false, filters: ['is_public=eq.true'] });
  });
});
