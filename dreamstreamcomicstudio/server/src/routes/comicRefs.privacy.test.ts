// @vitest-environment node
//
// P1-REFS acceptance (buildplan): reference photos are never reachable by non-owners.
// End to end: a photo uploaded through POST /refs lands under the private /ref/ lane, and the image
// proxy then signs it for its owner only (private bucket, 5 minutes) — never for another user, an
// anonymous reader or a share-link holder, whatever the project's public flag says. The public doc
// carries no reference path at all (refs, inbox, attachments, refs cards).
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc.js';
import { KEYS, fakeAssetStore, fakeBilling, fakeDocStore, fakeImages, plannedDoc, scriptedLlm } from '../comic/orchestrator.fakes.js';

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  tokens: {} as Record<string, string>,
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
    in(col: string, values: unknown[]) {
      this.filters.push((r) => values.includes(r[col]));
      return this;
    }
    limit() {
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
          db.signedWith.push({ bucket, path, ttl });
          return { data: { signedUrl: `https://signed.example/${path}` }, error: null };
        }
      })
    }
  };
  return {
    supabase: {
      auth: {
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
const { createComicRefsRouter } = await import('./comicRefs.js');
const { sanitizePublicDoc } = await import('../comic/store.js');
const { __resetSessionsForTests } = await import('../comic/session.js');

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STRANGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT = '11111111-1111-4111-8111-111111111111';

let server: Server;
let base = '';
let uploadedPath = '';

beforeAll(async () => {
  __resetSessionsForTests();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  db.tokens = { 'owner-token': OWNER, 'stranger-token': STRANGER };
  // A PUBLIC project (worst case): its refs must still be owner-only.
  db.tables = {
    projects: [{ id: PROJECT, user_id: OWNER, is_public: true, is_forced_private: false, state: { studioVersion: 4 } }],
    comic_docs: [{ project_id: PROJECT, user_id: OWNER }],
    image_assets: []
  };
  const store = fakeDocStore();
  store.docs.set(PROJECT, { userId: OWNER, doc: plannedDoc(PROJECT), isPublic: true });
  const assets = fakeAssetStore();
  const app = express();
  app.use((req, _res, next) => {
    const auth = req.header('authorization') || '';
    const id = db.tokens[auth.replace(/^Bearer /, '')];
    if (id) (req as unknown as { user: { id: string } }).user = { id };
    next();
  });
  app.use('/api/system', systemRouter);
  app.use(
    '/api/comic',
    createComicRefsRouter({
      store,
      screen: (async () => ({ decision: 'allow' })) as never,
      contextDeps: () => ({ assets, keys: KEYS, llm: scriptedLlm(), images: fakeImages().generate, billing: fakeBilling() })
    })
  );
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#c33' } }).png().toBuffer();
  const res = await fetch(`${base}/api/comic/projects/${PROJECT}/refs?to=character:c_maya`, {
    method: 'POST',
    headers: { authorization: 'Bearer owner-token', 'content-type': 'image/png' },
    body: png
  });
  expect(res.status).toBe(201);
  uploadedPath = (await res.json()).ref.path;
});

afterAll(async () => {
  __resetSessionsForTests();
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const proxy = (path: string, token?: string) =>
  fetch(`${base}/api/system/image-url?path=${encodeURIComponent(path)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('reference photos are never reachable by non-owners', () => {
  it('the upload lands in the private /ref/ lane of its owner', () => {
    expect(uploadedPath).toMatch(new RegExp(`^u/${OWNER}/p/${PROJECT}/ref/[A-Za-z0-9_-]+\\.webp$`));
  });

  it('the image proxy refuses another user and anonymous readers (even on a PUBLIC project)', async () => {
    db.signedWith = [];
    expect((await proxy(uploadedPath, 'stranger-token')).status).toBe(403);
    expect((await proxy(uploadedPath)).status).toBe(401);
    expect((await proxy(uploadedPath, 'not-a-real-token')).status).toBe(401);
    expect(db.signedWith).toEqual([]);
  });

  it('the owner gets a 5-minute URL from the PRIVATE bucket, never cached', async () => {
    db.signedWith = [];
    const res = await proxy(uploadedPath, 'owner-token');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(db.signedWith).toEqual([{ bucket: 'comic-private', path: uploadedPath, ttl: 300 }]);
  });

  it('a stranger cannot upload into (or delete from) someone else’s comic', async () => {
    const res = await fetch(`${base}/api/comic/projects/${PROJECT}/refs?to=style`, {
      method: 'POST',
      headers: { authorization: 'Bearer stranger-token', 'content-type': 'image/png' },
      body: Buffer.from('x')
    });
    expect(res.status).toBe(404);
    const del = await fetch(`${base}/api/comic/projects/${PROJECT}/refs?owner=inbox&path=${encodeURIComponent(uploadedPath)}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer stranger-token' }
    });
    expect(del.status).toBe(404);
  });

  it('the public doc carries no reference path anywhere (refs, inbox, attachments, refs cards)', () => {
    const doc: ComicDoc = plannedDoc(PROJECT);
    const r = (n: number) => ({ path: `u/${OWNER}/p/${PROJECT}/ref/r${n}.webp`, source: 'upload' as const, at: 1, original: { path: `u/${OWNER}/p/${PROJECT}/ref/o${n}.webp` } });
    doc.cast[0].refs = [r(1)];
    doc.places[0].refs = [r(2)];
    doc.style.refs = [r(3)];
    doc.refInbox = [r(4)];
    doc.conversation = [
      { id: 'u1', role: 'user', text: 'hi', at: 1, attachments: [r(5)] },
      { id: 'a1', role: 'assistant', text: 'ok', at: 2, cards: [{ type: 'refs', id: 'c1', owner: { kind: 'character', id: 'c_maya' }, paths: [r(1).path] }] }
    ];
    const json = JSON.stringify(sanitizePublicDoc(doc));
    expect(json).not.toMatch(/\/ref\//);
    expect(json).not.toContain(OWNER);
  });
});
