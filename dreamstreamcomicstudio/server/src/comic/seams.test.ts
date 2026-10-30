// The wave-0 server seams (buildplan §10) with their wave-1 owners landed (P2-AMEND rewrote the stub
// assertions): same signatures, real behaviour — and in a test environment with no platform keys and no
// Supabase, every seam fails SAFE and HONEST (nothing blocks by accident, nothing spends, nothing pretends).
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
import { configurePublication } from './publication/publication.js';
import { createMemoryPublicationStore } from './publication/store.js';
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

describe('safety (P1-SAFETY) without a classifier key', () => {
  it('clean input passes, unavailable checks say so, nothing spends', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    expect(prefilterText('anything', 'PG-13')).toEqual({ decision: 'clear', categories: [], ip: [] });
    expect(prefilterText('Shin-chan dances', 'PG-13').ip).toEqual(['Shin-chan']);
    expect(await screenTurnInput(ctx, { text: 'hi', attachments: [], rating: 'G' })).toMatchObject({ decision: 'allow', strike: 0, blockedAttachmentPaths: [] });
    await expect(screenPatch(ctx, [], 'PG')).resolves.toBeUndefined();
    // No vision key: the upload preview check is honestly "unavailable" (the route decides), never a fake "allow".
    expect(await screenUploadPreview(ctx, Buffer.from('x'), 'upload')).toEqual({ decision: 'unavailable' });
    expect(await checkRenderSafety(ctx, { kind: 'cover' }, ref(1))).toBeUndefined();
    await expect(onRenderVerdict(ctx, { kind: 'cover' }, ref(1), undefined)).resolves.toBeUndefined();
    expect(await accountCeilingFor('user-1')).toBe('PG-13');
    expect(await cooldownFor('user-1')).toBeNull();
    expect(ctx.billingFake.reserves).toEqual([]);
  });

  it('verdictFromVision reads the vision safety block (rating or assessed), ignores junk', () => {
    expect(verdictFromVision({ rating: 'X', categories: ['gore'] }, 'vision-model')).toMatchObject({ assessed: 'X', by: 'qc', model: 'vision-model' });
    expect(verdictFromVision({ assessed: 'G' })).toMatchObject({ assessed: 'G' });
    for (const junk of [undefined, null, 'X', [], { rating: 'NC-17' }, { safety: { rating: 'X' } }]) expect(verdictFromVision(junk)).toBeUndefined();
  });

  it('isServableToOwner hides only blocked assets', () => {
    expect(isServableToOwner(undefined)).toBe(true);
    expect(isServableToOwner(ref(1))).toBe(true);
    expect(isServableToOwner({ ...ref(1), safety: { pending: true, at: 1 } as never })).toBe(true);
  });

  it('the publish gate answers needs_check (never "pass") when pages are undrawn and the text can\'t be checked', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    const gate = await runPublishGate(ctx, ctx.session.doc, { pageIds: ['pg_1', 'pg_2'], includeCover: true, languages: ['en'] });
    expect(gate).toMatchObject({ status: 'needs_check', costUsd: 0, rating: 'PG-13', cover: null, text: { status: 'unchecked' } });
    expect(gate.pages).toEqual({
      pg_1: { status: 'unchecked', reasons: ['Not drawn yet'] },
      pg_2: { status: 'unchecked', reasons: ['Not drawn yet'] }
    });
    expect(ctx.billingFake.reserves).toEqual([]);
  });

  it('requireActiveUser leaves anonymous requests to requireAuth; respondBlocked always speaks', async () => {
    const next = vi.fn();
    requireActiveUser()({} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
    const session = newSession(plannedDoc());
    await respondBlocked(testContext(session), { userMsgId: 'm1' }, { decision: 'block', categories: [], strike: 1, blockedAttachmentPaths: [] });
    expect(session.doc.conversation.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringMatching(/\S/) });
  });
});

describe('publication (P1-PUBLISH) on the in-memory store', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('an undrawn comic is private with honest readiness; publish refuses NOT_READY (422); nothing is public', async () => {
    const store = createMemoryPublicationStore();
    const ctx = testContext(newSession(plannedDoc()));
    store.seedProject(ctx.session.doc.id, ctx.userId);
    restore = configurePublication({ store, publicUrl: (p) => `https://cdn.test/${p}` });
    const view = await getPublicationView(ctx);
    expect(view).toMatchObject({ visibility: 'private', status: null, readiness: { ok: false, drawnPages: 0, plannedPages: 3 } });
    expect(view.readiness.missing.filter((m) => m.kind === 'page')).toHaveLength(3);
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 422, reason: 'NOT_READY', message: expect.stringMatching(/Draw at least one page/) });
    expect(store.rows.size).toBe(0);
    expect(await loadPublicByProjectId(ctx.session.doc.id)).toBeNull();
    // Unpublishing something that was never published is an idempotent no-op that reports "private".
    expect(await unpublish(ctx)).toMatchObject({ visibility: 'private', status: null });
    expect(store.rows.size).toBe(0);
    expect(ctx.billingFake.reserves).toEqual([]);
  });

  it('the snapshot is the §9.3 allow-list (no conversation, memory, spend or source); the OG card is a real 1200×630 JPEG', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    const snap = buildPublicSnapshot(ctx.session.doc, { assetKey: newAssetKey(), pageIds: [], includeCover: false, languages: [], paths: {} });
    for (const k of ['memory', 'safety', 'publication', 'planInputHash', 'refInbox', 'archive', 'trash']) expect(k in snap, k).toBe(false);
    expect(snap.conversation).toEqual([]);
    expect(snap.pages).toEqual([]);
    const og = await renderOgImage({ title: 't', subtitle: '', kindLabel: 'Comic', pageCount: 1, lang: 'en', coverBuf: null, fallbackPageBuf: null, showMark: true });
    expect([og.w, og.h]).toEqual([1200, 630]);
    expect((await sharp(og.jpeg).metadata()).format).toBe('jpeg');
    expect(og.themeColor).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('mints slugs and asset keys of the contract shape, never repeating', () => {
    const slugs = new Set(Array.from({ length: 300 }, () => newSlug()));
    expect(slugs.size).toBe(300);
    for (const s of slugs) expect(s).toMatch(SLUG_RE);
    const keys = Array.from({ length: 50 }, () => newAssetKey());
    for (const k of keys) expect(k).toMatch(ASSET_KEY_RE);
  });
});

describe('refs (P1-REFS): honest adds, caps and inbox moves', () => {
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

  it('carries nothing without images; refIntentHint resolves cast names only when given the doc (P2-AMEND §12.8)', () => {
    expect(carriedImages(plannedDoc(), [])).toEqual([]);
    expect(refIntentHint('this is maya', 2)).toBeUndefined();
    expect(refIntentHint('this is maya', 2, plannedDoc())).toBe('(software, may be wrong) images 1–2 → MAYA (existing, 0 refs).');
  });
});

describe('director, i18n, derive, measure and library seams (real)', () => {
  it('castScan finds no uncast beings in a fully cast plan; "show me the pages" is answered by software ($0)', () => {
    const doc = plannedDoc();
    expect(findUncastBeings(doc)).toEqual([]);
    expect(castOpsForUncast(doc, [])).toEqual([]);
    const routed = routeIntent(doc, 'show me the pages');
    expect(routed).toMatchObject({ kind: 'show_pages', reply: expect.stringMatching(/^Here are the pages: 3 pages/) });
    expect(routed!.cards).toEqual([expect.objectContaining({ type: 'breakdown', view: 'plan' })]);
    // The "draw" chip carries its quote so the server re-gates instead of billing blind.
    expect(routed!.nextSteps?.[0]).toMatchObject({ action: { type: 'render_pages', pageIds: ['pg_1', 'pg_2', 'pg_3'], quotedUsd: expect.any(Number) } });
    expect(routeIntent(doc, 'draw a dragon on page 2')).toBeNull();
  });

  it('translation quotes without spending and refuses unknown languages honestly', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    const est = await estimateTranslation(ctx, { type: 'translate', languages: ['hi'] });
    expect(est).toMatchObject({ imageCount: 0, lines: [{ label: 'Hindi', usd: expect.any(Number) }] });
    expect(est.usd).toBeGreaterThan(0);
    expect(est.usd).toBeLessThan(0.05);
    await expect(estimateTranslation(ctx, { type: 'translate', languages: ['xx-bogus'] })).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    const run = await runTranslation(ctx, { type: 'translate', languages: ['xx-bogus'] }, { confirmed: true });
    expect(run.outcome).toMatchObject({ status: 'blocked', code: 'BAD_REQUEST', message: expect.stringMatching(/don't know xx-bogus/) });
    expect(ctx.billingFake.reserves).toEqual([]);
  });

  it('derive pads to the requested aspect (free) and rejects unreadable input; measureImage reads real metadata', async () => {
    await expect(fitToAspect(Buffer.from('x'), '4:5', 'pad')).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    const patch = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#ffcc00' } }).png().toBuffer();
    const pic = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#336699' } }).composite([{ input: patch, left: 20, top: 20 }]).png().toBuffer();
    const fitted = await fitToAspect(pic, '4:5', 'pad');
    expect(fitted).toMatchObject({ mime: 'image/webp', w: 160, h: 200 });
    expect((await sharp(fitted.buffer).metadata()).format).toBe('webp');
    const square = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer();
    const m = await measureImage(square, '4:5');
    // A uniform grey square is flagged blank (a failed render, never billed as art).
    expect(m).toMatchObject({ w: 64, h: 64, aspectWanted: '4:5', aspectOk: false, blank: true, palette: ['#808080'] });
    expect(m.bytes).toBe(square.byteLength);
    expect((await measureImage(square)).aspectOk).toBe(true);
    expect((await measureImage(pic)).blank).toBe(false);
    await expect(measureImage(Buffer.from('not an image'))).rejects.toMatchObject({ status: 400 });
  });

  it('library: the public index answers (cacheable, empty until the owner builds); the admin router is honest without storage', async () => {
    const app = express();
    app.use('/pub', createLibraryPublicRouter());
    app.use('/admin', createLibraryAdminRouter());
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const pub = await fetch(`${base}/pub`);
      expect(pub.status).toBe(200);
      expect(pub.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await pub.json()).toEqual({ manifestVersion: 1, generatedAt: 0, assets: [] });
      const runs = await fetch(`${base}/admin/runs`);
      expect(runs.status).toBe(503);
      expect(await runs.json()).toEqual({ error: { code: 'NOT_AVAILABLE', message: expect.any(String) } });
      const step = await fetch(`${base}/admin/runs/r1/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(step.status).toBe(404);
    } finally {
      await new Promise<void>((r) => (server as http.Server).close(() => r()));
    }
  });
});
