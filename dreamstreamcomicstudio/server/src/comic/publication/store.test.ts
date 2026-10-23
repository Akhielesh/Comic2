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
