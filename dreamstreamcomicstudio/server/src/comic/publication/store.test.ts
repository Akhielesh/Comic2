// @vitest-environment node
// P2-PUBLIC-PAYLOAD: the Supabase publication store mirrors the frozen publish-time rating onto
// projects.content_rating (service role; the gallery's "Kids-friendly (G/PG)" filter reads it).
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { createMemoryPublicationStore, createSupabasePublicationStore, mirrorState, rowFromDb, type MirrorArgs } from './store.js';

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

// ── P2-GATE follow-ups: owner-written listing images, jsonb-safe writes ─────────────────────────
describe('mirrorState: a public v4 listing row never carries owner-written image URLs (S4)', () => {
  const ownerWritten = () => ({
    studioVersion: 4,
    shareSlug: 'old',
    coverImageId: 'u/u-1/p/p-1/img/draft-cover.webp',
    coverImageUrl: 'https://x.test/owner-picked.jpg',
    panels: [{ id: 'p1', imageUrl: 'https://x.test/panel.jpg', imageId: 'u/u-1/p/p-1/img/panel.webp' }],
    styleVariants: [{ id: 's1', imageUrl: 'https://x.test/style.jpg', imageId: 'u/u-1/p/p-1/img/style.webp' }],
    stylePrompt: 'private spec',
    overview: 'live draft text'
  });

  it('going public: the cover is the opaque published copy only; coverImageUrl, panels and styleVariants are gone', () => {
    const state = mirrorState(ownerWritten(), { isPublic: true, shareSlug: 'Ab3dEf6hIj9kLm2nP', publicCover: 'pub/Ab3dEf6hIj9kLm2nOp5qRs/cover-0123456789ab.webp', publishedAt: 5, listing: { name: 'Spice Run', overview: 'Published blurb' } });
    expect(state).toMatchObject({ coverImageId: 'pub/Ab3dEf6hIj9kLm2nOp5qRs/cover-0123456789ab.webp', panels: [], styleVariants: [], stylePrompt: '', overview: 'Published blurb', studioVersion: 4 });
    expect('coverImageUrl' in state).toBe(false);
    // Nothing a public reader could sign or show is left besides the published copy.
    expect(JSON.stringify(state)).not.toMatch(/x\.test|draft-cover|panel\.webp|style\.webp/);
  });

  it('the memory store applies the same rule; leaving public never touches the owner’s private state', async () => {
    const store = createMemoryPublicationStore();
    store.seedProject('p-1', 'u-1');
    store.projects.get('p-1')!.state = ownerWritten();
    await store.mirrorProject({ ...base, publicCover: 'pub/Ab3dEf6hIj9kLm2nOp5qRs/cover-0123456789ab.webp' });
    const pub = store.projects.get('p-1')!.state;
    expect(pub.panels).toEqual([]);
    expect(pub.styleVariants).toEqual([]);
    expect('coverImageUrl' in pub).toBe(false);
    store.projects.get('p-1')!.state = ownerWritten();
    await store.mirrorProject({ ...base, isPublic: false, shareSlug: null, publicCover: null, listing: undefined });
    expect(store.projects.get('p-1')!.state).toMatchObject({ coverImageUrl: 'https://x.test/owner-picked.jpg', panels: [{ id: 'p1' }], styleVariants: [{ id: 's1' }] });
  });
});

/** PostgREST stand-in for upsert: update(...).eq().eq().select() finds no row, so insert(payload) runs. */
function writeAdmin() {
  const writes: { kind: 'update' | 'insert'; table: string; payload: Record<string, unknown> }[] = [];
  const client = {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          writes.push({ kind: 'update', table, payload });
          const q = { eq: () => q, select: async () => ({ data: [], error: null }), then: (ok: (v: { error: unknown }) => unknown) => Promise.resolve({ error: null }).then(ok) };
          return q;
        },
        insert: async (payload: Record<string, unknown>) => (writes.push({ kind: 'insert', table, payload }), { error: null }),
        select() {
          const q = { eq: () => q, maybeSingle: async () => ({ data: { state: { panels: [{ imageUrl: 'https://x.test/\u0000p.jpg' }] } }, error: null }) };
          return q;
        }
      };
    }
  };
  return { admin: () => client as unknown as SupabaseClient, writes };
}

describe('jsonb-safe publication writes (P2-GATE L5)', () => {
  const BAD = /[\u0000]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('upsert: a NUL or half an emoji anywhere in the snapshot, card or settings never reaches Postgres (and whole emoji survive)', async () => {
    const row = rowFromDb({ id: 'x', project_id: 'p-1', user_id: 'u-1', status: 'live', visibility: 'unlisted', slug: 'Ab3dEf6hIj9kLm2nP', asset_key: 'Ab3dEf6hIj9kLm2nOp5qRs', languages: ['en'], card: {}, safety: {} });
    const snapshot = { id: 'p-1', brief: { title: 'Spice\u0000 Run \uD83C', logline: 'A fox 🦊 races\uDC00' }, pages: [{ id: 'pg_1', panels: [{ lines: [{ text: 'Run!\u0000' }] }] }], ['k\uD800ey']: 1 } as unknown as ComicDoc;
    const { admin, writes } = writeAdmin();
    await createSupabasePublicationStore({ admin }).upsert({ ...row, snapshot, card: { title: 'Spice\u0000 Run', alt: 'cover \uDBFF' } as never, safety: { note: 'x\u0000' } });
    expect(writes.map((w) => w.kind)).toEqual(['update', 'insert']);
    for (const w of writes) {
      const json = JSON.stringify(w.payload);
      expect(BAD.test(JSON.parse(json).snapshot.brief.title)).toBe(false);
      expect(json).not.toMatch(/\\u0000|\\ud8[0-9a-f]{2}(?!\\udc)|\\udbff/i);
      expect((w.payload.snapshot as ComicDoc).brief.logline).toContain('🦊');
      expect((w.payload.snapshot as ComicDoc).pages[0].panels[0].lines[0].text).toBe('Run!');
    }
    // The caller's row is never mutated (copy-on-write).
    expect(snapshot.brief.title).toBe('Spice\u0000 Run \uD83C');
  });

  it('mirrorProject: the listing name, blurb and existing state are jsonb-safe too', async () => {
    const { admin, writes } = writeAdmin();
    await createSupabasePublicationStore({ admin }).mirrorProject({ ...base, isPublic: false, listing: undefined });
    await createSupabasePublicationStore({ admin }).mirrorProject({ ...base, listing: { name: 'Spice\u0000 Run \uD83C', overview: 'Blurb\uDC00 🦊' } });
    for (const w of writes) expect(JSON.stringify(w.payload)).not.toMatch(/\\u0000|\\ud8[0-9a-f]{2}(?!\\udc)|\\udc00/i);
    expect(writes[1].payload).toMatchObject({ name: 'Spice Run �' });
    expect((writes[1].payload.state as Record<string, unknown>).overview).toBe('Blurb� 🦊');
  });
});
