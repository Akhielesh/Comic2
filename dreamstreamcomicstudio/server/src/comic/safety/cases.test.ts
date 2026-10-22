// Reports (#31), appeals (#33) and the moderator case flow, with fakes.
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../../shared/comic/doc.js';
import { newSession, plannedDoc, testContext, fakeAssetStore } from '../orchestrator.fakes.js';
import { safetyRecheckAction } from '../actions/safety.js';
import { caseAssetUrl, normalizeReportReason, recordReportImpl, resolveCase, runAppeal } from './cases.js';
import { cleanAnswer } from './fakes.js';
import { installSafetyFakes, resetSafety, type SafetyFakes } from './testkit.js';

const SLUG = 'AbCdEfGhIjKlMnOpQ';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const PUB_PAGE = 'pub/AbCdEfGhIjKlMnOpQrStUv/p1-0123456789ab.webp';

let fakes: SafetyFakes;
let assets: ReturnType<typeof fakeAssetStore>;
beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  assets = fakeAssetStore();
  fakes = installSafetyFakes({ assets });
  const snapshot = plannedDoc(PROJECT);
  snapshot.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: PUB_PAGE, source: 'generated', at: 1, variants: [{ path: PUB_PAGE.replace('.webp', '-w480.webp'), w: 480, h: 600 }] } };
  fakes.store.publications.push({ slug: SLUG, publicationId: 'pub-1', projectId: PROJECT, ownerUserId: OWNER, status: 'live', snapshot });
  fakes.store.projects.set(PROJECT, { ownerUserId: OWNER, name: 'Spice Run', isForcedPrivate: false });
  assets.files.set(PUB_PAGE, `data:image/webp;base64,${(await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } } }).webp().toBuffer()).toString('base64')}`);
});
afterEach(() => {
  resetSafety();
  vi.restoreAllMocks();
});

const imageAnswer = (o: Record<string, unknown>) => ({ ...cleanAnswer({ role: 'vision', messages: [], jsonSchema: { name: 'comic_safety_image', schema: {} } }), ...o });

describe('reports (#31)', () => {
  it('normalizes reasons from the reader UI and the share sheet', () => {
    expect(normalizeReportReason('violent')).toBe('violent');
    expect(normalizeReportReason('violence')).toBe('violent');
    expect(normalizeReportReason('hate')).toBe('hateful');
    expect(normalizeReportReason('ip')).toBe('copyright');
    expect(normalizeReportReason('<script>')).toBeNull();
  });

  it('unknown, malformed and unpublished slugs are silently ignored', async () => {
    await recordReportImpl({ slug: 'nope', reason: 'other', ipHash: 'a'.repeat(32) });
    await recordReportImpl({ slug: 'ZZZZZZZZZZZZZZZZZ', reason: 'other', ipHash: 'a'.repeat(32) });
    expect(fakes.store.cases).toEqual([]);
  });

  it('dedupes per reporter, comic, page and day; 3 distinct signed-in readers hold the comic (anonymous weighs 0.5)', async () => {
    await recordReportImpl({ slug: SLUG, reason: 'other', reporterUserId: 'r1', ipHash: 'a'.repeat(32) });
    await recordReportImpl({ slug: SLUG, reason: 'other', reporterUserId: 'r1', ipHash: 'a'.repeat(32) });
    expect(fakes.store.cases).toHaveLength(1);
    await recordReportImpl({ slug: SLUG, reason: 'other', ipHash: 'b'.repeat(32) });
    await recordReportImpl({ slug: SLUG, reason: 'other', ipHash: 'c'.repeat(32) });
    await recordReportImpl({ slug: SLUG, reason: 'other', reporterUserId: 'r2', ipHash: 'd'.repeat(32) });
    // r1 + r2 + two anonymous halves = 3
    expect(fakes.store.projects.get(PROJECT)?.isForcedPrivate).toBe(true);
    expect(fakes.store.actions.at(-1)).toMatchObject({ action: 'auto_hold', reason: 'auto: reader reports' });
    expect(fakes.store.publications[0].status).toBe('suspended');
    expect(fakes.store.notifications.at(-1)).toMatchObject({ userId: OWNER, title: 'Your comic is paused for a review' });
    expect(fakes.audits.at(-1)).toMatchObject({ action: 'comic.auto_hold' });
  });

  it('two anonymous reports alone do not hold the comic', async () => {
    await recordReportImpl({ slug: SLUG, reason: 'other', ipHash: 'b'.repeat(32) });
    await recordReportImpl({ slug: SLUG, reason: 'other', ipHash: 'c'.repeat(32) });
    expect(fakes.store.projects.get(PROJECT)?.isForcedPrivate).toBe(false);
  });

  it('a serious report re-checks the page on the platform key; an X result holds the comic at once', async () => {
    fakes.llm.script.vision = [imageAnswer({ rating: 'X', categories: ['graphic_gore'] })];
    await recordReportImpl({ slug: SLUG, reason: 'violent', page: 1, note: 'page one is\u0007 too gory', ipHash: 'e'.repeat(32) });
    const c = fakes.store.cases[0];
    expect(c.target).toMatchObject({ page: 1, pageId: 'pg_1', path: PUB_PAGE, check: { assessed: 'X', categories: ['graphic_gore'] } });
    expect(c.note).toBe('page one is too gory');
    expect(fakes.store.projects.get(PROJECT)?.isForcedPrivate).toBe(true);
    expect(fakes.store.costs[0]).toMatchObject({ userId: OWNER, operation: 'comic.safety.report_check' });
  });
});

const flaggedDoc = (verdict: 'X' | 'PG-13', quarantined = false): ComicDoc => {
  const doc = plannedDoc('proj-1');
  doc.settings.rating = 'PG';
  doc.pages[0].render = {
    ...emptyRender(),
    status: 'ready',
    asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1, safety: { assessed: verdict, categories: verdict === 'X' ? ['graphic_gore'] : ['violence'], at: 1, by: 'qc', ...(quarantined ? { quarantined: true as const } : {}) } }
  };
  return doc;
};

describe('appeals (#33)', () => {
  const target = { kind: 'page' as const, id: 'pg_1' };

  it('the second opinion (a different model) clears it: restored from quarantine, case auto_cleared', async () => {
    const ctx = testContext(newSession(flaggedDoc('X', true)));
    ctx.assetsFake.files.set('q/user-1/proj-1/q-9.webp', assets.files.get(PUB_PAGE)!);
    fakes.store.quarantine.set('u/user-1/p/proj-1/img/p1.webp', 'q/user-1/proj-1/q-9.webp');
    fakes.llm.script.writer = [imageAnswer({ rating: 'PG' })];
    const r = await runAppeal(ctx, target, 'It is a ketchup fight!');
    expect(r).toMatchObject({ status: 'cleared', rating: 'PG' });
    expect(r.message).toBe("Second look: Page 1 is fine (PG) — it's back.");
    expect(fakes.llm.calls[0].role).toBe('writer');
    expect(ctx.assetsFake.copies).toEqual([{ src: 'q/user-1/proj-1/q-9.webp', dst: 'u/user-1/p/proj-1/img/p1.webp' }]);
    expect(ctx.session.doc.pages[0].render.asset?.safety).toMatchObject({ assessed: 'PG', by: 'second_opinion' });
    expect(ctx.session.doc.pages[0].render.asset?.safety?.quarantined).toBeUndefined();
    expect(fakes.store.cases.at(-1)).toMatchObject({ kind: 'appeal', status: 'auto_cleared' });
    expect(fakes.store.quarantine.size).toBe(0);
  });

  it('the second opinion agrees → a human reviews it; an over-rating page can offer the higher rating', async () => {
    const ctx = testContext(newSession(flaggedDoc('PG-13')));
    fakes.llm.script.writer = [imageAnswer({ rating: 'PG-13', categories: ['violence'] })];
    const r = await runAppeal(ctx, target);
    expect(r.status).toBe('queued');
    expect(r.message).toMatch(/sent it to a human reviewer.*Or set the comic to PG-13\./);
    expect(r.nextSteps?.map((s) => s.label)).toEqual(['Redraw it safer', 'Set the rating to PG-13']);
    expect(fakes.store.cases.at(-1)).toMatchObject({ kind: 'appeal', status: 'open' });
    expect(fakes.store.actions.at(-1)).toMatchObject({ action: 'appeal' });
  });

  it('zero tolerance is never auto-cleared (no second opinion is even asked)', async () => {
    const doc = flaggedDoc('X');
    doc.pages[0].render.asset!.safety!.categories = ['minor_sexual'];
    const ctx = testContext(newSession(doc));
    const r = await runAppeal(ctx, target);
    expect(r.status).toBe('queued');
    expect(fakes.llm.calls).toHaveLength(0);
  });

  it('5 appeals per day, then an honest limit', async () => {
    const ctx = testContext(newSession(flaggedDoc('PG-13')));
    fakes.llm.fallback = () => imageAnswer({ rating: 'PG-13', categories: ['violence'] });
    for (let i = 0; i < 5; i += 1) expect((await runAppeal(ctx, target)).status).toBe('queued');
    await expect(runAppeal(ctx, target)).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });
  });

  it('nothing to review: a passing page or an empty slot says so', async () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'x.webp', source: 'generated', at: 1, safety: { assessed: 'G', at: 1 } } };
    const ctx = testContext(newSession(doc));
    expect((await runAppeal(ctx, target)).status).toBe('fine');
    expect((await runAppeal(ctx, { kind: 'page', id: 'pg_2' })).status).toBe('missing');
  });

  it('the safety_recheck action posts the result (a UI tap → a new assistant message)', async () => {
    const ctx = testContext(newSession(flaggedDoc('PG-13')));
    fakes.llm.script.writer = [imageAnswer({ rating: 'PG' })];
    const started = await safetyRecheckAction.run(ctx, { type: 'safety_recheck', target }, { confirmed: true });
    expect(started.outcome).toMatchObject({ status: 'done' });
    expect(ctx.session.doc.conversation.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringMatching(/Second look/) });
  });
});

describe('moderator cases', () => {
  it('a 5-minute signed URL (quarantine first), audited', async () => {
    const opened = await fakes.store.openCase({ kind: 'appeal', projectId: PROJECT, ownerUserId: OWNER, target: { path: 'u/a/p/b/img/x.webp', quarantinePath: 'q/a/b/q-1.webp' }, reason: 'second opinion agreed' });
    const out = await caseAssetUrl('mod-1', opened.id!);
    expect(out?.url).toBe('https://signed.test/q/a/b/q-1.webp');
    expect(assets.signedTtl.at(-1)).toBe(300);
    expect(fakes.audits.at(-1)).toMatchObject({ action: 'comic.safety.asset_view', actorId: 'mod-1', detail: { quarantined: true } });
  });

  it('withhold a reported published page: the public copy is removed and the comic paused; audited and the owner told', async () => {
    const opened = await fakes.store.openCase({ kind: 'report', projectId: PROJECT, ownerUserId: OWNER, target: { page: 1, pageId: 'pg_1', path: PUB_PAGE }, reason: 'violent' });
    const out = await resolveCase('mod-1', opened.id!, { action: 'withhold', reason: 'gore on page 1' });
    expect(out.effects).toEqual(expect.arrayContaining(['public_copy_removed', 'paused']));
    expect(assets.removed).toEqual([PUB_PAGE, PUB_PAGE.replace('.webp', '-w480.webp')]);
    expect(fakes.store.projects.get(PROJECT)?.isForcedPrivate).toBe(true);
    expect(out.case.status).toBe('resolved');
    expect(fakes.store.actions.at(-1)).toMatchObject({ action: 'withhold_page', actedBy: 'mod-1' });
    expect(fakes.audits.at(-1)).toMatchObject({ action: 'comic.safety.resolve', detail: { action: 'withhold' } });
    expect(fakes.store.notifications.at(-1)).toMatchObject({ userId: OWNER, title: 'An image was withheld' });
    await expect(resolveCase('mod-1', opened.id!, { action: 'dismiss', reason: '' })).rejects.toMatchObject({ status: 409 });
  });

  it('restore an appealed page through the live session (verdict by admin, object moved back)', async () => {
    const session = newSession(flaggedDoc('X', true), undefined, OWNER);
    fakes.sessions.set(PROJECT, session);
    assets.files.set('q/u/p/q-2.webp', assets.files.get(PUB_PAGE)!);
    const opened = await fakes.store.openCase({
      kind: 'appeal',
      projectId: PROJECT,
      ownerUserId: OWNER,
      target: { target: { kind: 'page', id: 'pg_1' }, path: 'u/user-1/p/proj-1/img/p1.webp', quarantinePath: 'q/u/p/q-2.webp' },
      reason: 'second opinion agreed'
    });
    const out = await resolveCase('mod-1', opened.id!, { action: 'restore', assessed: 'PG', reason: 'ketchup, not blood' });
    expect(out.effects).toEqual(['restored']);
    expect(session.doc.pages[0].render.asset?.safety).toMatchObject({ assessed: 'PG', by: 'admin' });
    expect(assets.copies.at(-1)).toEqual({ src: 'q/u/p/q-2.webp', dst: 'u/user-1/p/proj-1/img/p1.webp' });
    expect(fakes.store.actions.at(-1)).toMatchObject({ action: 'appeal_resolved' });
  });

  it('dismissing a report records no moderation action and does not ping the owner', async () => {
    const opened = await fakes.store.openCase({ kind: 'report', projectId: PROJECT, ownerUserId: OWNER, target: {}, reason: 'other' });
    const out = await resolveCase('mod-1', opened.id!, { action: 'dismiss', reason: '' });
    expect(out.case.status).toBe('dismissed');
    expect(fakes.store.actions).toEqual([]);
    expect(fakes.store.notifications).toEqual([]);
  });
});
