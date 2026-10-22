// @vitest-environment node
//
// P0-SEC: the image proxy (GET /api/system/image-url) must never sign a Comic Studio (v4)
// project path for anyone but its owner (drafts, render history and sheets all live under
// u/<owner>/p/<pid>/...), reference uploads (.../ref/...) are owner-only for every project,
// and classic public projects keep working. The owner is identified only by the verified
// bearer token.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

type Row = Record<string, unknown>;

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STRANGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V4 = '11111111-1111-4111-8111-111111111111';
const CLASSIC = '22222222-2222-4222-8222-222222222222';
const PRIVATE_CLASSIC = '33333333-3333-4333-8333-333333333333';
const FORCED_CLASSIC = '44444444-4444-4444-8444-444444444444';

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  tokens: {} as Record<string, string>,
  signed: [] as string[],
  signedWith: [] as { bucket: string; path: string; ttl: number }[]
}));

vi.mock('../services/supabase.js', () => {
  class Query {
    private filters: ((r: Record<string, unknown>) => boolean)[] = [];
    private single = false;
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(col: string, value: unknown) {
      this.filters.push((r) => r[col] === value);
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    then<T>(resolve: (v: { data: unknown; error: unknown }) => T) {
      const rows = (db.tables[this.table] || []).filter((r) => this.filters.every((f) => f(r)));
      return Promise.resolve(resolve({ data: this.single ? rows[0] ?? null : rows, error: null }));
    }
  }
  const admin = {
    from: (table: string) => new Query(table),
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number) => {
          db.signed.push(path);
          db.signedWith.push({ bucket, path, ttl });
          return { data: { signedUrl: `https://signed.example/${path}` }, error: null };
        }
      })
    }
  };
  return {
    supabase: {
      auth: {
        // Only a token the auth server verifies maps to a user id.
        getUser: async (token: string) =>
          db.tokens[token] ? { data: { user: { id: db.tokens[token] } }, error: null } : { data: { user: null }, error: { message: 'invalid' } }
      }
    },
    getSupabaseAdmin: () => admin,
    getSupabaseCapabilityStatus: () => ({}),
    checkSupabaseReachability: async () => ({ reachable: true, latencyMs: 0 })
  };
});

const { systemRouter } = await import('./system.js');

const app = express();
app.use('/api/system', systemRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  db.signed = [];
  db.signedWith = [];
  db.tokens = { 'owner-token': OWNER, 'stranger-token': STRANGER };
  const project = (id: string, extra: Row = {}): Row => ({
    id,
    user_id: OWNER,
    is_public: true,
    is_forced_private: false,
    state: {},
    ...extra
  });
  db.tables = {
    projects: [
      project(V4, { state: { studioVersion: 4 } }),
      project(CLASSIC),
      project(PRIVATE_CLASSIC, { is_public: false }),
      project(FORCED_CLASSIC, { is_forced_private: true })
    ],
    comic_docs: [{ project_id: V4, user_id: OWNER }],
    image_assets: []
  };
});

const fetchImage = (path: string, token?: string) =>
  fetch(`${base}/api/system/image-url?path=${encodeURIComponent(path)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });

const v4Path = (rest: string) => `u/${OWNER}/p/${V4}/${rest}`;
const classicPath = (rest: string, pid = CLASSIC) => `u/${OWNER}/p/${pid}/${rest}`;

describe('image proxy: Comic Studio v4 projects are owner-only', () => {
  // The v4 project is even marked public here: the live draft paths must still never leak.
  const v4Paths = [v4Path('img/draft-page.webp'), v4Path('img/history-old-render.webp'), v4Path('img/sheet.webp'), v4Path('ref/photo.webp')];

  it.each(v4Paths)('denies a signed-in non-owner %s with 403', async (path) => {
    const res = await fetchImage(path, 'stranger-token');
    expect(res.status).toBe(403);
    expect(db.signed).toEqual([]);
  });

  it.each(v4Paths)('denies an anonymous reader %s', async (path) => {
    const res = await fetchImage(path);
    expect(res.status).toBe(401);
    expect(db.signed).toEqual([]);
  });

  it('allows the owner (identified by the verified token)', async () => {
    const res = await fetchImage(v4Path('img/draft-page.webp'), 'owner-token');
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain('draft-page.webp');
  });

  it('never trusts an identity from the query string or an unverified token', async () => {
    const forged = await fetch(
      `${base}/api/system/image-url?path=${encodeURIComponent(v4Path('img/draft-page.webp'))}&userId=${OWNER}&user_id=${OWNER}`,
      { headers: { authorization: 'Bearer not-a-real-token', 'x-user-id': OWNER } }
    );
    expect(forged.status).toBe(401);
    expect(db.signed).toEqual([]);
  });

  it('stays denied when the v4 project is private', async () => {
    db.tables.projects[0].is_public = false;
    expect((await fetchImage(v4Path('img/p1.webp'), 'stranger-token')).status).toBe(403);
  });
});

describe('image proxy: reference uploads are owner-only for every project', () => {
  it('denies a public classic project ref path to non-owners', async () => {
    expect((await fetchImage(classicPath('ref/photo.webp'), 'stranger-token')).status).toBe(403);
    expect((await fetchImage(classicPath('ref/photo.webp'))).status).toBe(401);
    expect(db.signed).toEqual([]);
  });

  it('allows the owner their own ref path', async () => {
    expect((await fetchImage(classicPath('ref/photo.webp'), 'owner-token')).status).toBe(200);
  });
});

describe('image proxy: classic projects keep the public rule', () => {
  it('allows anyone to read a public classic project path', async () => {
    expect((await fetchImage(classicPath('img/panel.webp'))).status).toBe(200);
    expect((await fetchImage(classicPath('img/panel.webp'), 'stranger-token')).status).toBe(200);
    expect(db.signed).toEqual([classicPath('img/panel.webp'), classicPath('img/panel.webp')]);
  });

  it('denies a private classic project path to non-owners', async () => {
    expect((await fetchImage(classicPath('img/panel.webp', PRIVATE_CLASSIC), 'stranger-token')).status).toBe(403);
    expect((await fetchImage(classicPath('img/panel.webp', PRIVATE_CLASSIC))).status).toBe(401);
  });

  it('denies a force-private classic project path to non-owners', async () => {
    expect((await fetchImage(classicPath('img/panel.webp', FORCED_CLASSIC), 'stranger-token')).status).toBe(403);
  });

  it('denies a path whose namespace is not the project owner', async () => {
    const foreign = `u/${STRANGER}/p/${CLASSIC}/img/panel.webp`;
    expect((await fetchImage(foreign, 'owner-token')).status).toBe(403);
  });

  it('returns 404 for an unknown project', async () => {
    const unknown = `u/${OWNER}/p/99999999-9999-4999-8999-999999999999/img/panel.webp`;
    expect((await fetchImage(unknown, 'stranger-token')).status).toBe(404);
  });
});

describe('image proxy: tmp lane and asset lookups ignore v4 rows', () => {
  it('a public v4 listing state never authorizes a tmp path', async () => {
    const tmp = `u/${OWNER}/tmp/cover.webp`;
    db.tables.projects[0].state = { studioVersion: 4, coverImageId: tmp };
    expect((await fetchImage(tmp, 'stranger-token')).status).toBe(403);
    // A classic public project that references the same tmp path still serves it.
    db.tables.projects[1].state = { coverImageId: tmp };
    expect((await fetchImage(tmp, 'stranger-token')).status).toBe(200);
  });

  it('an image_assets row of a v4 project is owner-only', async () => {
    const odd = 'library/shared/odd-shape.webp';
    db.tables.image_assets = [{ path: odd, user_id: OWNER, project_id: V4 }];
    expect((await fetchImage(odd, 'stranger-token')).status).toBe(403);
    db.tables.image_assets = [{ path: odd, user_id: OWNER, project_id: CLASSIC }];
    expect((await fetchImage(odd, 'stranger-token')).status).toBe(200);
  });
});

describe('image proxy: dot-segment / encoding traversal', () => {
  // storage-js puts the path into the request URL unencoded, and URL parsing collapses dot
  // segments — percent-encoded ones too — so these would be authorized as one path and
  // signed as another (another user's ref, or a v4 draft).
  const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const attacks = [
    `u/${STRANGER}/%2e%2e/${OWNER}/p/${V4}/ref/photo.webp`,
    `u/${STRANGER}/%2E%2E/${OWNER}/p/${V4}/img/draft.webp`,
    `u/${STRANGER}/.%2e/${OWNER}/p/${V4}/img/draft.webp`,
    `u/${STRANGER}/tmp/%2e%2e/%2e%2e/${OWNER}/p/${V4}/img/draft.webp`,
    classicPath(`img/%2e%2e/ref/photo.webp`),
    classicPath(`%2e%2e/${V4}/img/draft.webp`),
    `u/${STRANGER}/./../${OTHER}/x.webp`,
    `u/${STRANGER}/p/${CLASSIC}/./ref/photo.webp`,
    `u/${STRANGER}//p/${V4}/img/draft.webp`,
    classicPath('img/a.webp?/x'),
    classicPath('img/a.webp#x'),
    classicPath('img/a%00.webp')
  ];

  it.each(attacks)('refuses %s before signing anything', async (path) => {
    const res = await fetchImage(path, 'stranger-token');
    expect(res.status).toBe(400);
    expect(db.signed).toEqual([]);
  });

  it('still signs a plain classic public path', async () => {
    const res = await fetchImage(classicPath('img/page-1.webp'), 'stranger-token');
    expect(res.status).toBe(200);
    expect(db.signed).toEqual([classicPath('img/page-1.webp')]);
  });
});

describe('image proxy: bucket routing (P1-STORAGE, contract §12.5)', () => {
  const ref = (owner = OWNER, pid = V4) => `u/${owner}/p/${pid}/ref/photo.webp`;

  it('signs an owner ref from the PRIVATE bucket for 5 minutes, never cached', async () => {
    const res = await fetchImage(ref(), 'owner-token');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ path: ref(), expiresIn: 300 });
    expect(db.signedWith).toEqual([{ bucket: 'comic-private', path: ref(), ttl: 300 }]);
  });

  it('signs generated art from the public bucket with the usual TTL', async () => {
    const res = await fetchImage(v4Path('img/page.webp'), 'owner-token');
    expect(await res.json()).toMatchObject({ expiresIn: 1800 });
    expect(db.signedWith).toEqual([{ bucket: 'comic-assets', path: v4Path('img/page.webp'), ttl: 1800 }]);
  });

  it('a ref under a non-UUID project id is still owner-only (decided by its namespace, not the project)', async () => {
    const odd = `u/${OWNER}/p/not-a-uuid/ref/photo.webp`;
    // Even an image_assets row pointing at a PUBLIC classic project cannot open it.
    db.tables.image_assets = [{ path: odd, user_id: OWNER, project_id: CLASSIC }];
    expect((await fetchImage(odd, 'stranger-token')).status).toBe(403);
    expect((await fetchImage(odd)).status).toBe(401);
    expect(db.signed).toEqual([]);
    expect((await fetchImage(odd, 'owner-token')).status).toBe(200);
    expect(db.signedWith[0]).toMatchObject({ bucket: 'comic-private', ttl: 300 });
  });

  it('refs of a public classic project and of another owner are denied', async () => {
    expect((await fetchImage(ref(OWNER, CLASSIC), 'stranger-token')).status).toBe(403);
    expect((await fetchImage(ref(STRANGER, CLASSIC), 'owner-token')).status).toBe(403);
    expect(db.signed).toEqual([]);
  });

  it('quarantine is never signed here, not even for its owner', async () => {
    const q = `q/${OWNER}/${V4}/bad-0123abcd.webp`;
    expect((await fetchImage(q, 'owner-token')).status).toBe(403);
    expect((await fetchImage(q, 'stranger-token')).status).toBe(403);
    expect((await fetchImage(q)).status).toBe(401);
    expect(db.signed).toEqual([]);
  });

  it('opaque publication copies and the versioned library are public', async () => {
    const pub = 'pub/Ab3dEf6hIj9kLm2nOp5qRs/p1-0123456789ab.webp';
    expect((await fetchImage(pub)).status).toBe(200);
    expect((await fetchImage('library/v1/style.noir-ink/1@320.webp')).status).toBe(200);
    expect(db.signedWith.map((c) => c.bucket)).toEqual(['comic-assets', 'comic-assets']);
    // A malformed pub key is not the publication lane.
    expect((await fetchImage('pub/short/p1.webp')).status).toBe(401);
  });

  it('keeps the P0-SEC traversal guard in front of the bucket rules', async () => {
    for (const attack of [
      `u/${STRANGER}/%2e%2e/${OWNER}/p/${V4}/ref/photo.webp`,
      `pub/Ab3dEf6hIj9kLm2nOp5qRs/%2e%2e/%2e%2e/u/${OWNER}/p/${V4}/ref/photo.webp`,
      `library/v1/../../u/${OWNER}/p/${V4}/ref/photo.webp`,
      `q/${OWNER}/./x.webp`
    ]) {
      expect((await fetchImage(attack, 'stranger-token')).status).toBe(400);
    }
    expect(db.signed).toEqual([]);
  });
});
