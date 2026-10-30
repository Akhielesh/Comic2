// Safety HTTP surface: reports (always 202, Turnstile, no oracle), owner appeals, moderator cases.
import express, { type Express, type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender } from '../../../shared/comic/doc.js';
import { fakeAssetStore, newSession, plannedDoc, testContext } from '../comic/orchestrator.fakes.js';
import { installSafetyFakes, resetSafety, type SafetyFakes } from '../comic/safety/testkit.js';
import { createComicModerationRouter, createComicReportRouter, createComicSafetyRouter, parseTarget, reporterFingerprint } from './comicSafety.js';

let fakes: SafetyFakes;
let assets: ReturnType<typeof fakeAssetStore>;
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  assets = fakeAssetStore();
  fakes = installSafetyFakes({ assets });
});
afterEach(() => {
  resetSafety();
  vi.restoreAllMocks();
});

const asUser = (id?: string): RequestHandler => (req, _res, next) => {
  if (id) (req as { user?: { id: string } }).user = { id };
  next();
};

async function serve(app: Express, fn: (base: string) => Promise<void>) {
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/comic/public/s/:slug/report', () => {
  const app = (opts: { human?: boolean; record?: ReturnType<typeof vi.fn>; user?: string } = {}) => {
    const a = express();
    a.use(express.json());
    a.use(asUser(opts.user));
    a.use('/api/comic/public/s', createComicReportRouter({ verifyTurnstile: async () => opts.human !== false, salt: 'test-salt', ...(opts.record ? { recordReport: opts.record as never } : {}) }));
    return a;
  };

  it('answers the same 202 for an unknown slug, a malformed one and a real one', async () => {
    const record = vi.fn(async (_report: unknown) => undefined);
    await serve(app({ record }), async (base) => {
      const bodies = await Promise.all(
        ['AbCdEfGhIjKlMnOpQ', 'ZZZZZZZZZZZZZZZZZ', 'x'].map(async (slug) => {
          const res = await post(`${base}/api/comic/public/s/${slug}/report`, { reason: 'violent', pageN: 2, note: 'too gory' });
          return [res.status, await res.text()];
        })
      );
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(bodies[0]).toEqual([202, '{"ok":true}']);
    });
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(3));
    expect(record.mock.calls[0][0]).toMatchObject({ slug: 'AbCdEfGhIjKlMnOpQ', reason: 'violent', page: 2, note: 'too gory', ipHash: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it('refuses a failed Turnstile check and an unknown reason (independent of the slug)', async () => {
    await serve(app({ human: false }), async (base) => {
      const res = await post(`${base}/api/comic/public/s/AbCdEfGhIjKlMnOpQ/report`, { reason: 'other' });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('CAPTCHA');
    });
    await serve(app(), async (base) => {
      const res = await post(`${base}/api/comic/public/s/AbCdEfGhIjKlMnOpQ/report`, { reason: 'because' });
      expect(res.status).toBe(400);
    });
  });

  it('records the signed-in reporter instead of the IP fingerprint path', async () => {
    const record = vi.fn(async (_report: unknown) => undefined);
    await serve(app({ record, user: 'reader-1' }), async (base) => {
      await post(`${base}/api/comic/public/s/AbCdEfGhIjKlMnOpQ/report`, { reason: 'hateful', note: 'x'.repeat(900) });
    });
    await vi.waitFor(() => expect(record).toHaveBeenCalled());
    expect(record.mock.calls[0][0]).toMatchObject({ reporterUserId: 'reader-1' });
    expect((record.mock.calls[0][0] as { note: string }).note).toHaveLength(300);
  });

  it('fingerprints rotate daily and never contain the IP', () => {
    const a = reporterFingerprint('203.0.113.9', 's', Date.UTC(2026, 9, 22));
    const b = reporterFingerprint('203.0.113.9', 's', Date.UTC(2026, 9, 23));
    expect(a).not.toBe(b);
    expect(a).not.toContain('203');
  });
});

describe('POST /api/comic/projects/:id/safety-review (owner appeal)', () => {
  it('validates the target, runs the appeal and posts the result into the conversation', async () => {
    const doc = plannedDoc();
    doc.settings.rating = 'PG';
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1, safety: { assessed: 'PG-13', at: 1 } } };
    const ctx = testContext(newSession(doc));
    fakes.llm.script.writer = [{ rating: 'PG', categories: [], notes: [], photo: false, minorLikely: false, subject: 'other', view: 'none', caption: '', multipleSubjects: false }];
    const contextFor = vi.fn(async () => ctx);
    const a = express();
    a.use(express.json());
    a.use(asUser('user-1'));
    a.use('/api/comic', createComicSafetyRouter({ contextFor }));
    await serve(a, async (base) => {
      const bad = await post(`${base}/api/comic/projects/proj-1/safety-review`, { target: { kind: 'page', id: '../../etc' } });
      expect(bad.status).toBe(400);
      const res = await post(`${base}/api/comic/projects/proj-1/safety-review`, { target: { kind: 'page', id: 'pg_1' }, note: 'it is cartoon slapstick' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'cleared', rating: 'PG' });
    });
    expect(ctx.session.doc.conversation.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringMatching(/Second look/) });
  });

  it('a suspended account cannot ask for (platform-paid) second looks', async () => {
    fakes.store.statuses.set('user-9', 'suspended');
    const contextFor = vi.fn();
    const a = express();
    a.use(express.json());
    a.use(asUser('user-9'));
    a.use('/api/comic', createComicSafetyRouter({ contextFor }));
    await serve(a, async (base) => {
      const res = await post(`${base}/api/comic/projects/proj-1/safety-review`, { target: { kind: 'cover' } });
      expect(res.status).toBe(403);
    });
    expect(contextFor).not.toHaveBeenCalled();
    expect(fakes.llm.calls).toHaveLength(0);
  });

  it('needs a signed-in user', async () => {
    const a = express();
    a.use(express.json());
    a.use('/api/comic', createComicSafetyRouter({ contextFor: vi.fn() }));
    await serve(a, async (base) => {
      expect((await post(`${base}/api/comic/projects/proj-1/safety-review`, { target: { kind: 'cover' } })).status).toBe(401);
    });
  });

  it('parseTarget accepts only well-formed render targets', () => {
    expect(parseTarget({ kind: 'cover' })).toEqual({ kind: 'cover' });
    expect(parseTarget({ kind: 'sheet', id: 'c_maya' })).toEqual({ kind: 'sheet', id: 'c_maya' });
    expect(parseTarget({ kind: 'page', id: 'a/b' })).toBeNull();
    expect(parseTarget({ kind: 'text' })).toBeNull();
  });
});

describe('/api/moderation/comic-cases (moderators)', () => {
  const PROJECT = '22222222-2222-4222-8222-222222222222';
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use(asUser('mod-1'));
    a.use('/api/moderation/comic-cases', createComicModerationRouter());
    return a;
  };

  it('lists open cases without reporter identities, signs a 5-minute URL and resolves (audited)', async () => {
    fakes.store.projects.set(PROJECT, { ownerUserId: 'owner-1', name: 'Spice Run', isForcedPrivate: false });
    const opened = await fakes.store.openCase({ kind: 'report', projectId: PROJECT, ownerUserId: 'owner-1', reporterFingerprint: 'f'.repeat(32), target: { page: 1, path: 'u/o/p/x/img/a.webp' }, reason: 'violent', note: '<b>gory</b>' });
    await serve(app(), async (base) => {
      const list = await (await fetch(`${base}/api/moderation/comic-cases`)).json();
      expect(list.cases).toHaveLength(1);
      expect(list.cases[0]).toMatchObject({ id: opened.id, kind: 'report', projectName: 'Spice Run', reporter: 'anonymous', note: '<b>gory</b>', target: { page: 1, hasAsset: true } });
      expect(JSON.stringify(list)).not.toContain('f'.repeat(32));

      const asset = await fetch(`${base}/api/moderation/comic-cases/${opened.id}/asset`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toBe('private, no-store');
      expect((await asset.json()).url).toBe('https://signed.test/u/o/p/x/img/a.webp');
      expect(fakes.audits.at(-1)).toMatchObject({ action: 'comic.safety.asset_view', actorId: 'mod-1' });

      expect((await post(`${base}/api/moderation/comic-cases/${opened.id}/resolve`, { action: 'nuke', reason: 'x' })).status).toBe(400);
      expect((await post(`${base}/api/moderation/comic-cases/${opened.id}/resolve`, { action: 'force_private' })).status).toBe(400);
      const res = await post(`${base}/api/moderation/comic-cases/${opened.id}/resolve`, { action: 'force_private', reason: 'repeated gore' });
      expect(res.status).toBe(200);
      expect((await res.json()).case.status).toBe('resolved');
      expect(fakes.store.projects.get(PROJECT)?.isForcedPrivate).toBe(true);
      expect(fakes.audits.at(-1)).toMatchObject({ action: 'comic.safety.resolve' });

      expect((await fetch(`${base}/api/moderation/comic-cases/not-a-uuid/asset`)).status).toBe(404);
      const closed = await (await fetch(`${base}/api/moderation/comic-cases?status=resolved`)).json();
      expect(closed.cases[0]).toMatchObject({ status: 'resolved', resolution: 'force_private: repeated gore' });
    });
  });
});
