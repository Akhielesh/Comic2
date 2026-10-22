// Wave-0 server stubs (buildplan §10): final signatures, inert behaviour.
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc, RefAsset } from '../../../shared/comic/doc.js';
import { ASSET_KEY_RE, SLUG_RE } from '../../../shared/comic/publication.js';
import { castOpsForUncast, findUncastBeings } from './castScan.js';
import { fitToAspect } from './derive.js';
import { estimateTranslation, runTranslation } from './i18n/index.js';
import { measureImage } from './imageMeasure.js';
import { routeIntent } from './intents.js';
import { createLibraryAdminRouter, createLibraryPublicRouter } from './library/index.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import {
  buildPublicSnapshot,
  getPublicationView,
  loadPublicByProjectId,
  newAssetKey,
  newSlug,
  publish,
  renderOgImage,
  unpublish
} from './publication/index.js';
import { addRefs, applyAttachmentTargets, carriedImages, refIntentHint, takeInbox } from './refs/index.js';
import {
  accountCeilingFor,
  checkRenderSafety,
  cooldownFor,
  isServableToOwner,
  onRenderVerdict,
  prefilterText,
  requireActiveUser,
  respondBlocked,
  runPublishGate,
  screenPatch,
  screenTurnInput,
  screenUploadPreview,
  verdictFromVision
} from './safety/index.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const ref = (n: number): RefAsset => ({ path: `u/user-1/p/proj-1/ref/r${n}.webp`, source: 'upload', at: n });

describe('safety stubs: allow / unchecked', () => {
  it('never blocks, never spends', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    expect(prefilterText('anything', 'PG-13')).toEqual({ decision: 'clear', categories: [], ip: [] });
    expect(await screenTurnInput(ctx, { text: 'hi', attachments: [], rating: 'G' })).toMatchObject({ decision: 'allow', strike: 0, blockedAttachmentPaths: [] });
    await expect(screenPatch(ctx, [], 'PG')).resolves.toBeUndefined();
    expect(await screenUploadPreview(ctx, Buffer.from('x'), 'upload')).toEqual({ decision: 'allow' });
    expect(await checkRenderSafety(ctx, { kind: 'cover' }, ref(1))).toBeUndefined();
    expect(verdictFromVision({ safety: { rating: 'X' } })).toBeUndefined();
    await expect(onRenderVerdict(ctx, { kind: 'cover' }, ref(1), undefined)).resolves.toBeUndefined();
    expect(await accountCeilingFor('user-1')).toBe('PG-13');
    expect(await cooldownFor('user-1')).toBeNull();
    expect(ctx.billingFake.reserves).toEqual([]);
  });

  it('isServableToOwner hides only blocked assets', () => {
    expect(isServableToOwner(undefined)).toBe(true);
    expect(isServableToOwner(ref(1))).toBe(true);
    expect(isServableToOwner({ ...ref(1), safety: { pending: true, at: 1 } as never })).toBe(true);
  });

  it('the publish gate answers needs_check with every requested page unchecked', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    const gate = await runPublishGate(ctx, ctx.session.doc, { pageIds: ['pg_1', 'pg_2'], includeCover: true, languages: ['en'] });
    expect(gate).toMatchObject({ status: 'needs_check', costUsd: 0, cover: { status: 'unchecked' } });
    expect(Object.keys(gate.pages)).toEqual(['pg_1', 'pg_2']);
  });

  it('requireActiveUser lets everyone through; respondBlocked always speaks', async () => {
    const next = vi.fn();
    requireActiveUser()({} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
    const session = newSession(plannedDoc());
    await respondBlocked(testContext(session), { userMsgId: 'm1' }, { decision: 'block', categories: [], strike: 1, blockedAttachmentPaths: [] });
    expect(session.doc.conversation.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringMatching(/\S/) });
  });
});

describe('publication stubs', () => {
  it('every operation is NOT_AVAILABLE; the legacy public read finds nothing', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    await expect(getPublicationView(ctx)).rejects.toMatchObject({ code: 'NOT_AVAILABLE', status: 501 });
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(unpublish(ctx)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(() => buildPublicSnapshot(ctx.session.doc, { assetKey: newAssetKey(), pageIds: [], includeCover: false, languages: [], paths: {} })).toThrow();
    await expect(renderOgImage({ title: 't', subtitle: '', kindLabel: 'Comic', pageCount: 1, lang: 'en', coverBuf: null, fallbackPageBuf: null, showMark: true })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(await loadPublicByProjectId('proj-1')).toBeNull();
  });

  it('mints slugs and asset keys of the contract shape, never repeating', () => {
    const slugs = new Set(Array.from({ length: 300 }, () => newSlug()));
    expect(slugs.size).toBe(300);
    for (const s of slugs) expect(s).toMatch(SLUG_RE);
    const keys = Array.from({ length: 50 }, () => newAssetKey());
    for (const k of keys) expect(k).toMatch(ASSET_KEY_RE);
  });
});

describe('refs stubs: honest minimal', () => {
  const docWithMaya = (refs: number): ComicDoc => {
    const doc = plannedDoc();
    doc.cast[0].refs = Array.from({ length: refs }, (_, i) => ref(100 + i));
    return doc;
  };

  it('adds up to the cap and says how many were added', async () => {
    const ctx = testContext(newSession(docWithMaya(8)));
    const out = await addRefs(ctx, { kind: 'character', id: 'c_maya' }, [1, 2, 3, 4, 5, 6].map(ref));
    expect(out).toMatchObject({ added: 4, skipped: 2, message: 'Added 4 of 6 photos to MAYA (limit 12).' });
    ctx.session.commit(out.ops);
    expect(ctx.session.doc.cast[0].refs).toHaveLength(12);
  });

  it('keeps every photo when there is room, main photo first, and skips duplicates', async () => {
    const ctx = testContext(newSession(docWithMaya(1)));
    const out = await addRefs(ctx, { kind: 'character', id: 'c_maya' }, [ref(100), ref(1), ref(2), ref(3), ref(4), ref(5)], { mainIndex: 3 });
    expect(out.added).toBe(5);
    expect(out.message).toBe('Added 5 photos to MAYA (1 already there).');
    ctx.session.commit(out.ops);
    expect(ctx.session.doc.cast[0].refs[0].path).toBe(ref(3).path);
    expect(ctx.session.doc.cast[0].refs).toHaveLength(6);
  });

  it('is honest when nothing fits or the owner is gone', async () => {
    const ctx = testContext(newSession(docWithMaya(12)));
    expect((await addRefs(ctx, { kind: 'character', id: 'c_maya' }, [ref(1)])).message).toMatch(/already has 12 reference images/);
    expect((await addRefs(ctx, { kind: 'character', id: 'nope' }, [ref(1)])).message).toMatch(/no longer exists/);
  });

  it('takeInbox moves inbox refs into attachments and refuses foreign paths', async () => {
    const doc = plannedDoc();
    doc.refInbox = [ref(1), ref(2)];
    const ctx = testContext(newSession(doc));
    const out = await takeInbox(ctx, [ref(2).path, ref(1).path]);
    expect(out.attachments.map((a) => a.path)).toEqual([ref(2).path, ref(1).path]);
    expect(out.ops).toEqual([
      { op: 'ref_remove', owner: { kind: 'inbox' }, path: ref(2).path },
      { op: 'ref_remove', owner: { kind: 'inbox' }, path: ref(1).path }
    ]);
    await expect(takeInbox(ctx, ['u/other/p/x/ref/evil.webp'])).rejects.toMatchObject({ status: 400 });
  });

  it('applyAttachmentTargets files images on owners and creates a new character once', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    const out = await applyAttachmentTargets(ctx, [ref(1), ref(2), ref(3), ref(4)], [
      { kind: 'new_character', name: 'Bunny', castKind: 'animal' },
      { kind: 'new_character', name: 'bunny' },
      { kind: 'style' },
      null
    ]);
    ctx.session.commit(out.ops);
    const bunny = ctx.session.doc.cast.find((c) => c.name === 'Bunny')!;
    expect(bunny).toMatchObject({ kind: 'animal' });
    expect(bunny.refs.map((r) => r.path)).toEqual([ref(1).path, ref(2).path]);
    expect(ctx.session.doc.style.refs.map((r) => r.path)).toEqual([ref(3).path]);
    expect(out.note).toMatch(/Added BUNNY to the cast/);
  });

  it('carries nothing yet', () => {
    expect(carriedImages(plannedDoc(), [])).toEqual([]);
    expect(refIntentHint('this is maya', 2)).toBeUndefined();
  });
});

describe('director, i18n and storage helper stubs', () => {
  it('castScan finds nothing; intents never match', () => {
    const doc = plannedDoc();
    expect(findUncastBeings(doc)).toEqual([]);
    expect(castOpsForUncast(doc, [])).toEqual([]);
    expect(routeIntent(doc, 'show me the pages')).toBeNull();
  });

  it('translation is NOT_AVAILABLE', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    await expect(estimateTranslation(ctx, { type: 'translate', languages: ['hi'] })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    await expect(runTranslation(ctx, { type: 'translate', languages: ['hi'] }, { confirmed: true })).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  });

  it('derive is NOT_AVAILABLE; measureImage reads real metadata', async () => {
    await expect(fitToAspect(Buffer.from('x'), '4:5', 'pad')).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    const square = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer();
    const m = await measureImage(square, '4:5');
    expect(m).toMatchObject({ w: 64, h: 64, aspectWanted: '4:5', aspectOk: false, blank: false });
    expect(m.bytes).toBe(square.byteLength);
    expect((await measureImage(square)).aspectOk).toBe(true);
    await expect(measureImage(Buffer.from('not an image'))).rejects.toMatchObject({ status: 400 });
  });

  it('library routers answer 501 NOT_AVAILABLE', async () => {
    const app = express();
    app.use('/pub', createLibraryPublicRouter());
    app.use('/admin', createLibraryAdminRouter());
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ['/pub', '/admin/runs/r1/step']) {
        const res = await fetch(`${base}${path}`, { method: path.includes('step') ? 'POST' : 'GET' });
        expect(res.status).toBe(501);
        expect(await res.json()).toEqual({ error: { message: expect.any(String), code: 'NOT_AVAILABLE' } });
      }
    } finally {
      await new Promise<void>((r) => (server as http.Server).close(() => r()));
    }
  });
});
