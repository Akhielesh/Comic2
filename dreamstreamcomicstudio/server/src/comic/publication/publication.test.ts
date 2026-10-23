// @vitest-environment node
// P1-PUBLISH server tests (sharing.md §11 #18–27, contract §9.3 exact key sets).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { DEFAULT_SETTINGS, type AssetRef, type ComicDoc, type RenderState } from '../../../../shared/comic/doc.js';
import { editionProgress, editionReadiness, fallbackLineIds, lineSourceHash, localizeDoc } from '../../../../shared/comic/i18n.js';
import { ASSET_KEY_RE, SLUG_RE, type ShareCard } from '../../../../shared/comic/publication.js';
import { effectiveRating, publishableText, type SafetyStatus } from '../../../../shared/comic/safety.js';
import { __resetSharpSlotPeakForTests, sharpSlotStats, withSharpSlot } from '../imageMeasure.js';
import { fakeAssetStore, newSession, plannedDoc, testContext, type FakeAssetStore, type TestContext } from '../orchestrator.fakes.js';
import { runPublishGate, type PublishGateResult } from '../safety/index.js';
import { installSafetyFakes, resetSafety, TERMS } from '../safety/testkit.js';
import { buildPublicSnapshot, getReadiness, loadPublicByProjectId, newAssetKey, newSlug, publish, regenerateLink, removePublicationObjects, unpublish, updatePublication } from './index.js';
import { escPango, ogHash, ratingMeta, renderOgCard, scriptsCovered, vendoredFontFiles, type OgRenderInput } from './ogImage.js';
import {
  __resetOrphanSweep,
  __resetPublishBudget,
  cardPatchOps,
  maybeSweepOrphans,
  ORPHAN_SWEEP_EVERY_MS,
  OUTSIDE_IMAGE_STATUS,
  SWEEP_GRACE_MS,
  configurePublication,
  parsePublishRequest,
  payloadOf,
  publicationRatingOf,
  PublishError,
  publishWithOutcome,
  sweepOrphanPublications
} from './publication.js';
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
  (statuses: Record<string, SafetyStatus> = {}, overall?: PublishGateResult['status'], rating: PublishGateResult['rating'] = 'PG') =>
  async (_ctx: unknown, _doc: ComicDoc, opts: { pageIds: string[]; includeCover: boolean }): Promise<PublishGateResult> => {
    const pages = Object.fromEntries(opts.pageIds.map((id) => [id, { status: statuses[id] ?? 'pass', reasons: statuses[id] === 'blocked' ? ['violence'] : [] }]));
    const anyBad = Object.values(pages).some((p) => p.status === 'blocked');
    const anyUnsure = Object.values(pages).some((p) => p.status === 'unchecked');
    return {
      status: overall ?? (anyBad ? 'blocked' : anyUnsure ? 'needs_check' : 'cleared'),
      rating,
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
        for (const l of pn.lines) expect(keys(l).every((k) => ['id', 'kind', 'speakerId', 'text', 'style', 'noTranslate'].includes(k))).toBe(true);
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
    expect(view.ogImageUrl).toBe(`/og/${card.og.en.path.slice(4)}`);
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
    // The gallery row shows the PUBLISHED (gated) title and blurb.
    expect(p.name).toBe('Spice Run');
    expect(p.state.overview).toBe('A courier races through a spice market.');
    const payload = await loadPublicByProjectId('proj-1');
    expect(payload?.publication.visibility).toBe('public');
    const snapshotPathList = Object.keys(payload!.urls);
    expect(snapshotPathList.every((k) => k.startsWith(`pub/${store.rows.get('proj-1')!.assetKey}/`))).toBe(true);
    expect(payload!.urls[snapshotPathList[0]]).toBe(`https://cdn.test/${snapshotPathList[0]}`);
  });

  it('never maps a project id to an UNLISTED publication', async () => {
    await publish(ctx, { visibility: 'unlisted' });
    expect(await loadPublicByProjectId('proj-1')).toBeNull();
    // An unlisted row stays private: the owner's live title is never overwritten by the listing mirror.
    expect(store.projects.get('proj-1')!.name).toBeUndefined();
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
    // Contract §12.6: needs_check → 503 NOT_AVAILABLE (the route sends `reason` as the wire code; the client retries it).
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 503, reason: 'NOT_AVAILABLE', code: 'NOT_AVAILABLE' });
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

  it('the gate reads the live doc itself (no helper doc): every published author text is in its publishableText', async () => {
    const doc = richDoc();
    doc.pages[0].chapterTitle = 'CHAPTER-TEXT';
    doc.book = { titlePage: true, endPage: true, backCover: 'auto', blurb: 'BLURB-TEXT', credits: ['CREDIT-TEXT'], firstPageRight: true, uniformTrim: true };
    doc.reader = { turn: 'paper', guidedOverview: true, paperTexture: true, ambient: true, credits: 'ENDCARD-TEXT', dedication: 'DEDICATION-TEXT' };
    doc.style = { ...doc.style, name: 'STYLE-NAME-TEXT' };
    setup(doc);
    let seen: ComicDoc | null = null;
    const inner = gateFor();
    restore();
    restore = configurePublication({ store, gate: (async (c: unknown, d: ComicDoc, o: { pageIds: string[]; includeCover: boolean }) => ((seen = d), inner(c, d, o))) as never, now: () => clock, renderOg: fakeOg, publicUrl: (p) => `https://cdn.test/${p}` });
    const before = ctx.session.doc;
    await publish(ctx, { visibility: 'unlisted' });
    // The gate got the session's own doc — no extra "cast" entries smuggling text in.
    expect(seen).toBe(before);
    expect(seen!.cast.map((c) => c.id)).toEqual(doc.cast.map((c) => c.id));
    const words = publishableText(seen!, []);
    for (const t of ['CHAPTER-TEXT', 'BLURB-TEXT', 'CREDIT-TEXT', 'ENDCARD-TEXT', 'DEDICATION-TEXT', 'STYLE-NAME-TEXT']) expect(words).toContain(t);
    expect(ctx.session.doc.cast.some((c) => c.id.startsWith('_published_text_'))).toBe(false);
    expect(store.rows.get('proj-1')!.snapshot!.cast.some((c) => c.id.startsWith('_published_text_'))).toBe(false);
  });

  describe('with the REAL publish gate (P1-SAFETY; platform classifier faked, $0)', () => {
    afterEach(() => resetSafety());
    const authorTexts = (doc: ComicDoc) => {
      doc.pages[0].chapterTitle = 'CHAPTER-TEXT';
      doc.book = { titlePage: true, endPage: true, backCover: 'auto', blurb: 'BLURB-TEXT', credits: ['CREDIT-TEXT'], firstPageRight: true, uniformTrim: true };
      doc.reader = { turn: 'paper', guidedOverview: true, paperTexture: true, ambient: true, credits: 'ENDCARD-TEXT', dedication: 'DEDICATION-TEXT' };
      doc.style = { ...doc.style, name: 'STYLE-NAME-TEXT' };
      return doc;
    };
    const useRealGate = () => {
      restore();
      restore = configurePublication({ store, gate: runPublishGate, now: () => clock, renderOg: fakeOg, publicUrl: (p) => `https://cdn.test/${p}` });
    };

    it('its one text check carries every author text the snapshot publishes, and it freezes the effective rating', async () => {
      const doc = authorTexts(richDoc());
      setup(doc);
      const fakes = installSafetyFakes();
      useRealGate();
      const view = await publish(ctx, { visibility: 'public' });
      const textCalls = fakes.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_text');
      expect(textCalls).toHaveLength(1);
      const sent = JSON.stringify(textCalls[0].messages);
      for (const t of ['CHAPTER-TEXT', 'BLURB-TEXT', 'CREDIT-TEXT', 'ENDCARD-TEXT', 'DEDICATION-TEXT', 'STYLE-NAME-TEXT', 'Spice Run', 'Line on page 2']) expect(sent).toContain(t);
      const rating = effectiveRating(doc).rating;
      expect(store.rows.get('proj-1')!.safety.rating).toBe(rating);
      expect(view.rating).toBe(rating);
      expect(store.projects.get('proj-1')!.contentRating).toBe(rating);
      expect(store.rpcPayload(view.slug!)!.publication.rating).toBe(rating);
    });

    it('a blocked word in a CHAPTER TITLE (not a line) still stops the publish: 422 SAFETY_BLOCKED, nothing goes live', async () => {
      const doc = richDoc();
      doc.pages[1].chapterTitle = `Chapter of ${TERMS['<SEXUAL_TERM>']}`;
      setup(doc);
      installSafetyFakes({ classifier: false }); // pre-filter only: the lexicon decides, no model call
      useRealGate();
      const err = await publish(ctx, { visibility: 'unlisted' }).catch((e) => e);
      expect(err).toBeInstanceOf(PublishError);
      expect(err).toMatchObject({ status: 422, reason: 'SAFETY_BLOCKED', details: { text: true } });
      expect(store.rows.size).toBe(0);
      expect(assets.copies).toHaveLength(0);
    });
  });

  it('only pages the gate PASSED go out: pending, unknown or missing verdicts fail closed (503), even if the gate says "cleared"', async () => {
    for (const statuses of [{ pg_2: 'pending' }, { pg_2: 'mystery' }, { cover: 'pending' }, { text: 'pending' }, { text: 'mystery' }] as Record<string, SafetyStatus>[]) {
      setup(richDoc());
      restore();
      restore = configurePublication({ store, gate: gateFor(statuses, 'cleared') as never, now: () => clock, renderOg: fakeOg, publicUrl: (p) => `https://cdn.test/${p}` });
      await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 503, reason: 'NOT_AVAILABLE' });
      expect(store.rows.size).toBe(0);
      expect(assets.copies).toHaveLength(0);
    }
    // A verdict missing for a page entirely is "could not check" too.
    setup(richDoc());
    restore();
    const partial = async (c: unknown, d: ComicDoc, o: { pageIds: string[]; includeCover: boolean }) => {
      const r = await gateFor()(c, d, o);
      delete r.pages.pg_3;
      return r;
    };
    restore = configurePublication({ store, gate: partial as never, now: () => clock, renderOg: fakeOg, publicUrl: (p) => `https://cdn.test/${p}` });
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 503 });
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

  it('owner stats: absent until a read is recorded (no misleading zeros), then summarized', async () => {
    const { getPublicationView } = await import('./index.js');
    await publish(ctx, { visibility: 'unlisted' });
    expect((await getPublicationView(ctx)).stats).toBeUndefined();
    const id = store.rows.get('proj-1')!.id!;
    const today = new Date(clock).toISOString().slice(0, 10);
    store.statsRows.set(id, [{ day: today, views: 4, uniques: 3, completes: 1, byChannel: { whatsapp: 3, direct: 1 } }]);
    const stats = (await getPublicationView(ctx)).stats!;
    expect(stats).toMatchObject({ uniques7d: 3, completes7d: 1, byChannel7d: { whatsapp: 3, direct: 1 }, daily: [{ day: today, views: 4 }] });
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

  it('going public when the published pages are gone from the live doc: blocked words say so (422), an outage is 503', async () => {
    await publish(ctx, { visibility: 'unlisted' });
    const row = store.rows.get('proj-1')!;
    store.rows.set('proj-1', { ...row, snapshot: { ...row.snapshot!, pages: row.snapshot!.pages.map((p) => ({ ...p, id: `${p.id}_old` })) } });
    for (const [text, expected] of [
      ['blocked', { status: 422, reason: 'SAFETY_BLOCKED' }],
      ['unchecked', { status: 503, reason: 'NOT_AVAILABLE' }]
    ] as const) {
      restore();
      restore = configurePublication({ store, gate: gateFor({ text }, text === 'blocked' ? 'blocked' : 'needs_check') as never, now: () => clock, renderOg: fakeOg, publicUrl: (p) => `https://cdn.test/${p}` });
      await expect(updatePublication(ctx, { visibility: 'public' })).rejects.toMatchObject(expected);
      expect(store.rows.get('proj-1')!.visibility).toBe('unlisted');
      expect(store.projects.get('proj-1')!.isPublic).toBe(false);
    }
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

  it('the sweep is scheduled without a timer: it piggybacks on publication writes, at most once a day, never twice at once', async () => {
    __resetOrphanSweep();
    let scans = 0;
    store.orphanKeys = async () => (scans += 1, ['B'.repeat(22)]);
    const orphan = `pub/${'B'.repeat(22)}/page-0123456789ab.webp`;
    assets.files.set(orphan, 'data:image/webp;base64,AA==');
    await publish(ctx, { visibility: 'unlisted' }); // first write of the day starts one sweep
    await new Promise((r) => setTimeout(r, 0));
    expect(scans).toBe(1);
    expect(assets.files.has(orphan)).toBe(false);
    expect(assets.removed).toContain(orphan);
    clock += 1000;
    await unpublish(ctx); // same day: not again
    expect(scans).toBe(1);
    // Due again a day later; a second caller while it runs gets null (no overlap); failures never throw.
    const removePrefix = async () => {
      throw new Error('storage down');
    };
    const first = maybeSweepOrphans({ removePrefix }, clock + ORPHAN_SWEEP_EVERY_MS + 1);
    expect(first).not.toBeNull();
    expect(maybeSweepOrphans({ removePrefix }, clock + 2 * ORPHAN_SWEEP_EVERY_MS)).toBeNull();
    await expect(first).resolves.toBe(0);
    expect(scans).toBe(2);
  });

  it('a failed copy publishes nothing and cleans up', async () => {
    assets.missing.add(`u/${USER}/p/proj-1/img/p2.webp`);
    await expect(publishWithOutcome(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 503 });
    expect(store.rows.size).toBe(0);
    expect([...assets.files.keys()].some((p) => p.startsWith('pub/'))).toBe(false);
  });
});

describe('content rating (G / PG / PG-13), frozen at publish time, end to end', () => {
  const withGate = (gate: ReturnType<typeof gateFor>, renderOg: (i: OgRenderInput) => ReturnType<typeof fakeOg> = fakeOg) => {
    restore();
    restore = configurePublication({ store, gate: gate as never, now: () => clock, renderOg, publicUrl: (p) => `https://cdn.test/${p}` });
  };

  it('publish records the gate rating once: row, owner view, anon RPC, legacy /public/:id payload, gallery mirror', async () => {
    const view = await publish(ctx, { visibility: 'public' });
    const row = store.rows.get('proj-1')!;
    expect(row.safety.rating).toBe('PG');
    expect(view.rating).toBe('PG');
    expect(publicationRatingOf(row)).toBe('PG');
    expect(store.rpcPayload(view.slug!)!.publication.rating).toBe('PG');
    expect(payloadOf(row)!.publication.rating).toBe('PG');
    expect((await loadPublicByProjectId('proj-1'))!.publication.rating).toBe('PG');
    expect(store.projects.get('proj-1')!.contentRating).toBe('PG');
    // The snapshot itself stays the exact allow-list (the rating lives beside it, not in the doc).
    expect(row.snapshot!.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('the preview card is drawn with the rating ("Rated PG") under a rating-specific URL', async () => {
    const inputs: OgRenderInput[] = [];
    withGate(gateFor(), async (i) => (inputs.push(i), fakeOg()));
    await publish(ctx, { visibility: 'unlisted' });
    expect(inputs.map((i) => i.rating)).toEqual(['PG']);
    const { coverBuf: _c, fallbackPageBuf: _f, themeColor: _t, ...hashInput } = inputs[0];
    const row = store.rows.get('proj-1')!;
    const coverPath = `u/${USER}/p/proj-1/img/cover_w1080.webp`; // the 1080 variant the renderer read
    expect((row.card as ShareCard).og.en.path).toBe(`pub/${row.assetKey}/og-en-${ogHash({ ...hashInput, coverPath })}.jpg`);
    expect(ogHash({ ...hashInput, coverPath, rating: 'G' })).not.toBe(ogHash({ ...hashInput, coverPath }));
    expect([ratingMeta('PG'), ratingMeta('PG-13'), ratingMeta('G'), ratingMeta(undefined), ratingMeta('R'), ratingMeta('X')]).toEqual(['Rated PG', 'Rated PG-13', 'Rated G', '', '', '']);
  });

  it('stays frozen: a settings change re-runs the gate but keeps the published rating; only a republish changes it', async () => {
    await publish(ctx, { visibility: 'unlisted' });
    withGate(gateFor({}, undefined, 'G'));
    clock += 1000;
    await updatePublication(ctx, { visibility: 'public' });
    expect(store.rows.get('proj-1')!.safety.rating).toBe('PG');
    expect(store.projects.get('proj-1')!.contentRating).toBe('PG');
    const regenerated = await regenerateLink(ctx);
    expect(store.rpcPayload(regenerated.slug!)!.publication.rating).toBe('PG');
    clock += 1000;
    const republished = await publish(ctx, { visibility: 'public' });
    expect(republished.rating).toBe('G');
    expect(store.projects.get('proj-1')!.contentRating).toBe('G');
  });

  it('a rating change after publishing marks the published version behind (its label would change); republishing clears it', async () => {
    const view = await publish(ctx, { visibility: 'public' });
    expect([view.rating, view.behind]).toEqual(['PG', false]);
    ctx.session.commit([{ op: 'settings', patch: { rating: 'G' } }], { origin: 'user' });
    const { getPublicationView } = await import('./index.js');
    const after = await getPublicationView(ctx);
    expect([after.rating, after.behind]).toEqual(['PG', true]); // the published label stays frozen until a republish
    withGate(gateFor({}, undefined, 'G'));
    clock += 1000;
    const republished = await publish(ctx, { visibility: 'public' });
    expect([republished.rating, republished.behind]).toEqual(['G', false]);
    // A legacy row without a recorded rating never trips it.
    const row = store.rows.get('proj-1')!;
    const { rating: _r, ...legacySafety } = row.safety;
    store.rows.set('proj-1', { ...row, safety: legacySafety });
    ctx.session.commit([{ op: 'settings', patch: { rating: 'PG' } }], { origin: 'user' });
    expect((await getPublicationView(ctx)).behind).toBe(false);
  });

  it('unpublish clears the gallery rating mirror and the owner view', async () => {
    await publish(ctx, { visibility: 'public' });
    const view = await unpublish(ctx);
    expect(store.projects.get('proj-1')!.contentRating).toBeNull();
    expect(view.rating).toBeUndefined();
  });

  it('a publication from before ratings still loads, with no rating key; a malformed stored rating is dropped', async () => {
    const view = await publish(ctx, { visibility: 'public' });
    const row = store.rows.get('proj-1')!;
    const { rating: _gone, ...legacySafety } = row.safety;
    store.rows.set('proj-1', { ...row, safety: legacySafety });
    const legacy = store.rpcPayload(view.slug!)!;
    expect(legacy.doc?.pages).toHaveLength(3);
    expect('rating' in legacy.publication).toBe(false);
    const fromId = await loadPublicByProjectId('proj-1');
    expect(fromId!.doc.pages).toHaveLength(3);
    expect('rating' in fromId!.publication).toBe(false);
    for (const bad of ['R', 'X', 'pg', 13, null, { r: 'PG' }]) {
      store.rows.set('proj-1', { ...row, safety: { ...legacySafety, rating: bad } });
      expect('rating' in store.rpcPayload(view.slug!)!.publication).toBe(false);
      expect('rating' in payloadOf(store.rows.get('proj-1')!)!.publication).toBe(false);
    }
  });

  it('a gate answer without a known rating publishes unlabelled (never guessed kids-friendly) and clears the mirror', async () => {
    withGate(gateFor({}, undefined, 'X' as never));
    const view = await publish(ctx, { visibility: 'public' });
    expect(store.rows.get('proj-1')!.safety.rating).toBeUndefined();
    expect(view.rating).toBeUndefined();
    expect(store.projects.get('proj-1')!.contentRating).toBeNull();
    expect('rating' in store.rpcPayload(view.slug!)!.publication).toBe(false);
  });
});

describe('S6: only art the server wrote to a lane clients cannot rewrite is published', () => {
  const spyGate = () => {
    const calls: unknown[] = [];
    restore();
    restore = configurePublication({
      store,
      gate: (async (c: unknown, d: ComicDoc, o: { pageIds: string[]; includeCover: boolean }) => (calls.push(o), gateFor()(c, d, o))) as never,
      now: () => clock,
      renderOg: fakeOg,
      publicUrl: (p) => `https://cdn.test/${p}`
    });
    return calls;
  };
  const withArt = (pageArt: Record<number, Partial<AssetRef>>, coverArt?: Partial<AssetRef>) => {
    const doc = richDoc();
    for (const p of doc.pages) if (pageArt[p.n]) p.render = { ...p.render, asset: { ...asset(`p${p.n}`), variants: undefined, ...pageArt[p.n] } as AssetRef };
    if (coverArt) doc.cover.render = { ...doc.cover.render, asset: { ...asset('cover'), variants: undefined, ...coverArt } as AssetRef };
    setup(doc);
    return spyGate();
  };

  it('a page using a classic-lane, tmp-lane or planted public upload is refused (422) before any check is paid for, nothing is copied', async () => {
    for (const outside of [
      { path: `${USER}/x.png`, source: 'upload' as const },
      { path: `u/${USER}/tmp/a.gif`, source: 'upload' as const },
      { path: `u/${USER}/p/proj-1/img/planted.webp`, source: 'upload' as const },
      { path: `u/${USER}/p/proj-1/img/../img/x.webp`, source: 'generated' as const },
      { path: 'somewhere/else/x.webp', source: 'generated' as const }
    ]) {
      const gateCalls = withArt({ 2: outside });
      const err = await publish(ctx, { visibility: 'unlisted' }).catch((e) => e);
      expect(err).toBeInstanceOf(PublishError);
      expect(err).toMatchObject({ status: 422, reason: 'NOT_READY', details: { outsideImages: { pages: [2], cover: false } } });
      expect(err.message).toMatch(/^Page 2 uses an image brought in from outside the studio/);
      expect(gateCalls).toHaveLength(0); // no platform-paid check spent
      expect(assets.copies).toHaveLength(0);
      expect(store.rows.size).toBe(0);
    }
  });

  it('a cover using an outside image is refused honestly too', async () => {
    const gateCalls = withArt({}, { path: `${USER}/cover.png`, source: 'upload' });
    await expect(publish(ctx, { visibility: 'unlisted' })).rejects.toMatchObject({ status: 422, reason: 'NOT_READY', details: { outsideImages: { pages: [], cover: true } } });
    expect(gateCalls).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it('excluding the outside page publishes the rest', async () => {
    withArt({ 2: { path: `${USER}/x.png`, source: 'upload' } });
    await publish(ctx, { visibility: 'unlisted', excludePageIds: ['pg_2'] });
    const row = store.rows.get('proj-1')!;
    expect(row.snapshot!.pages).toHaveLength(2);
    expect(assets.copies.some((c) => c.src === `${USER}/x.png`)).toBe(false);
  });

  it('server-made art publishes: an uploaded photo in the private ref lane, a derived crop, a library image (regression guard)', async () => {
    withArt({
      1: { path: `u/${USER}/p/proj-1/ref/photo.webp`, source: 'upload' },
      2: { path: `u/${USER}/p/proj-1/img/fit-1.webp`, source: 'derived' },
      3: { path: 'library/v1/style.noir-ink/3.webp', source: 'library' }
    });
    const view = await publish(ctx, { visibility: 'unlisted' });
    expect(view.status).toBe('live');
    expect(store.rows.get('proj-1')!.snapshot!.pages).toHaveLength(3);
  });

  it('readiness says so: never ok while publishing would refuse', async () => {
    const doc = richDoc();
    doc.pages[2].render = { ...doc.pages[2].render, asset: { ...asset('p3'), path: `u/${USER}/tmp/a.gif`, source: 'upload' } };
    doc.cover.render = { ...doc.cover.render, asset: { ...asset('cover'), path: `${USER}/c.png`, source: 'upload' } };
    const r = await getReadiness(ctx, doc);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      { kind: 'cover', status: OUTSIDE_IMAGE_STATUS },
      { kind: 'page', n: 3, status: OUTSIDE_IMAGE_STATUS }
    ]);
    expect((await getReadiness(ctx, richDoc())).ok).toBe(true);
  });

  it('the share image (OG card) is drawn only from a server-derived variant, never another path the asset names', async () => {
    withArt({}, { variants: [{ path: `u/${USER}/tmp/evil_w1080.webp`, w: 1080, h: 1620 }] });
    const loaded: string[] = [];
    const load = assets.loadDataUrl.bind(assets);
    assets.loadDataUrl = async (p) => (loaded.push(p), load(p));
    await publish(ctx, { visibility: 'unlisted' });
    expect(loaded.some((p) => p.includes('evil'))).toBe(false);
    expect(loaded).toContain(`u/${USER}/p/proj-1/img/cover.webp`);
  });

  it('a size variant is copied only from its deterministic server path (anything else is left out)', async () => {
    withArt({
      1: {
        variants: [
          { path: `u/${USER}/tmp/evil_w480.webp`, w: 480, h: 720 },
          { path: `u/${USER}/p/proj-1/img/p1_w1080.webp`, w: 1080, h: 1620 }
        ]
      }
    });
    await publish(ctx, { visibility: 'unlisted' });
    expect(assets.copies.some((c) => c.src.includes('evil'))).toBe(false);
    expect(assets.copies.some((c) => c.src === `u/${USER}/p/proj-1/img/p1_w1080.webp`)).toBe(true);
    const page1 = store.rows.get('proj-1')!.snapshot!.pages[0].render.asset!;
    expect(page1.variants!.map((v) => v.w)).toEqual([1080]);
  });
});

describe('S5: the owner-readable publication row carries no dollars', () => {
  it('safety keeps the rating and hash but never the platform cost', async () => {
    restore();
    restore = configurePublication({
      store,
      gate: (async (c: unknown, d: ComicDoc, o: { pageIds: string[]; includeCover: boolean }) => ({ ...(await gateFor()(c, d, o)), costUsd: 0.0042 })) as never,
      now: () => clock,
      renderOg: fakeOg,
      publicUrl: (p) => `https://cdn.test/${p}`
    });
    await publish(ctx, { visibility: 'unlisted' });
    const safety = store.rows.get('proj-1')!.safety;
    expect(safety).not.toHaveProperty('costUsd');
    expect(safety).toMatchObject({ rating: 'PG', checkedHash: 'h1' });
    expect(JSON.stringify(safety)).not.toContain('0.0042');
  });
});

describe('L11: a moderation hold takes the pub/ copies down', () => {
  const useAssets = () => {
    restore();
    restore = configurePublication({ store, gate: gateFor() as never, now: () => clock, renderOg: fakeOg, publicUrl: (p) => `https://cdn.test/${p}`, assets: async () => assets });
  };
  const pubFiles = (key: string) => [...assets.files.keys()].filter((p) => p.startsWith(`pub/${key}/`));

  it('after a hold suspends the row, removePublicationObjects deletes every pub/<key>/ object; the owner view shows no broken preview', async () => {
    useAssets();
    await publish(ctx, { visibility: 'public' });
    const key = store.rows.get('proj-1')!.assetKey!;
    expect(pubFiles(key).length).toBeGreaterThan(10);
    store.forcePrivate('proj-1');
    await removePublicationObjects('proj-1');
    expect(pubFiles(key)).toEqual([]);
    expect(store.rows.get('proj-1')!.status).toBe('suspended');
    const { getPublicationView } = await import('./index.js');
    const view = await getPublicationView(ctx);
    expect(view.status).toBe('suspended');
    expect(view.ogImageUrl).toBeUndefined();
  });

  it('never touches a live publication that is not held; never throws', async () => {
    useAssets();
    await publish(ctx, { visibility: 'public' });
    const key = store.rows.get('proj-1')!.assetKey!;
    const before = pubFiles(key).length;
    await removePublicationObjects('proj-1');
    expect(pubFiles(key)).toHaveLength(before);
    await expect(removePublicationObjects('missing-project')).resolves.toBeUndefined();
    await expect(removePublicationObjects('../etc')).resolves.toBeUndefined();
    store.forcePrivate('proj-1');
    assets.removePrefix = async () => {
      throw new Error('storage down');
    };
    await expect(removePublicationObjects('proj-1')).resolves.toBeUndefined();
  });

  it('a publish that raced the hold (row still live, project held) is suspended first, then taken down', async () => {
    useAssets();
    await publish(ctx, { visibility: 'public' });
    const key = store.rows.get('proj-1')!.assetKey!;
    store.projects.get('proj-1')!.forcedPrivate = true; // held, but the row was written live after the trigger ran
    await removePublicationObjects('proj-1');
    expect(store.rows.get('proj-1')!.status).toBe('suspended');
    expect(pubFiles(key)).toEqual([]);
  });

  it('republishing after the hold is lifted copies everything again under a fresh key and keeps the link', async () => {
    useAssets();
    const first = await publish(ctx, { visibility: 'public' });
    const oldKey = store.rows.get('proj-1')!.assetKey!;
    store.forcePrivate('proj-1');
    await removePublicationObjects('proj-1');
    store.projects.get('proj-1')!.forcedPrivate = false; // a moderator lifted the hold
    clock += 1000;
    const again = await publish(ctx, { visibility: 'public' });
    const row = store.rows.get('proj-1')!;
    expect(again.slug).toBe(first.slug);
    expect(row.status).toBe('live');
    expect(row.assetKey).not.toBe(oldKey);
    // Every object the reader payload points at exists again.
    const payload = payloadOf(row)!;
    expect(Object.keys(payload.urls).length).toBeGreaterThan(10);
    for (const p of Object.keys(payload.urls)) expect(assets.files.has(p)).toBe(true);
    expect(pubFiles(oldKey)).toEqual([]);
  });

  it('the sweep also removes copies of publications suspended longer than the grace period', async () => {
    useAssets();
    await publish(ctx, { visibility: 'public' });
    const key = store.rows.get('proj-1')!.assetKey!;
    store.rows.set('proj-1', { ...store.rows.get('proj-1')!, status: 'suspended', updatedAt: clock });
    const removed: string[] = [];
    const sweeper = { removePrefix: async (p: string) => (removed.push(p), 1) };
    await sweepOrphanPublications(sweeper);
    expect(removed).toEqual([]); // inside the grace period: left alone
    clock += SWEEP_GRACE_MS + 1;
    await sweepOrphanPublications(sweeper);
    expect(removed).toEqual([`pub/${key}/`]);
  });

  // A hold lands (projects trigger + the takedown F4 runs right after it) while a publication write
  // is still checking or copying: the write must not leave a LIVE row on a held comic.
  const holdNow = async () => {
    store.forcePrivate('proj-1');
    await removePublicationObjects('proj-1');
  };
  const holdDuringGate = () => {
    restore();
    restore = configurePublication({
      store,
      gate: (async (c: unknown, d: ComicDoc, o: { pageIds: string[]; includeCover: boolean }) => (await holdNow(), gateFor()(c, d, o))) as never,
      now: () => clock,
      renderOg: fakeOg,
      publicUrl: (p) => `https://cdn.test/${p}`,
      assets: async () => assets
    });
  };
  const allPub = () => [...assets.files.keys()].filter((p) => p.startsWith('pub/'));

  it('a first publish whose checks outlast a hold ends suspended with no copies left, and says so honestly', async () => {
    holdDuringGate();
    const err = await publish(ctx, { visibility: 'public' }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err).toMatchObject({ status: 403, reason: 'FORBIDDEN' });
    expect(err.message).toMatch(/paused by DreamStream moderation/);
    expect(store.rows.get('proj-1')!.status).toBe('suspended');
    expect(allPub()).toEqual([]);
    expect(store.projects.get('proj-1')!.isPublic).toBe(false);
    expect(ctx.session.doc.publication?.status).toBe('suspended');
    expect(payloadOf(store.rows.get('proj-1')!)).toBeNull();
  });

  it('an update whose checks outlast a hold is suspended too (never a live row pointing at copies the takedown deleted)', async () => {
    useAssets();
    await publish(ctx, { visibility: 'public' });
    const key = store.rows.get('proj-1')!.assetKey!;
    holdDuringGate();
    clock += 1000;
    await expect(publish(ctx, { visibility: 'public' })).rejects.toMatchObject({ status: 403, reason: 'FORBIDDEN' });
    expect(store.rows.get('proj-1')!.status).toBe('suspended');
    expect(pubFiles(key)).toEqual([]);
    // Once the hold is lifted, republishing heals it under a fresh key (nothing points at deleted copies).
    store.projects.get('proj-1')!.forcedPrivate = false;
    useAssets();
    clock += 1000;
    await publish(ctx, { visibility: 'public' });
    const row = store.rows.get('proj-1')!;
    expect(row.status).toBe('live');
    for (const p of Object.keys(payloadOf(row)!.urls)) expect(assets.files.has(p)).toBe(true);
  });

  it('going public while a hold lands is refused and the row suspended', async () => {
    useAssets();
    await publish(ctx, { visibility: 'unlisted' });
    holdDuringGate();
    await expect(updatePublication(ctx, { visibility: 'public' })).rejects.toMatchObject({ status: 403, reason: 'FORBIDDEN' });
    expect(store.rows.get('proj-1')!.status).toBe('suspended');
    expect(allPub()).toEqual([]);
  });

  it('a new link made while a hold lands is suspended and both keys are taken down', async () => {
    useAssets();
    await publish(ctx, { visibility: 'public' });
    const copy = assets.copyObject.bind(assets);
    let first = true;
    assets.copyObject = async (src, dst) => {
      if (first) {
        first = false;
        await holdNow();
      }
      return copy(src, dst);
    };
    await expect(regenerateLink(ctx)).rejects.toMatchObject({ status: 403, reason: 'FORBIDDEN' });
    expect(store.rows.get('proj-1')!.status).toBe('suspended');
    expect(allPub()).toEqual([]);
  });

  it('no hold: the extra check changes nothing (publish, settings, new link all stay live)', async () => {
    useAssets();
    await publish(ctx, { visibility: 'unlisted' });
    await updatePublication(ctx, { visibility: 'public' });
    await regenerateLink(ctx);
    const row = store.rows.get('proj-1')!;
    expect(row.status).toBe('live');
    for (const p of Object.keys(payloadOf(row)!.urls)) expect(assets.files.has(p)).toBe(true);
  });
});

describe('published editions stay complete over the snapshot itself (queue: editionProgress needs)', () => {
  /** A doc whose Hindi edition is publishable: every line translated + reviewed against its CURRENT source, one never-translated line. */
  const translatedDoc = () => {
    const doc = richDoc();
    doc.format = { ...doc.format, lettering: 'overlay' };
    const lines = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
    const spell = lines[0];
    spell.noTranslate = true;
    spell.text = 'ZZZAP-SPELL';
    const translated = Object.fromEntries(
      lines.filter((l) => l !== spell && l.text.trim()).map((l) => [l.id, { text: `HI:${l.text}`, status: 'reviewed' as const, sourceHash: lineSourceHash(l), gloss: PRIVATE.gloss, at: 1 }])
    );
    doc.i18n = { editions: { hi: { lang: 'hi', lines: translated, balloons: {}, register: 'everyday' } }, glossary: [] };
    return { doc, spell };
  };
  const snapOf = (doc: ComicDoc, pageIds = doc.pages.map((p) => p.id)) =>
    buildPublicSnapshot(doc, { ...planSnapshot(doc, { assetKey: 'K'.repeat(22), pageIds, includeCover: true, languages: ['en', 'hi'] }), publicationId: 'pub-uuid', publishedAt: 1, rev: 1 });

  it('a publishable edition is still publishable, complete and fallback-free when read from the public snapshot', () => {
    const { doc, spell } = translatedDoc();
    expect(editionReadiness(doc, 'hi').publishable).toBe(true); // precondition: what publish() requires
    const snapshot = snapOf(doc);
    const p = editionProgress(snapshot, 'hi');
    expect([p.missing, p.stale, p.staleEdited]).toEqual([0, 0, 0]); // routes readerLanguages → complete: true
    expect(p.done).toBe(p.total);
    expect(editionReadiness(snapshot, 'hi').publishable).toBe(true); // the legacy reader's language list offers it
    expect(fallbackLineIds(localizeDoc(snapshot, 'hi'))).toEqual([]); // no "N lines untranslated" chip on a published edition
    const pubSpell = snapshot.pages.flatMap((pg) => pg.panels.flatMap((pn) => pn.lines)).find((l) => l.id === spell.id)!;
    expect(pubSpell).toMatchObject({ noTranslate: true, text: 'ZZZAP-SPELL' });
    // The localized reader keeps the spell in the source language (its script font), not a translation.
    const localizedSpell = localizeDoc(snapshot, 'hi').pages.flatMap((pg) => pg.panels.flatMap((pn) => pn.lines)).find((l) => l.id === spell.id)!;
    expect(localizedSpell).toMatchObject({ text: 'ZZZAP-SPELL', lang: doc.format.language });
    // Still the public projection: no gloss, model or issue; status reviewed; at 0.
    const entry = Object.values(snapshot.i18n!.editions.hi.lines)[0];
    expect(Object.keys(entry).sort()).toEqual(['at', 'sourceHash', 'status', 'text']);
    expect(JSON.stringify(snapshot)).not.toContain(PRIVATE.gloss);
  });

  it('a translation that was stale in the live doc keeps an empty hash (never vouched for), and only published lines carry one', () => {
    const { doc } = translatedDoc();
    const lines = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).filter((l) => !l.noTranslate && l.text.trim());
    const staleId = lines[1].id;
    doc.i18n!.editions.hi.lines[staleId] = { ...doc.i18n!.editions.hi.lines[staleId], sourceHash: 'old-hash' };
    const snapshot = snapOf(doc);
    const hi = snapshot.i18n!.editions.hi.lines;
    expect(hi[staleId].sourceHash).toBe('');
    expect(editionProgress(snapshot, 'hi').stale).toBe(1);
    for (const l of lines.filter((x) => x.id !== staleId)) expect(hi[l.id].sourceHash).toBe(lineSourceHash(l));
  });

  it('render error details and other private render fields never reach the snapshot', () => {
    const doc = richDoc();
    doc.pages[0].render = { ...doc.pages[0].render, error: 'PRIVATE-RENDER-ERROR', errorDetail: { code: 'PROVIDER_429', provider: 'PRIVATE-PROVIDER', at: 1, text: 'PRIVATE-ERROR-DETAIL' }, attempts: 3 };
    const json = JSON.stringify(snapOf(doc));
    for (const leaked of ['PRIVATE-RENDER-ERROR', 'PRIVATE-PROVIDER', 'PRIVATE-ERROR-DETAIL', 'errorDetail', '"attempts"']) expect(json).not.toContain(leaked);
  });
});

describe('withheld content never reaches the public payload', () => {
  it('an excluded page: no art, no text, no translation of its lines, no balloons override; only pub/<key>/ images', () => {
    const doc = richDoc();
    doc.pages[1].panels = doc.pages[1].panels.map((pn) => ({ ...pn, lines: pn.lines.map((l) => ({ ...l, text: 'WITHHELD-SOURCE-LINE' })) }));
    doc.i18n = {
      editions: {
        hi: {
          lang: 'hi',
          lines: {
            ln_1_2: { text: 'पहला', status: 'machine', sourceHash: 'x', at: 1 },
            ln_2_2: { text: 'WITHHELD-HI-LINE', status: 'machine', sourceHash: 'x', at: 1 },
            ln_gone: { text: 'ORPHAN-HI-LINE', status: 'machine', sourceHash: 'x', at: 1 }
          },
          cover: { title: { text: 'मसाला दौड़', status: 'machine', sourceHash: 'x', at: 1 } },
          balloons: { ln_1_2: { x: 0.2 }, ln_2_2: { x: 0.3 }, ln_gone: { x: 0.4 } } as never,
          register: 'everyday'
        }
      },
      glossary: []
    };
    const keep = ['pg_1', 'pg_3'];
    const plan = { ...planSnapshot(doc, { assetKey: 'K'.repeat(22), pageIds: keep, includeCover: true, languages: ['en', 'hi'] }), publicationId: 'pub-uuid', publishedAt: 1, rev: 1 };
    const snapshot = buildPublicSnapshot(doc, plan);
    const json = JSON.stringify(snapshot);
    for (const leaked of ['WITHHELD-SOURCE-LINE', 'WITHHELD-HI-LINE', 'ORPHAN-HI-LINE', 'p2.webp', 'p2_w480', 'pg_2']) expect(json).not.toContain(leaked);
    const hi = snapshot.i18n!.editions.hi;
    expect(Object.keys(hi.lines)).toEqual(['ln_1_2']);
    expect(Object.keys(hi.balloons)).toEqual(['ln_1_2']);
    expect(hi.cover?.title?.text).toBe('मसाला दौड़');
    expect(snapshot.pages.map((p) => p.id)).toEqual(keep);
    expect(Object.keys(plan.paths).some((p) => p.includes('/p2'))).toBe(false);
  });

  it('a blocked cover and an excluded page are absent from the anon RPC payload; every url is a pub/<key>/ path', async () => {
    setup(richDoc(), { pg_2: 'blocked', cover: 'blocked' });
    const view = await publish(ctx, { visibility: 'unlisted', excludePageIds: ['pg_2'] });
    const row = store.rows.get('proj-1')!;
    const payload = payloadOf(row)!;
    expect(payload.doc.cover.render.status).toBe('none');
    expect(payload.doc.pages.map((p) => p.id)).toEqual(['pg_1', 'pg_3']);
    expect(Object.keys(payload.urls).every((p) => p.startsWith(`pub/${row.assetKey}/`) && !p.includes('cover'))).toBe(true);
    expect(JSON.stringify(store.rpcPayload(view.slug!))).not.toMatch(/u\/user-1|proj-1|\/ref\//);
    // The anon RPC never hands out the owner, the project or the safety summary.
    expect(Object.keys(store.rpcPayload(view.slug!)!.publication).sort()).toEqual(
      ['allowDownload', 'allowEmbed', 'assetKey', 'card', 'defaultLang', 'languages', 'publishedAt', 'rating', 'slug', 'startPage', 'updatedAt', 'visibility'].sort()
    );
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
    // The rating joins the hash only when set: an unrated card keeps its earlier URL; rated cards differ by rating.
    expect(ogHash({ ...base, rating: undefined })).toBe(ogHash(base));
    expect(ogHash({ ...base, rating: 'PG' })).not.toBe(ogHash(base));
    expect(ogHash({ ...base, rating: 'PG' })).not.toBe(ogHash({ ...base, rating: 'PG-13' }));
    expect(ogHash({ ...base, rating: 'R' as never })).toBe(ogHash(base));
  });

  it('renders inside the shared 3-slot sharp gate: waits while every slot is busy, then completes', async () => {
    await renderOgCard({ title: 'Warm-up', subtitle: '', kindLabel: 'Comic', pageCount: 1, lang: 'en', coverBuf: null, fallbackPageBuf: null, showMark: true, themeColor: '#336699' });
    __resetSharpSlotPeakForTests();
    let release!: () => void;
    const latch = new Promise<void>((r) => (release = r));
    const holders = [0, 1, 2].map(() => withSharpSlot(() => latch));
    let done = false;
    const card = renderOgCard({ title: 'Queued', subtitle: 'Rated card', kindLabel: 'Comic', pageCount: 2, lang: 'en', coverBuf: await cover(), fallbackPageBuf: null, showMark: true, rating: 'PG' }).then((o) => ((done = true), o));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    expect(sharpSlotStats().queued).toBeGreaterThanOrEqual(1);
    release();
    await Promise.all(holders);
    const out = await card;
    expect(done).toBe(true);
    expect((await sharp(out.jpeg).metadata()).width).toBe(1200);
    expect(sharpSlotStats().peak).toBeLessThanOrEqual(3);
  }, 30_000);

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
