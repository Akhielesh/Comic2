// @vitest-environment node
// P2-PUBLIC-PAYLOAD: the Supabase publication store mirrors the frozen publish-time rating onto
// projects.content_rating (service role; the gallery's "Kids-friendly (G/PG)" filter reads it).
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createSupabasePublicationStore, type MirrorArgs } from './store.js';

interface Update {
  table: string;
  patch: Record<string, unknown>;
  filters: [string, unknown][];
}

/** A tiny PostgREST stand-in: select → { state: {} }; update → the scripted error (or none). */
function fakeAdmin(script: { updateError?: (patch: Record<string, unknown>) => { code: string; message: string } | null } = {}) {
  const updates: Update[] = [];
  const client = {
    from(table: string) {
      return {
        select() {
          const q = { eq: () => q, maybeSingle: async () => ({ data: { state: { shareSlug: 'old' } }, error: null }) };
          return q;
        },
        update(patch: Record<string, unknown>) {
          const entry: Update = { table, patch: { ...patch }, filters: [] };
          updates.push(entry);
          const error = script.updateError?.(patch) ?? null;
          const q = {
            eq: (col: string, v: unknown) => (entry.filters.push([col, v]), q),
            then: (ok: (v: { error: unknown }) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ error }).then(ok, bad)
          };
          return q;
        }
      };
    }
  };
  return { admin: () => client as unknown as SupabaseClient, updates };
}

const base: MirrorArgs = { projectId: 'p-1', userId: 'u-1', isPublic: true, shareSlug: 'Ab3dEf6hIj9kLm2nP', publicCover: 'pub/K/cover.webp', publishedAt: 1, listing: { name: 'Spice Run', overview: 'Blurb' } };

describe('mirrorProject → projects.content_rating', () => {
  it('writes the publish-time rating, owner-scoped, alongside the listing mirror', async () => {
    const { admin, updates } = fakeAdmin();
    await createSupabasePublicationStore({ admin }).mirrorProject({ ...base, contentRating: 'PG' });
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('projects');
    expect(updates[0].patch).toMatchObject({ is_public: true, content_rating: 'PG', name: 'Spice Run' });
    expect(updates[0].filters).toEqual([
      ['id', 'p-1'],
      ['user_id', 'u-1']
    ]);
  });

  it('null clears it (unpublish); undefined leaves it alone; an unknown value is never written', async () => {
    const { admin, updates } = fakeAdmin();
    const store = createSupabasePublicationStore({ admin });
    await store.mirrorProject({ ...base, isPublic: false, contentRating: null });
    await store.mirrorProject({ ...base });
    await store.mirrorProject({ ...base, contentRating: 'R' as never });
    expect(updates[0].patch.content_rating).toBeNull();
    expect('content_rating' in updates[1].patch).toBe(false);
    expect('content_rating' in updates[2].patch).toBe(false);
  });

  it('before comic_safety.sql adds the column: retries without it, so publishing still mirrors visibility', async () => {
    for (const code of ['PGRST204', '42703']) {
      const { admin, updates } = fakeAdmin({ updateError: (patch) => ('content_rating' in patch ? { code, message: "Could not find the 'content_rating' column" } : null) });
      await expect(createSupabasePublicationStore({ admin }).mirrorProject({ ...base, contentRating: 'G' })).resolves.toBeUndefined();
      expect(updates).toHaveLength(2);
      expect('content_rating' in updates[1].patch).toBe(false);
      expect(updates[1].patch).toMatchObject({ is_public: true, name: 'Spice Run' });
    }
  });

  it('any other database error is an honest 503 (no silent retry)', async () => {
    const { admin, updates } = fakeAdmin({ updateError: () => ({ code: '08006', message: 'connection failure' }) });
    await expect(createSupabasePublicationStore({ admin }).mirrorProject({ ...base, contentRating: 'PG' })).rejects.toMatchObject({ status: 503, code: 'NOT_AVAILABLE' });
    expect(updates).toHaveLength(1);
  });
});

/** A chainable PostgREST stand-in that records every call and answers `result` at the end of the chain. */
function recordingAdmin(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'lt', 'order', 'limit']) chain[m] = (...args: unknown[]) => (calls.push([m, args]), chain);
  chain.maybeSingle = async () => (calls.push(['maybeSingle', []]), result);
  chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
  const client = { from: (table: string) => (calls.push(['from', [table]]), chain) };
  return { admin: () => client as unknown as SupabaseClient, calls };
}

describe('moderation maintenance reads (L11)', () => {
  it('suspendedKeys: suspended rows past the grace period, newest first, well-formed keys only', async () => {
    const { admin, calls } = recordingAdmin({ data: [{ asset_key: 'Ab3dEf6hIj9kLm2nOp5qRs' }, { asset_key: '../etc' }, { asset_key: null }], error: null });
    const keys = await createSupabasePublicationStore({ admin }).suspendedKeys!(50, Date.UTC(2026, 9, 22));
    expect(keys).toEqual(['Ab3dEf6hIj9kLm2nOp5qRs']);
    expect(calls).toEqual([
      ['from', ['comic_publications']],
      ['select', ['asset_key']],
      ['eq', ['status', 'suspended']],
      ['not', ['asset_key', 'is', null]],
      ['lt', ['updated_at', '2026-10-22T00:00:00.000Z']],
      ['order', ['updated_at', { ascending: false }]],
      ['limit', [50]]
    ]);
    const failing = recordingAdmin({ data: null, error: { code: '08006' } });
    await expect(createSupabasePublicationStore({ admin: failing.admin }).suspendedKeys!(50, 1)).resolves.toEqual([]);
  });

  it('getByProject reads one row by project id (service role), missing table → null', async () => {
    const row = { id: 'x', project_id: 'p-1', user_id: 'u-1', status: 'suspended', visibility: 'public', slug: 'Ab3dEf6hIj9kLm2nP', asset_key: 'Ab3dEf6hIj9kLm2nOp5qRs', languages: ['en'], snapshot: null, card: {}, safety: {} };
    const { admin, calls } = recordingAdmin({ data: row, error: null });
    const got = await createSupabasePublicationStore({ admin }).getByProject!('p-1');
    expect(got).toMatchObject({ projectId: 'p-1', userId: 'u-1', status: 'suspended', assetKey: 'Ab3dEf6hIj9kLm2nOp5qRs' });
    expect(calls.filter(([m]) => m === 'eq')).toEqual([['eq', ['project_id', 'p-1']]]);
    const missing = recordingAdmin({ data: null, error: { code: '42P01' } });
    await expect(createSupabasePublicationStore({ admin: missing.admin }).getByProject!('p-1')).resolves.toBeNull();
  });
});
