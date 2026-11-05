// getPublicProjectsByUser (gate S4 follow-up — PublicProfile's rating badge): a listing row's
// server-set `content_rating` column reaches Project.contentRating, validated (G / PG / PG-13 only),
// so no card can ever render a rating word the publish gate never assigned. The cards then honour it
// only beside the row's share slug (PublicGallery / PublicProfile).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sb = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], tables: [] as string[] }));

/** A thenable query builder: every filter/order call chains, awaiting it yields `result`. */
const chain = (result: unknown) => {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle']) b[m] = () => b;
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return b;
};

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: (table: string) => {
      sb.tables.push(table);
      return chain(table === 'projects' ? { data: sb.rows, error: null } : { data: [], error: null });
    }
  }
}));

const { getPublicProjectsByUser } = await import('./db');

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
  sb.rows = [];
  sb.tables = [];
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
