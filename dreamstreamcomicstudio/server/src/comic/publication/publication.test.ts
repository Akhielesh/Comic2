// @vitest-environment node
// P1-PUBLISH server tests (sharing.md §11 #18–27, contract §9.3 exact key sets).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { DEFAULT_SETTINGS, type AssetRef, type ComicDoc, type RenderState } from '../../../../shared/comic/doc.js';
import { ASSET_KEY_RE, SLUG_RE, type ShareCard } from '../../../../shared/comic/publication.js';
import type { SafetyStatus } from '../../../../shared/comic/safety.js';
import { fakeAssetStore, newSession, plannedDoc, testContext, type FakeAssetStore, type TestContext } from '../orchestrator.fakes.js';
import type { PublishGateResult } from '../safety/index.js';
import { buildPublicSnapshot, getReadiness, loadPublicByProjectId, newAssetKey, newSlug, publish, regenerateLink, unpublish, updatePublication } from './index.js';
import { escPango, ogHash, renderOgCard, scriptsCovered, vendoredFontFiles } from './ogImage.js';
import { __resetPublishBudget, cardPatchOps, configurePublication, parsePublishRequest, PublishError, publishWithOutcome, sweepOrphanPublications } from './publication.js';
import { planSnapshot } from './snapshot.js';
import { createMemoryPublicationStore, type MemoryPublicationStore } from './store.js';

const USER = 'user-1';
const PRIVATE = {
  premise: 'PRIVATE-PREMISE secret recipe theft',
  spec: 'PRIVATE-STYLE-SPEC clean outlines',
  look: 'PRIVATE-LOOK red scarf',
  action: 'PRIVATE-ACTION Maya leaps',
  summary: 'PRIVATE-SUMMARY page beat',
  convo: 'PRIVATE-CONVO my phone number is 555',
  memory: 'PRIVATE-MEMORY',
  script: 'PRIVATE-SCRIPT',
  gloss: 'PRIVATE-GLOSS',
  qcIssue: 'PRIVATE-QC-ISSUE',
  model: 'PRIVATE-MODEL-ID',
  direction: 'PRIVATE-COVER-DIRECTION',
  turnHook: 'PRIVATE-TURN-HOOK'
};

const asset = (name: string, extra: Partial<AssetRef> = {}): AssetRef => ({
  path: `u/${USER}/p/proj-1/img/${name}.webp`,
  w: 1024,
  h: 1536,
  source: 'generated',
  at: 1,
  model: PRIVATE.model,
  safety: { assessed: 'G', at: 1, by: 'qc' },
  derivedFrom: `u/${USER}/p/proj-1/img/${name}-draft.webp`,
  variants: [
    { path: `u/${USER}/p/proj-1/img/${name}_w480.webp`, w: 480, h: 720 },
    { path: `u/${USER}/p/proj-1/img/${name}_w1080.webp`, w: 1080, h: 1620 }
  ],
  ...extra
});

const ready = (name: string, extra: Partial<AssetRef> = {}): RenderState => ({
  status: 'ready',
  asset: asset(name, extra),
  history: [{ ...asset(`${name}-old`), note: 'PRIVATE-HISTORY' }],
  model: PRIVATE.model,
  qc: { score: 0.9, issues: [PRIVATE.qcIssue], checkedAt: 2, model: PRIVATE.model, panelBoxes: [{ x: 0, y: 0, w: 1, h: 0.5 }] },
  specHash: 'spec'
});

/** plannedDoc enriched with every kind of private data, 3 drawn pages + cover. */
function richDoc(): ComicDoc {
  const doc = plannedDoc('proj-1');
  doc.brief = { ...doc.brief, premise: PRIVATE.premise, notes: ['PRIVATE-NOTE'], audience: 'kids 8+' };
  doc.style = { ...doc.style, status: 'locked', spec: PRIVATE.spec, palette: ['#fff'], refs: [{ ...asset('style-ref'), path: `u/${USER}/p/proj-1/ref/style.webp` }], options: [] };
  doc.cast = doc.cast.map((c) => ({ ...c, look: { ...c.look, summary: PRIVATE.look }, personality: 'PRIVATE-PERSONALITY', voice: 'PRIVATE-VOICE', refs: [{ ...asset('face'), path: `u/${USER}/p/proj-1/ref/face.webp` }], sheet: ready(`sheet-${c.id}`) }));
  doc.pages = doc.pages.map((p) => ({
    ...p,
    summary: PRIVATE.summary,
    turnHook: PRIVATE.turnHook,
    panels: p.panels.map((pn) => ({ ...pn, action: PRIVATE.action, mood: 'PRIVATE-MOOD', angle: 'PRIVATE-ANGLE' })),
    render: ready(`p${p.n}`),
    balloons: [{ lineId: `ln_${p.n}_2`, x: 0.1, y: 0.1, w: 0.3 }]
  }));
  doc.cover = { title: 'Spice Run', tagline: 'Hot on the trail', direction: PRIVATE.direction, render: ready('cover') };
  doc.conversation = [{ id: 'm1', role: 'user', text: PRIVATE.convo, at: 1, attachments: [{ ...asset('att'), path: `u/${USER}/p/proj-1/ref/att.webp` }] }];
  doc.memory = PRIVATE.memory;
  doc.source = { script: PRIVATE.script };
  doc.spend = { totalUsd: 1.23, byKind: { page: 1.23 }, entries: [{ id: 's', at: 1, kind: 'page', label: 'x', usd: 1.23, byok: false, estimated: false }] };
  doc.settings = { ...doc.settings, budgetUsd: 50, imageModelOverride: PRIVATE.model };
  doc.i18n = {
    editions: {
      hi: { lang: 'hi', lines: { ln_1_2: { text: 'नमस्ते', status: 'machine', sourceHash: 'x', gloss: PRIVATE.gloss, at: 1 } }, balloons: {}, register: 'everyday' }
    },
    glossary: [{ id: 'g', term: 'Maya', kind: 'character', policy: 'keep', forms: {}, note: 'PRIVATE-GLOSSARY' }]
  };
  doc.archive = [{ ...asset('archived'), targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 1 }];
  doc.safety = { ipNoted: ['PRIVATE-IP'] };
  doc.planStatus = 'approved';
  return doc;
}

const gateFor =
  (statuses: Record<string, SafetyStatus> = {}, overall?: PublishGateResult['status']) =>
  async (_ctx: unknown, _doc: ComicDoc, opts: { pageIds: string[]; includeCover: boolean }): Promise<PublishGateResult> => {
    const pages = Object.fromEntries(opts.pageIds.map((id) => [id, { status: statuses[id] ?? 'pass', reasons: statuses[id] === 'blocked' ? ['violence'] : [] }]));
    const anyBad = Object.values(pages).some((p) => p.status === 'blocked');
    const anyUnsure = Object.values(pages).some((p) => p.status === 'unchecked');
    return {
      status: overall ?? (anyBad ? 'blocked' : anyUnsure ? 'needs_check' : 'cleared'),
      rating: 'PG',
      pages,
      cover: opts.includeCover ? { status: statuses.cover ?? 'pass', reasons: [] } : null,
      text: { status: statuses.text ?? 'pass', reasons: [] },
      checkedHash: 'h1',
      costUsd: 0
    };
  };

const fakeOg = async () => ({ jpeg: Buffer.from('fake-jpeg'), w: 1200 as const, h: 630 as const, themeColor: '#123456' });

let store: MemoryPublicationStore;
let ctx: TestContext;
let assets: FakeAssetStore;
let restore: () => void;
let clock = 1_800_000_000_000;

const setup = (doc: ComicDoc = richDoc(), statuses: Record<string, SafetyStatus> = {}) => {
  const session = newSession(doc);
  assets = fakeAssetStore();
  ctx = testContext(session, { assets });
  store = createMemoryPublicationStore();
  store.seedProject(doc.id, USER);
  restore?.();
  restore = configurePublication({ store, gate: gateFor(statuses) as never, now: () => clock, renderOg: fakeOg, publicUrl: (p) => `https://cdn.test/${p}` });
};

beforeEach(() => {
  __resetPublishBudget();
  clock += 3_600_000;
  setup();
});
afterEach(() => restore?.());

const keys = (o: object) => Object.keys(o).sort();

describe('identifiers', () => {
  it('newSlug: 10k unique 17-char base62 slugs with no modulo bias (χ² sanity)', () => {
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (let i = 0; i < 10_000; i += 1) {
      const s = newSlug();
      expect(SLUG_RE.test(s)).toBe(true);
      seen.add(s);
      for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
    }
    expect(seen.size).toBe(10_000);
    expect(counts.size).toBe(62);
    const total = 10_000 * 17;
    const expected = total / 62;
    const chi2 = [...counts.values()].reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    // 61 degrees of freedom: p = 0.0001 critical value ≈ 110. A modulo bias (byte % 62) gives > 300.
    expect(chi2).toBeLessThan(110);
    expect(ASSET_KEY_RE.test(newAssetKey())).toBe(true);
  });
});

describe('buildPublicSnapshot (allow-list, exact key sets)', () => {
  const snap = () => {
    const doc = richDoc();
    const plan = { ...planSnapshot(doc, { assetKey: 'K'.repeat(22), pageIds: doc.pages.map((p) => p.id), includeCover: true, languages: ['en'] }), publicationId: 'pub-uuid', publishedAt: 77, rev: 9 };
    return { doc, snapshot: buildPublicSnapshot(doc, plan) };
  };

  it('has exactly the allow-listed keys at every level', () => {
    const { snapshot } = snap();
    expect(keys(snapshot)).toEqual(
      ['book', 'brief', 'cast', 'conversation', 'cover', 'createdAt', 'format', 'gate', 'i18n', 'id', 'letterStyle', 'pages', 'places', 'planStatus', 'reader', 'rev', 'settings', 'source', 'spend', 'style', 'updatedAt', 'v'].sort()
    );
    expect(snapshot.id).toBe('pub-uuid');
    expect([snapshot.createdAt, snapshot.updatedAt, snapshot.rev]).toEqual([77, 77, 9]);
    expect(keys(snapshot.brief)).toEqual(['logline', 'notes', 'title']);
    expect(keys(snapshot.format)).toEqual(['colorMode', 'kind', 'language', 'lettering', 'pageAspect', 'pageCount', 'panelsPerPage', 'readingDirection']);
    expect(keys(snapshot.style)).toEqual(['name', 'options', 'refs', 'status']);
    expect(snapshot.style).toMatchObject({ status: 'locked', refs: [], options: [] });
    for (const c of snapshot.cast) {
      expect(keys(c)).toEqual(['id', 'look', 'name', 'refs', 'sheet', 'tier']);
      expect(c.look).toEqual({ summary: '' });
      expect(c.sheet).toEqual({ status: 'none', history: [] });
    }
    expect(snapshot.places).toEqual([]);
    expect(snapshot.source).toEqual({});
    expect(snapshot.settings).toEqual(DEFAULT_SETTINGS);
    expect(snapshot.spend).toEqual({ totalUsd: 0, byKind: {}, entries: [] });
    expect([snapshot.gate, snapshot.conversation, snapshot.planStatus]).toEqual([null, [], 'approved']);
    for (const p of snapshot.pages) {
      expect(keys(p)).toEqual(['balloons', 'id', 'layout', 'n', 'panels', 'render', 'summary']);
      expect(p.summary).toBe('');
      expect(keys(p.render)).toEqual(['asset', 'history', 'qc', 'status']);
      expect(p.render.history).toEqual([]);
      expect(keys(p.render.qc!)).toEqual(['checkedAt', 'issues', 'panelBoxes', 'score']);
      expect(keys(p.render.asset!)).toEqual(['at', 'h', 'path', 'source', 'variants', 'w']);
      for (const v of p.render.asset!.variants!) expect(keys(v)).toEqual(['h', 'path', 'w']);
      for (const pn of p.panels) {
        expect(keys(pn)).toEqual(['action', 'castIds', 'id', 'lines', 'n', 'shot', 'size']);
        expect([pn.action, pn.shot, pn.castIds]).toEqual(['', 'medium', []]);
        for (const l of pn.lines) expect(keys(l).every((k) => ['id', 'kind', 'speakerId', 'text', 'style'].includes(k))).toBe(true);
      }
      for (const b of p.balloons) expect(keys(b).every((k) => ['lineId', 'x', 'y', 'w', 'tailX', 'tailY', 'pinned', 'z', 'locked', 'linkTo'].includes(k))).toBe(true);
    }
    expect(keys(snapshot.cover)).toEqual(['render', 'tagline', 'title']);
    expect(keys(snapshot.cover.render)).toEqual(['asset', 'history', 'status']);
    expect(keys(snapshot.i18n!)).toEqual(['editions', 'glossary']);
  });

  it('contains no private string, no u/ path, no project id, and only pub/<key>/ images', () => {
    const { snapshot } = snap();
    const json = JSON.stringify(snapshot);
    for (const secret of [...Object.values(PRIVATE), 'PRIVATE-NOTE', 'PRIVATE-PERSONALITY', 'PRIVATE-VOICE', 'PRIVATE-HISTORY', 'PRIVATE-GLOSSARY', 'PRIVATE-IP', 'PRIVATE-MOOD', 'PRIVATE-ANGLE']) {
      expect(json).not.toContain(secret);
    }
    expect(json).not.toMatch(/u\/user-1|\/ref\/|proj-1/);
    expect(json).not.toContain('हिन्दी'); // the unpublished Hindi edition is absent
    expect(snapshot.i18n!.editions).toEqual({});
    const paths = [...json.matchAll(/"path":"([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p).toMatch(/^pub\/K{22}\/(cover|page)-[0-9a-f]{12}(-w(480|1080))?\.webp$/);
  });
});

describe('publish', () => {
  it('publishes an unlisted comic: copies, snapshot, card, OG, mirror, doc op', async () => {
    const view = await publish(ctx, { visibility: 'unlisted' });
    expect(view.visibility).toBe('unlisted');
    expect(view.status).toBe('live');
    expect(SLUG_RE.test(view.slug!)).toBe(true);
    expect(view.url).toBe(`https://comics.dreamstreamstudio.ai/c/${view.slug}`);
    expect(view.allowDownload).toBe(true); // addendum default
    expect(view.behind).toBe(false);
    const row = store.rows.get('proj-1')!;
    expect(row.snapshot!.pages).toHaveLength(3);
    // originals + both variants for 3 pages + cover, copied server-side
    expect(assets.copies).toHaveLength(12);
    expect(assets.copies.every((c) => c.dst.startsWith(`pub/${row.assetKey}/`))).toBe(true);
    const card = row.card as ShareCard;
    expect(card.title).toBe('Spice Run');
    expect(card.coverUrl).toMatch(new RegExp(`^https://cdn.test/pub/${row.assetKey}/cover-[0-9a-f]{12}-w1080\\.webp$`));
    expect(card.og.en.path).toMatch(/^pub\/[A-Za-z0-9]{22}\/og-en-[0-9a-f]{12}\.jpg$/);
    expect(view.ogImageUrl).toBe(`https://comics.dreamstreamstudio.ai/og/${card.og.en.path.slice(4)}`);
    expect(assets.puts.map((p) => p.contentType)).toEqual(['image/jpeg']);
    const project = store.projects.get('proj-1')!;
    expect(project.isPublic).toBe(false);
    expect(project.state.shareSlug).toBe(view.slug);
    expect(ctx.session.doc.publication).toMatchObject({ visibility: 'unlisted', status: 'live', slug: view.slug });
    expect(store.rpcPayload(view.slug!)?.doc?.pages).toHaveLength(3);
  });

  it('public: mirrors is_public, the opaque gallery cover and the slug', async () => {
    const view = await publish(ctx, { visibility: 'public' });
    const p = store.projects.get('proj-1')!;
    expect(p.isPublic).toBe(true);
    expect(p.state.shareSlug).toBe(view.slug);
    expect(String(p.state.publicCover)).toMatch(/^pub\//);
    expect(p.state.coverImageId).toBe(p.state.publicCover);
    const payload = await loadPublicByProjectId('proj-1');
    expect(payload?.publication.visibility).toBe('public');
    const snapshotPathList = Object.keys(payload!.urls);
    expect(snapshotPathList.every((k) => k.startsWith(`pub/${store.rows.get('proj-1')!.assetKey}/`))).toBe(true);
    expect(payload!.urls[snapshotPathList[0]]).toBe(`https://cdn.test/${snapshotPathList[0]}`);
  });

  it('never maps a project id to an UNLISTED publication', async () => {
    await publish(ctx, { visibility: 'unlisted' });
    expect(await loadPublicByProjectId('proj-1')).toBeNull();
  });

  it('refuses with nothing drawn (422 NOT_READY) and changes nothing', async () => {
    const doc = richDoc();
    doc.pages = doc.pages.map((p) => ({ ...p, render: { status: 'none', history: [] } }));
    setup(doc);
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 422, reason: 'NOT_READY' });
    expect(store.rows.size).toBe(0);
    expect(assets.copies).toHaveLength(0);
  });

  it('a safety-blocked page: 422 SAFETY_BLOCKED with no row, no copies, no is_public; consented exclusion renumbers', async () => {
    setup(richDoc(), { pg_2: 'blocked' });
    const err = await publish(ctx, { visibility: 'public' }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err).toMatchObject({ status: 422, reason: 'SAFETY_BLOCKED' });
    expect(err.details.blockedPages).toEqual([2]);
    expect(store.rows.size).toBe(0);
    expect(assets.copies).toHaveLength(0);
    expect(store.projects.get('proj-1')!.isPublic).toBe(false);

    const view = await publish(ctx, { visibility: 'public', excludePageIds: ['pg_2'] });
    const pages = store.rows.get('proj-1')!.snapshot!.pages;
    expect(pages.map((p) => [p.id, p.n])).toEqual([
      ['pg_1', 1],
      ['pg_3', 2]
    ]);
    expect(view.status).toBe('live');
  });

  it('unchecked content is never published (503, fail closed)', async () => {
    setup(richDoc(), { pg_1: 'unchecked' });
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 503, reason: 'SAFETY_UNAVAILABLE' });
    expect(store.rows.size).toBe(0);
    setup(richDoc(), { text: 'blocked' });
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 422, reason: 'SAFETY_BLOCKED' });
  });

  it('a blocked cover is left out (preview falls back to page 1)', async () => {
    setup(richDoc(), { cover: 'blocked' });
    await publish(ctx, { visibility: 'unlisted' });
    const row = store.rows.get('proj-1')!;
    expect(row.snapshot!.cover.render.status).toBe('none');
    expect((row.card as ShareCard).coverUrl).toMatch(/page-[0-9a-f]{12}-w1080\.webp$/);
  });

  it('refuses unfinished languages (422 LANG_INCOMPLETE), unknown fields (400) and moderation holds (403)', async () => {
    await expect(publish(ctx, { visibility: 'unlisted', languages: ['en', 'hi'] })).rejects.toMatchObject({ status: 422, reason: 'LANG_INCOMPLETE' });
    await expect(publish(ctx, { visibility: 'unlisted', owner: 'x' } as never)).rejects.toMatchObject({ status: 400 });
    await expect(publish(ctx, { visibility: 'everyone' } as never)).rejects.toMatchObject({ status: 400 });
    expect(() => parsePublishRequest({ visibility: 'unlisted', languages: ['<script>'] })).toThrow();
    store.forcePrivate('proj-1');
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 403 });
    expect(store.rows.size).toBe(0);
  });

  it('404 for a project this user does not own', async () => {
    store.projects.get('proj-1')!.userId = 'someone-else';
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 404 });
  });

  it('409 while a page is still drawing', async () => {
    const doc = richDoc();
    doc.pages[1].render = { ...doc.pages[1].render, status: 'rendering' };
    setup(doc);
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 409, reason: 'CONFLICT' });
  });

  it('republish keeps the slug, copies only changed art, deletes what is no longer referenced', async () => {
    const first = await publish(ctx, { visibility: 'unlisted' });
    const key = store.rows.get('proj-1')!.assetKey!;
    const oldPage2 = store.rows.get('proj-1')!.snapshot!.pages[1].render.asset!.path;
    // Edit: page 2 gets new art.
    ctx.session.commit([{ op: 'render', target: { kind: 'page', id: 'pg_2' }, patch: { status: 'ready', asset: asset('p2-v2') } }]);
    expect((await (await import('./index.js')).getPublicationView(ctx)).behind).toBe(true);
    const before = assets.copies.length;
    clock += 1000;
    const second = await publish(ctx, { visibility: 'unlisted' });
    expect(second.slug).toBe(first.slug);
    expect(store.rows.get('proj-1')!.assetKey).toBe(key);
    expect(assets.copies.length - before).toBe(3); // the new page 2 original + 2 variants
    expect(assets.removed).toContain(oldPage2);
    expect(second.behind).toBe(false);
    expect(second.publishedRev).toBeGreaterThan(first.publishedRev);
  });

  it('regenerate: new slug + new key, old link dead at once, old objects deleted', async () => {
    const first = await publish(ctx, { visibility: 'unlisted' });
    const oldKey = store.rows.get('proj-1')!.assetKey!;
    const next = await regenerateLink(ctx);
    const row = store.rows.get('proj-1')!;
    expect(next.slug).not.toBe(first.slug);
    expect(SLUG_RE.test(next.slug!)).toBe(true);
    expect(row.assetKey).not.toBe(oldKey);
    expect(store.rpcPayload(first.slug!)).toBeNull();
    expect(store.rpcPayload(next.slug!)).not.toBeNull();
    expect([...assets.files.keys()].some((p) => p.startsWith(`pub/${oldKey}/`))).toBe(false);
    expect(JSON.stringify(row.snapshot)).not.toContain(oldKey);
    expect(JSON.stringify(row.card)).not.toContain(oldKey);
    expect(store.projects.get('proj-1')!.state.shareSlug).toBe(next.slug);
  });

  it('unpublish: slug/snapshot/key gone, objects deleted, idempotent; publishing again mints a NEW slug', async () => {
    const first = await publish(ctx, { visibility: 'public' });
    const key = store.rows.get('proj-1')!.assetKey!;
    const view = await unpublish(ctx);
    const row = store.rows.get('proj-1')!;
    expect(view.visibility).toBe('private');
    expect([row.status, row.slug, row.assetKey, row.snapshot]).toEqual(['unpublished', null, null, null]);
    expect([...assets.files.keys()].some((p) => p.startsWith(`pub/${key}/`))).toBe(false);
    expect(store.projects.get('proj-1')!.isPublic).toBe(false);
    expect(store.projects.get('proj-1')!.state.shareSlug).toBeUndefined();
    expect(store.rpcPayload(first.slug!)).toBeNull();
    expect(ctx.session.doc.publication).toBeUndefined();
    await expect(unpublish(ctx)).resolves.toMatchObject({ visibility: 'private' });
    const again = await publish(ctx, { visibility: 'unlisted' });
    expect(again.slug).not.toBe(first.slug);
  });

  it('moderation suspends: the RPC returns null, the owner sees why', async () => {
    const view = await publish(ctx, { visibility: 'public' });
    store.forcePrivate('proj-1');
    expect(store.rpcPayload(view.slug!)).toBeNull();
    expect(await loadPublicByProjectId('proj-1')).toBeNull();
    const owner = await (await import('./index.js')).getPublicationView(ctx);
    expect(owner.status).toBe('suspended');
    expect(owner.suspendedReason).toBeTruthy();
  });

  it('settings: visibility flips the mirror (public re-runs the gate); defaults must be published languages', async () => {
    await publish(ctx, { visibility: 'unlisted' });
    const v = await updatePublication(ctx, { visibility: 'public', allowDownload: false });
    expect(v.visibility).toBe('public');
    expect(v.allowDownload).toBe(false);
    expect(store.projects.get('proj-1')!.isPublic).toBe(true);
    await expect(updatePublication(ctx, { defaultLang: 'hi' })).rejects.toMatchObject({ status: 400 });
    await expect(updatePublication(ctx, { startPage: 9 })).rejects.toMatchObject({ status: 400 });
    await expect(updatePublication(ctx, { languages: ['en'] } as never)).rejects.toMatchObject({ status: 400 });
  });

  it('rate-limits publishing writes per user (10/min)', async () => {
    for (let i = 0; i < 10; i += 1) await publish(ctx, { visibility: 'unlisted' });
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 429 });
    // Unpublishing (taking content down) is never rate-limited.
    await expect(unpublish(ctx)).resolves.toBeTruthy();
  });

  it('readiness lists missing, stale and blocked pages honestly', async () => {
    const doc = richDoc();
    doc.pages[0].render = { status: 'none', history: [] };
    doc.pages[1].render = { ...doc.pages[1].render, status: 'stale' };
    doc.pages[2].render = ready('p3', { safety: { assessed: 'X', at: 1, categories: ['graphic_gore'] } });
    const r = await getReadiness(ctx, doc);
    expect(r.ok).toBe(false);
    expect(r.drawnPages).toBe(2);
    expect(r.missing).toEqual([{ kind: 'page', n: 1, status: 'not drawn yet' }]);
    expect(r.stalePages).toEqual([2]);
    expect(r.safety).toMatchObject({ status: 'blocked', blockedPages: [3] });
  });

  it('card patch ops update only the publish card in its message', () => {
    const doc = ctx.session.doc;
    ctx.session.commit([{ op: 'message', msg: { id: 'm9', role: 'assistant', text: 'x', at: 1, cards: [{ type: 'publish', id: 'c1', mode: 'publish', status: 'pending' }, { type: 'notice', id: 'n', tone: 'info', text: 'y' }] } }]);
    const ops = cardPatchOps(ctx.session.doc, 'c1', { status: 'done' });
    expect(ops).toHaveLength(1);
    expect(cardPatchOps(doc, 'missing', { status: 'done' })).toEqual([]);
  });

  it('the orphan sweep only removes well-formed pub/<key>/ prefixes', async () => {
    store.orphanKeys = async () => ['A'.repeat(22), '../etc', ''];
    const removed: string[] = [];
    await sweepOrphanPublications({ removePrefix: async (p) => (removed.push(p), 1) });
    expect(removed).toEqual([`pub/${'A'.repeat(22)}/`]);
  });

  it('a failed copy publishes nothing and cleans up', async () => {
    assets.missing.add(`u/${USER}/p/proj-1/img/p2.webp`);
    await expect(publishWithOutcome(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 503 });
    expect(store.rows.size).toBe(0);
    expect([...assets.files.keys()].some((p) => p.startsWith('pub/'))).toBe(false);
  });
});

describe('OG image (sharp + Pango, $0)', () => {
  const cover = () =>
    sharp({ create: { width: 800, height: 1000, channels: 3, background: '#4a8f5c' } })
      .png()
      .toBuffer();

  it('escapes Pango markup and detects uncovered scripts', () => {
    expect(escPango('<span foreground="red">x</span>&')).toBe('&lt;span foreground=&quot;red&quot;&gt;x&lt;/span&gt;&amp;');
    expect(scriptsCovered('Hello नमस्ते తెలుగు')).toBe(true);
    expect(scriptsCovered('日本語')).toBe(false);
  });

  it('hash is stable and changes with title, cover, language and template', () => {
    const base = { title: 'A', subtitle: 'B', kindLabel: 'Comic', pageCount: 2, lang: 'en', showMark: true as const, coverPath: 'x' };
    expect(ogHash(base)).toBe(ogHash({ ...base }));
    expect(ogHash(base)).toMatch(/^[0-9a-f]{12}$/);
    for (const change of [{ title: 'Z' }, { coverPath: 'y' }, { lang: 'hi' }]) expect(ogHash({ ...base, ...change })).not.toBe(ogHash(base));
  });

  it('renders a 1200×630 JPEG ≤ 300 KB with a markup-injection title rendered literally, and a no-art gradient', async () => {
    const out = await renderOgCard({ title: '"><script>alert(1)</script><span foreground="red">x</span>&', subtitle: 'Logline with   control', kindLabel: 'Comic', pageCount: 3, lang: 'en', coverBuf: await cover(), fallbackPageBuf: null, showMark: true });
    const meta = await sharp(out.jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1200, 630]);
    expect(out.jpeg.byteLength).toBeLessThanOrEqual(300 * 1024);
    const plain = await renderOgCard({ title: 'No art', subtitle: '', kindLabel: 'Comic', pageCount: 1, lang: 'en', coverBuf: null, fallbackPageBuf: null, showMark: true, themeColor: '#336699' });
    expect((await sharp(plain.jpeg).metadata()).width).toBe(1200);
    expect(plain.themeColor).toBe('#336699');
  }, 30_000);

  it.skipIf(!vendoredFontFiles().length)('draws a Devanagari title (non-empty ink in the title box)', async () => {
    const out = await renderOgCard({ title: 'झील के किनारे', subtitle: '', kindLabel: 'Storybook', pageCount: 1, lang: 'hi', coverBuf: null, fallbackPageBuf: null, showMark: true, themeColor: '#000000' });
    const { data, info } = await sharp(out.jpeg).extract({ left: 120, top: 92, width: 600, height: 80 }).greyscale().raw().toBuffer({ resolveWithObject: true });
    let bright = 0;
    for (let i = 0; i < info.width * info.height; i += 1) if (data[i] > 200) bright += 1;
    expect(bright).toBeGreaterThan(500);
  }, 30_000);
});
