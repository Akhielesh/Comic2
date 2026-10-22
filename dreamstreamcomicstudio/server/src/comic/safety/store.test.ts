// The Supabase safety store against a recording fake client: row shapes (no content), dedupe
// mapping, fail-closed age lookups, and the unconfigured (dev/test) defaults.
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseSafetyStore } from './store.js';

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

/** A chainable fake: every builder method records itself; awaiting resolves the scripted response. */
function fakeDb(respond: (table: string, calls: Call[]) => { data?: unknown; error?: unknown; count?: number }) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const mine: Call[] = [];
      const builder: Record<string, unknown> = {};
      for (const method of ['insert', 'upsert', 'update', 'delete', 'select', 'eq', 'neq', 'gt', 'gte', 'in', 'order', 'range', 'limit', 'maybeSingle']) {
        builder[method] = (...args: unknown[]) => {
          const call = { table, method, args };
          calls.push(call);
          mine.push(call);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(respond(table, mine)).then(resolve, reject);
      return builder;
    }
  };
  return { db: db as unknown as SupabaseClient, calls };
}

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

const USER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

describe('createSupabaseSafetyStore', () => {
  it('records events with categories and a hash only (never text); invalid ids become null', async () => {
    const { db, calls } = fakeDb(() => ({ error: null }));
    const store = createSupabaseSafetyStore({ db: () => db });
    await store.recordEvent({ userId: USER, projectId: 'proj-1', surface: 'message', layer: 'prefilter', decision: 'block', categories: ['sexual'], effective: 'PG', severity: 1, contentHash: 'abcdef0123456789' });
    const row = calls.find((c) => c.method === 'insert')!.args[0] as Record<string, unknown>;
    expect(row).toEqual({
      user_id: USER,
      project_id: null,
      surface: 'message',
      layer: 'prefilter',
      decision: 'block',
      categories: ['sexual'],
      effective_rating: 'PG',
      assessed: null,
      severity: 1,
      content_hash: 'abcdef0123456789',
      model: null,
      cost_usd: 0
    });
  });

  it('platform costs are billable 0', async () => {
    const { db, calls } = fakeDb(() => ({ error: null }));
    await createSupabaseSafetyStore({ db: () => db }).recordPlatformCost({ userId: USER, projectId: PROJECT, operation: 'comic.safety.text', model: 'm', costUsd: 0.0002 });
    expect(calls.find((c) => c.method === 'insert')!.args[0]).toMatchObject({ billable_usd: 0, provider_cost_usd: 0.0002, stage: 'safety', is_byok: false });
  });

  it('a duplicate report (unique violation) is reported as deduped', async () => {
    const { db } = fakeDb((table) => (table === 'comic_safety_cases' ? { data: null, error: { code: '23505', message: 'duplicate' } } : { error: null }));
    const out = await createSupabaseSafetyStore({ db: () => db }).openCase({ kind: 'report', projectId: PROJECT, target: { path: 'x' }, reason: 'other', reporterFingerprint: 'a'.repeat(32) });
    expect(out).toEqual({ id: null, deduped: true });
  });

  it('moderation status maps rows; an age lookup error throws (the caller keeps the ceiling)', async () => {
    const { db } = fakeDb((table) => (table === 'user_moderation_status' ? { data: { status: 'suspended' }, error: null } : { data: null, error: { message: 'boom' } }));
    const store = createSupabaseSafetyStore({ db: () => db });
    expect(await store.moderationStatus(USER)).toBe('suspended');
    await expect(store.accountDob(USER)).rejects.toBeTruthy();
  });

  it('restrictUser never downgrades a suspended account', async () => {
    const { db, calls } = fakeDb(() => ({ data: { status: 'suspended' }, error: null }));
    await createSupabaseSafetyStore({ db: () => db }).restrictUser(USER, 'auto');
    expect(calls.some((c) => c.method === 'upsert')).toBe(false);
  });

  it('unconfigured: reads answer safe defaults and writes are no-ops', async () => {
    const store = createSupabaseSafetyStore({
      db: () => {
        throw new Error('no service key');
      }
    });
    expect(store.configured).toBe(false);
    expect(await store.moderationStatus(USER)).toBe('active');
    expect(await store.accountDob(USER)).toBeNull();
    expect(await store.strikes(USER, 0)).toEqual([]);
    expect(await store.openCase({ kind: 'auto', projectId: PROJECT, target: {}, reason: 'x' })).toEqual({ id: null, deduped: false });
    await expect(store.recordEvent({ surface: 'message', layer: 'prefilter', decision: 'allow', categories: [], severity: 0 })).resolves.toBeUndefined();
  });
});
