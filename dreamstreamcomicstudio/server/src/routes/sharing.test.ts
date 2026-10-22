// @vitest-environment node
//
// P0-SEC: a classic share must never flip is_public on a Comic Studio (v4) comic — those
// publish only from the studio Share sheet — so POST /api/shares answers 409
// USE_STUDIO_SHARE for v4 projects and creates nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STRANGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V4 = '11111111-1111-4111-8111-111111111111';
const CLASSIC = '22222222-2222-4222-8222-222222222222';

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  writes: [] as { table: string; op: string; payload: unknown }[]
}));

vi.mock('../services/supabase.js', () => {
  class Query {
    private filters: ((r: Record<string, unknown>) => boolean)[] = [];
    private isSingle = false;
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: Record<string, unknown> | undefined;
    constructor(private table: string) {}
    select() {
      return this;
    }
    insert(payload: Record<string, unknown>) {
      this.op = 'insert';
      this.payload = payload;
      return this;
    }
    update(payload: Record<string, unknown>) {
      this.op = 'update';
      this.payload = payload;
      return this;
    }
    eq(col: string, value: unknown) {
      this.filters.push((r) => r[col] === value);
      return this;
    }
    is(col: string, value: unknown) {
      this.filters.push((r) => (r[col] ?? null) === value);
      return this;
    }
    maybeSingle() {
      this.isSingle = true;
      return this;
    }
    /** supabase-js `.single()` after insert(...).select() */
    single() {
      return this;
    }
    then<T>(resolve: (v: { data: unknown; error: unknown }) => T) {
      const rows = db.tables[this.table] || (db.tables[this.table] = []);
      if (this.op === 'insert') {
        const row = { id: `share-${rows.length + 1}`, share_token: 'tok', ...this.payload };
        rows.push(row);
        db.writes.push({ table: this.table, op: 'insert', payload: this.payload });
        return Promise.resolve(resolve({ data: row, error: null }));
      }
      const hits = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === 'update') {
        hits.forEach((r) => Object.assign(r, this.payload));
        db.writes.push({ table: this.table, op: 'update', payload: this.payload });
        return Promise.resolve(resolve({ data: null, error: null }));
      }
      return Promise.resolve(resolve({ data: this.isSingle ? hits[0] ?? null : hits, error: null }));
    }
  }
  return { getSupabaseAdmin: () => ({ from: (table: string) => new Query(table) }) };
});

const { sharingRouter, USE_STUDIO_SHARE, FORCED_PRIVATE } = await import('./sharing.js');

let caller: string | null = OWNER;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (caller) req.user = { id: caller };
  next();
});
app.use('/api/shares', sharingRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  caller = OWNER;
  db.writes = [];
  db.tables = {
    projects: [
      { id: V4, user_id: OWNER, is_public: false, state: { studioVersion: 4 } },
      { id: CLASSIC, user_id: OWNER, is_public: false, state: {} }
    ],
    comic_docs: [{ project_id: V4, user_id: OWNER }],
    comic_shares: []
  };
});

const createShare = (body: Record<string, unknown>) =>
  fetch(`${base}/api/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/shares', () => {
  it.each(['public', 'private'])('refuses a %s classic share of a v4 comic with 409 USE_STUDIO_SHARE', async (shareType) => {
    const res = await createShare({ projectId: V4, shareType });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe(USE_STUDIO_SHARE);
    expect(body.error.message).toMatch(/studio Share sheet/);
    // Nothing was written: no share row, and is_public was not flipped.
    expect(db.writes).toEqual([]);
    expect(db.tables.projects[0].is_public).toBe(false);
  });

  it('still answers 403 (not 409) to a non-owner of a v4 comic', async () => {
    caller = STRANGER;
    const res = await createShare({ projectId: V4, shareType: 'public' });
    expect(res.status).toBe(403);
    expect(db.writes).toEqual([]);
  });

  it('keeps classic public shares working (and still flips is_public)', async () => {
    const res = await createShare({ projectId: CLASSIC, shareType: 'public' });
    expect(res.status).toBe(201);
    expect(db.tables.projects[1].is_public).toBe(true);
    expect(db.tables.comic_shares).toHaveLength(1);
  });

  it('requires sign-in', async () => {
    caller = null;
    expect((await createShare({ projectId: CLASSIC, shareType: 'public' })).status).toBe(401);
  });
});

describe('P0-SEC hardening: moderation and v4 through classic shares', () => {
  const FORCED = '33333333-3333-4333-8333-333333333333';
  const share = (id: string, project_id: string, extra: Record<string, unknown> = {}) => ({
    id,
    project_id,
    owner_id: OWNER,
    share_token: `tok-${id}`,
    share_type: 'public',
    revoked_at: null,
    expires_at: null,
    allow_download: false,
    allow_reshare: false,
    ...extra
  });
  const openShare = (token: string) => fetch(`${base}/api/shares/token/${token}`);

  beforeEach(() => {
    db.tables.projects.push({
      id: FORCED,
      user_id: OWNER,
      is_public: false,
      is_forced_private: true,
      forced_private_reason: 'reported content',
      republish_request_status: 'pending',
      state: {}
    });
    (db.tables.projects[1] as Record<string, unknown>).forced_private_reason = null;
    (db.tables.projects[1] as Record<string, unknown>).is_forced_private = false;
    db.tables.comic_shares = [share('s-v4', V4), share('s-classic', CLASSIC), share('s-forced', FORCED)];
  });

  it('refuses to create a share of a force-private comic (409 FORCED_PRIVATE, nothing written)', async () => {
    const res = await createShare({ projectId: FORCED, shareType: 'public' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe(FORCED_PRIVATE);
    expect(db.writes).toEqual([]);
    expect(db.tables.projects[2].is_public).toBe(false);
  });

  it('an existing share link never serves a force-private comic to a non-owner', async () => {
    caller = STRANGER;
    const res = await openShare('tok-s-forced');
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('reported content');
  });

  it('an existing classic share of a v4 comic never returns the listing row (draft cover path)', async () => {
    caller = STRANGER;
    const res = await openShare('tok-s-v4');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe(USE_STUDIO_SHARE);
    expect(body.project).toBeUndefined();
  });

  it('classic shares still open, without moderation bookkeeping', async () => {
    caller = STRANGER;
    const res = await openShare('tok-s-classic');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.id).toBe(CLASSIC);
    expect(Object.keys(body.project).some((k) => k.includes('forced_private') || k.startsWith('republish_'))).toBe(false);
  });
});
