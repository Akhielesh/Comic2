import { describe, expect, it } from 'vitest';
import {
  collectAssetPaths,
  createEmptyDoc,
  emptyRender,
  getRender,
  isPageStale,
  normalizeDoc,
  pageSpecHash,
  type AssetRef,
  type ComicDoc,
  type Page
} from './doc';
import { applyOps, isSpendAction, layoutFixOps, CLIENT_PATCHABLE_OPS } from './ops';
import {
  IMAGE_MODELS,
  TIER_PRESETS,
  estimateJobs,
  formatUsd,
  getImageModel,
  imagePriceUsd,
  nearestAspect,
  resolveImageJob,
  PLATFORM_MARKUP
} from './models';
import { STYLE_PRESETS } from './stylePresets';

const asset = (path: string): AssetRef => ({ path, source: 'generated', at: 1 });

const page = (id: string, n: number): Page => ({
  id,
  n,
  summary: `Page ${n}`,
  layout: 'Row 1: one wide panel.',
  panels: [
    {
      id: `${id}_p1`,
      n: 1,
      size: 'wide',
      shot: 'establishing',
      action: 'Rain over the city.',
      castIds: ['c1'],
      lines: [{ id: `${id}_l1`, kind: 'caption', text: 'Tokyo, 3 a.m.' }]
    }
  ],
  render: emptyRender(),
  balloons: []
});

const baseDoc = (): ComicDoc => {
  const doc = createEmptyDoc('proj', 'Neon Paws', 1000);
  return applyOps(doc, [
    { op: 'character', id: 'c1', patch: { name: 'Miso', tier: 'lead', look: { summary: 'A grey tabby detective cat in a trench coat' } } },
    { op: 'pages', pages: [page('pg1', 1), page('pg2', 2)] }
  ]);
};

describe('normalizeDoc', () => {
  it('fills every default on a sparse stored document', () => {
    const doc = normalizeDoc({ id: 'x', pages: [{ id: 'p', panels: [{ id: 'q' }] }] } as never);
    expect(doc.format.pageAspect).toBe('2:3');
    expect(doc.settings.quality).toBe('standard');
    expect(doc.pages[0].n).toBe(1);
    expect(doc.pages[0].render.history).toEqual([]);
    expect(doc.pages[0].panels[0].castIds).toEqual([]);
    expect(doc.planStatus).toBe('draft');
    expect(doc.gate).toBeNull();
  });

  it('is idempotent', () => {
    const once = normalizeDoc(baseDoc());
    expect(normalizeDoc(once)).toEqual(once);
  });
});

describe('applyOps', () => {
  it('does not mutate its input', () => {
    const doc = baseDoc();
    const snapshot = JSON.stringify(doc);
    applyOps(doc, [{ op: 'brief', patch: { logline: 'A cat solves crimes.' } }]);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('upserts characters and merges look fields', () => {
    const doc = applyOps(baseDoc(), [{ op: 'character', id: 'c1', patch: { look: { hair: 'grey fur' } as never } }]);
    expect(doc.cast[0].look.summary).toContain('tabby');
    expect(doc.cast[0].look.hair).toBe('grey fur');
  });

  it('removing a character strips it from panel casts', () => {
    const doc = applyOps(baseDoc(), [{ op: 'character_remove', id: 'c1' }]);
    expect(doc.cast).toHaveLength(0);
    expect(doc.pages[0].panels[0].castIds).toEqual([]);
  });

  it('pushes the previous asset into render history on re-render', () => {
    let doc = applyOps(baseDoc(), [{ op: 'render', target: { kind: 'page', id: 'pg1' }, patch: { status: 'ready', asset: asset('a1') } }]);
    doc = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg1' }, patch: { asset: asset('a2') } }]);
    const render = getRender(doc, { kind: 'page', id: 'pg1' })!;
    expect(render.asset?.path).toBe('a2');
    expect(render.history.map((a) => a.path)).toEqual(['a1']);
  });

  it('deleting a line also drops its balloon', () => {
    let doc = applyOps(baseDoc(), [{ op: 'balloon', pageId: 'pg1', lineId: 'pg1_l1', patch: { x: 0.2 } }]);
    expect(doc.pages[0].balloons).toHaveLength(1);
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg1', panelId: 'pg1_p1', id: 'pg1_l1', patch: null }]);
    expect(doc.pages[0].panels[0].lines).toHaveLength(0);
    expect(doc.pages[0].balloons).toHaveLength(0);
  });

  it('accumulates spend by kind and caps entries', () => {
    const doc = applyOps(baseDoc(), [
      { op: 'spend', entry: { id: 's1', at: 1, kind: 'page', label: 'Page 1', usd: 0.0655, byok: false, estimated: false } },
      { op: 'spend', entry: { id: 's2', at: 2, kind: 'page', label: 'Page 2', usd: 0.0655, byok: true, estimated: true } },
      { op: 'spend', entry: { id: 's3', at: 3, kind: 'chat', label: 'Director', usd: -5, byok: false, estimated: false } }
    ]);
    expect(doc.spend.totalUsd).toBeCloseTo(0.131, 4);
    expect(doc.spend.byKind.page).toBeCloseTo(0.131, 4);
    expect(doc.spend.byKind.chat).toBe(0);
    expect(doc.spend.entries[0].id).toBe('s3');
  });

  it('renumbers pages when the plan is replaced', () => {
    const doc = applyOps(baseDoc(), [{ op: 'pages', pages: [page('b', 5), page('a', 2)] }]);
    expect(doc.pages.map((p) => [p.id, p.n])).toEqual([
      ['a', 1],
      ['b', 2]
    ]);
  });

  it('message op replaces by id and keeps order', () => {
    let doc = applyOps(baseDoc(), [{ op: 'message', msg: { id: 'm1', role: 'user', text: 'hi', at: 1 } }]);
    doc = applyOps(doc, [{ op: 'message', msg: { id: 'm1', role: 'user', text: 'hello', at: 1 } }]);
    expect(doc.conversation).toHaveLength(1);
    expect(doc.conversation[0].text).toBe('hello');
  });
});

describe('staleness and assets', () => {
  it('marks a ready page stale when its script changes', () => {
    let doc = baseDoc();
    const hash = pageSpecHash(doc, doc.pages[0]);
    doc = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg1' }, patch: { status: 'ready', asset: asset('a1'), specHash: hash } }]);
    expect(isPageStale(doc, doc.pages[0])).toBe(false);
    doc = applyOps(doc, [{ op: 'panel', pageId: 'pg1', id: 'pg1_p1', patch: { action: 'Sunrise over the city.' } }]);
    expect(isPageStale(doc, doc.pages[0])).toBe(true);
  });

  it('overlay dialogue edits do not stale a page; in-art ones do', () => {
    let doc = baseDoc();
    const hash = pageSpecHash(doc, doc.pages[0]);
    doc = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg1' }, patch: { status: 'ready', asset: asset('a1'), specHash: hash } }]);
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg1', panelId: 'pg1_p1', id: 'pg1_l1', patch: { text: 'Tokyo, 4 a.m.' } }]);
    expect(isPageStale(doc, doc.pages[0])).toBe(false);
    doc = applyOps(doc, [{ op: 'format', patch: { lettering: 'in_art' } }]);
    expect(isPageStale(doc, doc.pages[0])).toBe(true);
  });

  it('collects every referenced asset path once', () => {
    const doc = applyOps(baseDoc(), [
      { op: 'render', target: { kind: 'page', id: 'pg1' }, patch: { status: 'ready', asset: asset('p1') } },
      { op: 'render', target: { kind: 'page', id: 'pg1' }, patch: { asset: asset('p2') } },
      { op: 'render', target: { kind: 'sheet', id: 'c1' }, patch: { status: 'ready', asset: asset('s1') } },
      { op: 'style', patch: { board: asset('b1'), refs: [asset('r1')] } }
    ]);
    expect(collectAssetPaths(doc).sort()).toEqual(['b1', 'p1', 'p2', 'r1', 's1']);
  });
});

describe('model registry', () => {
  it('every tier resolves to a known, non-deprecated model with a price', () => {
    for (const preset of Object.values(TIER_PRESETS)) {
      const spec = getImageModel(preset.model);
      expect(spec).toBeDefined();
      expect(spec!.lifecycle).not.toBe('deprecated');
      expect(imagePriceUsd(spec!, preset.pageRes)).toBeGreaterThan(0);
      expect(spec!.refs.characters).toBeGreaterThanOrEqual(4);
    }
  });

  it('ids and provider routes are unique', () => {
    const ids = IMAGE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const routes = IMAGE_MODELS.flatMap((m) => Object.values(m.routes));
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('looks models up by provider route id too', () => {
    expect(getImageModel('google/gemini-3-pro-image')?.id).toBe('nano-banana-pro');
  });

  it('routes style exploration to the cheap model regardless of tier', () => {
    expect(resolveImageJob('style_option', 'pro').spec.id).toBe('nano-banana-2.1');
    expect(resolveImageJob('page', 'pro').spec.id).toBe('nano-banana-pro');
    expect(resolveImageJob('page', 'draft').resolution).toBe('1K');
  });

  it('honors a usable override and snaps the resolution', () => {
    const job = resolveImageJob('page', 'standard', 'nano-banana-lite');
    expect(job.spec.id).toBe('nano-banana-lite');
    expect(job.resolution).toBe('1K');
  });

  it('snaps unsupported aspects to the nearest supported one', () => {
    const pro = getImageModel('nano-banana-pro')!;
    expect(nearestAspect(pro, '1:4')).toBe('9:16');
    expect(nearestAspect(pro, '2:3')).toBe('2:3');
  });

  it('estimates include markup unless BYOK', () => {
    const platform = estimateJobs([{ kind: 'page', count: 6 }], 'standard');
    const byok = estimateJobs([{ kind: 'page', count: 6 }], 'standard', { byok: true });
    expect(platform.usd).toBeCloseTo(byok.usd * PLATFORM_MARKUP, 3);
    expect(platform.imageCount).toBe(6);
    expect(platform.model).toBe('Nano Banana 2.1');
  });

  it('formats money for humans', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0.4212)).toBe('$0.42');
  });
});

describe('actions and presets', () => {
  it('classifies spend actions', () => {
    expect(isSpendAction({ type: 'render_pages' })).toBe(true);
    expect(isSpendAction({ type: 'pick_style', optionId: 'x' })).toBe(false);
  });

  it('never lets clients patch billing, renders or gates', () => {
    for (const op of ['spend', 'render', 'gate', 'message', 'memory', 'pages'] as const) {
      expect(CLIENT_PATCHABLE_OPS.has(op)).toBe(false);
    }
  });

  it('style presets carry executable art direction', () => {
    const ids = STYLE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of STYLE_PRESETS) {
      expect(preset.spec.split(/\s+/).length).toBeGreaterThanOrEqual(25);
      expect(preset.swatch).toMatch(/gradient/);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// v5 shared contract (contract §16)
// ═════════════════════════════════════════════════════════════════════════════

import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import {
  DEFAULT_BOOK,
  DEFAULT_READER,
  archiveOf,
  castNoun,
  coverSpecHash,
  currentVersion,
  displayAssetPaths,
  hashString,
  isTargetStale,
  legacyPlanInputHashOf,
  legacySpecHashFor,
  normalizeNoticeCard,
  placeSpecHash,
  planInputHashOf,
  stableStringify,
  type Card,
  type QcReport,
  mapAssetRefs,
  parseTargetKey,
  renderTargetKey,
  sheetSpecHash,
  targetLabel,
  thumbOf,
  trashOf,
  variantFor,
  versionsOf,
  type ArchivedVersion,
  type Line,
  type Panel,
  type RenderVersion
} from './doc';
import {
  NON_SPEND_ACTION_TYPES,
  SAFE_ID_RE,
  SERVER_ONLY_OPS,
  SPEND_ACTION_TYPES,
  applyOp,
  type DocOp,
  type StudioAction
} from './ops';
import { encodeStudioEvent } from './events';
import { ASPECT_TOLERANCE, aspectFromSize, aspectMatches } from './models';
import { DOC_LIMITS, MAX_ARCHIVE, MAX_RENDER_HISTORY, MAX_TRASH } from './limits';
import { lineSourceHash } from './i18n';

/** The pre-v5 pageSpecHash, verbatim (doc.ts:548-568 at HEAD 390621d). The R2 reference implementation. */
const legacyPageSpecHash = (doc: ComicDoc, page: Page): string => {
  const castIds = new Set(page.panels.flatMap((p) => p.castIds));
  const cast = doc.cast
    .filter((c) => castIds.has(c.id))
    .map((c) => [c.id, c.look, c.sheet.asset?.path || ''])
    .sort();
  const lettering = doc.format.lettering === 'in_art' ? page.panels.map((p) => p.lines) : [];
  return hashString(
    JSON.stringify([
      page.layout,
      page.panels.map((p) => [p.size, p.shot, p.angle, p.action, p.castIds, p.placeId, p.mood]),
      lettering,
      cast,
      doc.style.spec,
      doc.style.board?.path,
      doc.format.pageAspect,
      doc.format.colorMode,
      doc.format.lettering
    ])
  );
};

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
};

/** The owner's live v4 doc shape ("Playtime at the Lake"): storybook, overlay, 1 page, 4 panels, The Baby. */
const ownerLiveDoc = (): ComicDoc => {
  const doc = createEmptyDoc('d_lake', 'Playtime at the Lake', 1_761_000_000_000) as Partial<ComicDoc> & { id: string };
  // Stored v4 docs have none of the v5 keys.
  for (const k of ['letterStyle', 'book', 'reader', 'archive', 'trash', 'refInbox', 'i18n'] as const) delete doc[k];
  doc.brief = { title: 'Playtime at the Lake', audience: 'kids 2–6', setting: 'a sunny lake', genre: 'storybook', notes: [] };
  doc.format = { kind: 'storybook', pageCount: 1, pageAspect: '4:5', panelsPerPage: 4, readingDirection: 'ltr', lettering: 'overlay', colorMode: 'color', language: 'en' };
  doc.style = { status: 'locked', name: 'Storybook watercolor', spec: 'Soft storybook watercolor, rounded shapes, warm pastels.', refs: [], options: [], board: { path: 'u/o/p/d/img/board.webp', source: 'generated', at: 1 } };
  doc.cast = [
    {
      id: 'c_baby', name: 'The Baby', tier: 'lead', look: { summary: 'A chubby toddler in a yellow romper' }, refs: [],
      sheet: { status: 'ready', history: [], asset: { path: 'u/o/p/d/img/baby.webp', source: 'generated', at: 2, w: 1536, h: 1024 } }
    }
  ];
  const panel = (n: number, action: string, castIds: string[], text: string): Panel => ({
    id: `pn${n}`, n, size: 'medium', shot: n === 1 ? 'wide' : 'medium', action, castIds,
    lines: [{ id: `ln${n}`, kind: n === 1 ? 'caption' : 'speech', text, ...(n === 1 ? {} : { speakerId: 'c_baby' }) }]
  });
  doc.pages = [
    {
      id: 'pg_1', n: 1, summary: 'The baby plays by the lake with ducklings, a frog and a bunny.',
      layout: 'Row 1: two equal panels side by side (panels 1–2). Row 2: two equal panels side by side (panels 3–4).',
      panels: [
        panel(1, 'The baby sits on a picnic blanket by the lake.', ['c_baby'], 'One sunny morning…'),
        panel(2, 'Three yellow ducklings waddle up to the baby.', ['c_baby'], 'Quack!'),
        panel(3, 'A green frog hops onto a lily pad.', ['c_baby'], 'Hop hop!'),
        panel(4, 'A bunny and the baby share a giggle.', ['c_baby'], 'Friends!')
      ],
      render: { status: 'ready', history: [], asset: { path: 'u/o/p/d/img/p1.webp', source: 'generated', at: 3, w: 2048, h: 2048 } },
      balloons: [{ lineId: 'ln2', x: 0, y: 0.1, w: 0.25 }, { lineId: 'ln3', x: 0.75, y: 0.5, w: 0.25, pinned: true }]
    }
  ];
  const d = doc as ComicDoc;
  d.pages[0].render.specHash = legacyPageSpecHash(d, d.pages[0]);
  return d;
};

const inArtSample = () => makeSampleDoc((x) => { x.format = { ...x.format, lettering: 'in_art' }; });

/** What Postgres jsonb does to object key order on save: shorter keys first, then bytewise (comic_docs.doc is jsonb). */
const jsonbOrder = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(jsonbOrder)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
            .map((k) => [k, jsonbOrder((v as Record<string, unknown>)[k])])
        )
      : v;
/** A save + reload through jsonb, then the load path. */
const jsonbReload = (doc: ComicDoc): ComicDoc => normalizeDoc(jsonbOrder(JSON.parse(JSON.stringify(doc))) as ComicDoc);

describe('v5 §16.1 hash invariance (R2, after back-compat F1)', () => {
  it('pins the sample fixture hashes: canonical (F1) and the pre-F1 serialisation kept for legacy acceptance', () => {
    const overlay = makeSampleDoc();
    // Captured at HEAD before v5 (the pre-F1 serialisation), then the canonical value (the cast looks' keys sorted).
    expect(overlay.pages.map((p) => legacySpecHashFor(overlay, { kind: 'page', id: p.id }))).toEqual(Array(6).fill('65e6794f'));
    expect(overlay.pages.map((p) => pageSpecHash(overlay, p))).toEqual(Array(6).fill('e14eb277'));
    const inArt = inArtSample();
    // The pre-F1 serialisation (what stored renders carry) is still computable, byte for byte.
    expect(inArt.pages.map((p) => legacySpecHashFor(inArt, { kind: 'page', id: p.id }))).toEqual(['5e8d87fe', 'ae4db5c3', 'bc65b954', '365ca7d9', '44c4315a', 'f1f9b257']);
    expect(inArt.pages.map((p) => legacyPageSpecHash(inArt, p))).toEqual(['5e8d87fe', 'ae4db5c3', 'bc65b954', '365ca7d9', '44c4315a', 'f1f9b257']);
    // The canonical hash (lines serialised with sorted keys).
    const canonical = ['174ae924', '0c816205', '0aa93f1e', 'a6649a67', '2967d570', '7aeb7621'];
    expect(inArt.pages.map((p) => pageSpecHash(inArt, p))).toEqual(canonical);
    // …and after normalizeDoc (the load path) and a jsonb round trip the hashes are still identical.
    const norm = normalizeDoc(inArtSample());
    expect(norm.pages.map((p) => pageSpecHash(norm, p))).toEqual(canonical);
    const reloaded = jsonbReload(inArtSample());
    expect(reloaded.pages.map((p) => pageSpecHash(reloaded, p))).toEqual(canonical);
  });

  it('(a) owner live doc and (b) in_art 6-page speakers fixture: the legacy stamp is reproduced after normalizeDoc; the canonical hash survives jsonb', () => {
    for (const raw of [ownerLiveDoc(), inArtSample(), makeSampleDoc()]) {
      const legacy = raw.pages.map((p) => legacyPageSpecHash(raw, p));
      const doc = normalizeDoc(JSON.parse(JSON.stringify(raw)));
      // normalizeDoc keeps key order: the "as loaded" variant of the load-time acceptance reproduces the stamp.
      expect(doc.pages.map((p) => legacySpecHashFor(doc, { kind: 'page', id: p.id }))).toEqual(legacy);
      const canonical = doc.pages.map((p) => pageSpecHash(doc, p));
      const reloaded = jsonbReload(raw);
      expect(reloaded.pages.map((p) => pageSpecHash(reloaded, p))).toEqual(canonical);
    }
    // A canonical stamp never goes stale on reload; a pre-F1 stamp reads stale until session.ts recoveryOps migrates it.
    const live = normalizeDoc(ownerLiveDoc());
    expect(isPageStale(live, live.pages[0])).toBe(live.pages[0].render.specHash !== pageSpecHash(live, live.pages[0]));
    const stamped = applyOps(live, [{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { specHash: pageSpecHash(live, live.pages[0]) } }]);
    const back = jsonbReload(stamped);
    expect(isPageStale(back, back.pages[0])).toBe(false);
  });

  it('(c) style / lang / noTranslate on lines are never hashed', () => {
    const plain = inArtSample();
    const decorated = inArtSample();
    for (const page of decorated.pages)
      for (const panel of page.panels)
        panel.lines = panel.lines.map((l): Line => ({ ...l, style: { font: 'bangers', sizeScale: 1.4 }, lang: 'hi', noTranslate: true }));
    expect(decorated.pages.map((p) => pageSpecHash(decorated, p))).toEqual(plain.pages.map((p) => pageSpecHash(plain, p)));
  });

  it('group characters (count > 1) change the hash; count 1 does not; kind/species absent never churn', () => {
    const base = makeSampleDoc();
    const page = base.pages[0];
    const h0 = pageSpecHash(base, page);
    const one = { ...base, cast: base.cast.map((c) => (c.id === 'ch_maya' ? { ...c, count: 1, kind: 'animal' as const } : c)) };
    expect(pageSpecHash(one, page)).toBe(h0);
    const three = { ...base, cast: base.cast.map((c) => (c.id === 'ch_maya' ? { ...c, count: 3 } : c)) };
    expect(pageSpecHash(three, page)).not.toBe(h0);
    const species = { ...base, cast: base.cast.map((c) => (c.id === 'ch_maya' ? { ...c, look: { ...c.look, species: 'mallard duckling' } } : c)) };
    expect(pageSpecHash(species, page)).not.toBe(h0);
  });

  it('chapterTitle, n, translations and balloons are not hashed', () => {
    const doc = normalizeDoc(makeSampleDoc());
    const h = pageSpecHash(doc, doc.pages[0]);
    const next = applyOps(doc, [
      { op: 'page', id: 'pg_1', patch: { chapterTitle: 'Chapter One' } },
      { op: 'pages_reorder', order: ['pg_2', 'pg_1'] },
      { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1', patch: { x: 0.5, z: 3 } },
      { op: 'edition', lang: 'hi', patch: {} }
    ]);
    const p1 = next.pages.find((p) => p.id === 'pg_1')!;
    expect(p1.n).toBe(2);
    expect(pageSpecHash(next, p1)).toBe(h);
  });

  it('sheet/place/cover hashes exist; renders without specHash are never stale', () => {
    const doc = normalizeDoc(makeSampleDoc());
    expect(isTargetStale(doc, { kind: 'sheet', id: 'ch_maya' })).toBe(false); // existing sheet carries no specHash
    const stamped = applyOps(doc, [{ op: 'render', target: { kind: 'sheet', id: 'ch_maya' }, patch: { specHash: sheetSpecHash(doc, doc.cast[0]) } }]);
    expect(isTargetStale(stamped, { kind: 'sheet', id: 'ch_maya' })).toBe(false);
    const changed = applyOps(stamped, [{ op: 'character', id: 'ch_maya', patch: { look: { summary: 'Now in a red kurta' } } }]);
    expect(isTargetStale(changed, { kind: 'sheet', id: 'ch_maya' })).toBe(true);
    const ownerDoc = normalizeDoc(ownerLiveDoc());
    const ch = coverSpecHash(ownerDoc);
    expect(coverSpecHash(applyOps(ownerDoc, [{ op: 'cover', patch: { lettering: 'overlay', title: 'X' } }]))).not.toBe(ch);
    // overlay covers do not hash their (software) title
    const overlay = applyOps(ownerDoc, [{ op: 'cover', patch: { lettering: 'overlay' } }]);
    expect(coverSpecHash(applyOps(overlay, [{ op: 'cover', patch: { title: 'New title' } }]))).toBe(coverSpecHash(overlay));
  });
});

describe('back-compat F1: key-order independent spec hashes (plan §5.1)', () => {
  it('stableStringify sorts keys at every depth, keeps array order and serialises like JSON.stringify otherwise', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]));
    // undefined object values are dropped and undefined array items become null, exactly as JSON.stringify does.
    expect(stableStringify({ a: undefined, b: [undefined, null, 'é'] })).toBe(JSON.stringify({ b: [undefined, null, 'é'] }));
    expect(stableStringify(['x', 1, true, null])).toBe(JSON.stringify(['x', 1, true, null]));
  });

  it('every spec hash and the writer-input hash survive a jsonb reorder; the pre-F1 serialisation does not', () => {
    const doc = normalizeDoc(inArtSample());
    // Writer-ordered looks (summary, age, build, hair, outfit…): jsonb puts the short keys first.
    doc.cast = doc.cast.map((c) => ({ ...c, look: { summary: c.look.summary, age: '30s', build: 'lean', hair: 'black bob', outfit: 'red coat', palette: 'red, black', marks: 'scar' } }));
    doc.brief = { title: doc.brief.title, notes: ['no gore'], logline: 'A heist.', genre: 'caper', tone: 'light', audience: 'teens' };
    const reloaded = jsonbReload(doc);
    for (const p of doc.pages) expect(pageSpecHash(reloaded, reloaded.pages.find((q) => q.id === p.id)!)).toBe(pageSpecHash(doc, p));
    for (const c of doc.cast) expect(sheetSpecHash(reloaded, reloaded.cast.find((x) => x.id === c.id)!)).toBe(sheetSpecHash(doc, c));
    for (const pl of doc.places) expect(placeSpecHash(reloaded, reloaded.places.find((x) => x.id === pl.id)!)).toBe(placeSpecHash(doc, pl));
    expect(coverSpecHash(reloaded)).toBe(coverSpecHash(doc));
    expect(planInputHashOf(reloaded)).toBe(planInputHashOf(doc));
    // The bug F1 fixes: the old serialisation followed the key order.
    const page = doc.pages.find((p) => p.panels.some((x) => x.castIds.length))!;
    expect(legacySpecHashFor(reloaded, { kind: 'page', id: page.id })).not.toBe(legacySpecHashFor(doc, { kind: 'page', id: page.id }));
    expect(legacyPlanInputHashOf(reloaded)).not.toBe(legacyPlanInputHashOf(doc));
  });

  it('a real edit still changes the canonical hash (action, look, in_art line)', () => {
    const doc = normalizeDoc(inArtSample());
    const page = doc.pages[0];
    const h = pageSpecHash(doc, page);
    const acted = applyOps(doc, [{ op: 'panel', pageId: page.id, id: page.panels[0].id, patch: { action: `${page.panels[0].action} (edited)` } }]);
    expect(pageSpecHash(acted, acted.pages[0])).not.toBe(h);
    const castId = page.panels.flatMap((p) => p.castIds)[0];
    const looked = applyOps(doc, [{ op: 'character', id: castId, patch: { look: { summary: 'now with a hat' } } }]);
    expect(pageSpecHash(looked, looked.pages[0])).not.toBe(h);
    const line = page.panels.flatMap((p) => p.lines.map((l) => ({ panelId: p.id, id: l.id })))[0];
    const lettered = applyOps(doc, [{ op: 'line', pageId: page.id, panelId: line.panelId, id: line.id, patch: { text: 'Different words' } }]);
    expect(pageSpecHash(lettered, lettered.pages[0])).not.toBe(h);
  });

  it('legacySpecHashFor is the pre-F1 serialisation for every target kind (style options have none)', () => {
    const doc = normalizeDoc(ownerLiveDoc());
    expect(legacySpecHashFor(doc, { kind: 'page', id: 'pg_1' })).toBe(legacyPageSpecHash(doc, doc.pages[0]));
    expect(legacySpecHashFor(doc, { kind: 'sheet', id: 'c_baby' })).toMatch(/^[0-9a-f]{8}$/);
    expect(legacySpecHashFor(doc, { kind: 'cover' })).toMatch(/^[0-9a-f]{8}$/);
    expect(legacySpecHashFor(doc, { kind: 'page', id: 'nope' })).toBeUndefined();
    expect(legacySpecHashFor(doc, { kind: 'style_option', id: 'x' })).toBeUndefined();
    // Looks with only `summary` have no order to lose: canonical === legacy for this sheet.
    expect(sheetSpecHash(doc, doc.cast[0])).toBe(legacySpecHashFor(doc, { kind: 'sheet', id: 'c_baby' }));
  });
});

describe('Ship 1 contract additions (plan §5.1)', () => {
  it('QcReport carries the optional panel checks; old reports stay valid', () => {
    const old: QcReport = { score: 0.9, issues: [], checkedAt: 1 };
    const checked: QcReport = {
      ...old,
      beats: [1, 3, 2],
      crosses: [],
      drawnBoxes: [{ x: 0, y: 0, w: 1, h: 0.5 }],
      missingSpeakers: [{ panel: 2, castId: 'c1' }],
      boxesFrom: 'vision'
    };
    expect(normalizeDoc(JSON.parse(JSON.stringify({ ...baseDoc(), pages: [{ ...page('pg1', 1), render: { status: 'ready', history: [], qc: checked } }] }))).pages[0].render.qc).toEqual(checked);
    // QC data is never hashed.
    const doc = baseDoc();
    const withQc = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg1' }, patch: { qc: checked } }]);
    expect(pageSpecHash(withQc, withQc.pages[0])).toBe(pageSpecHash(doc, doc.pages[0]));
  });

  it('render_pages.drawOverfull is a typed, optional spend field', () => {
    const action: StudioAction = { type: 'render_pages', drawOverfull: ['pg1'] };
    expect(isSpendAction(action)).toBe(true);
  });

  it('layoutFixOps puts a page on a blueprint with sizes that agree with it (client-patchable ops, one implementation)', () => {
    const doc = baseDoc();
    const pg: Page = {
      ...page('pg1', 1),
      layout: 'Row 1: one wide panel. Row 2: two equal panels.',
      panels: [1, 2, 3].map((k) => ({ id: `pn${k}`, n: k, size: k === 1 ? ('wide' as const) : ('medium' as const), shot: 'medium' as const, action: `a${k}`, castIds: [], lines: [] }))
    };
    const ops = layoutFixOps(doc, pg, '  Row 1: two equal panels.   Row 2: one large panel. ');
    // The wide panel moves into a shared row, so it becomes medium; the single bottom row's medium panel becomes wide.
    expect(ops).toEqual([
      { op: 'page', id: 'pg1', patch: { layout: 'Row 1: two equal panels. Row 2: one large panel.' } },
      { op: 'panel', pageId: 'pg1', id: 'pn1', patch: { size: 'medium' } },
      { op: 'panel', pageId: 'pg1', id: 'pn3', patch: { size: 'wide' } }
    ]);
    expect(ops.every((o) => CLIENT_PATCHABLE_OPS.has(o.op))).toBe(true);
    // Unparsed, another panel count, or a row grid on a webtoon: nothing to apply.
    expect(layoutFixOps(doc, pg, 'make it nice')).toEqual([]);
    expect(layoutFixOps(doc, pg, 'Row 1: two equal panels.')).toEqual([]);
    expect(layoutFixOps({ format: { ...doc.format, kind: 'webtoon' } }, pg, 'Row 1: two equal panels. Row 2: one large panel.')).toEqual([]);
  });

  it('notice cards keep well-formed fix chips and drop malformed ones on load', () => {
    const fix = { label: 'Redraw page 2', free: false, action: { type: 'render_pages', pageIds: ['pg2'], force: true, quotedUsd: 0.07 } as StudioAction };
    const free = { label: 'Make it a caption', free: true, action: { type: 'patch', ops: [] } as StudioAction };
    const card: Card = { type: 'notice', id: 'n1', tone: 'warn', text: 'Check panels on page 2.', fixes: [free, fix] };
    expect(normalizeNoticeCard(card as Extract<Card, { type: 'notice' }>)).toBe(card);
    const bad = { ...card, fixes: [free, { label: '', free: true, action: { type: 'patch' } }, { label: 'x', free: 'yes', action: fix.action }, { label: 'y', free: true, action: { type: 'rm_rf' } }] } as never;
    expect((normalizeNoticeCard(bad) as Extract<Card, { type: 'notice' }>).fixes).toEqual([free]);
    const none = normalizeNoticeCard({ ...card, fixes: 'nope' } as never);
    expect('fixes' in none).toBe(false);
    const plain: Card = { type: 'notice', id: 'n2', tone: 'info', text: 'Saved.' };
    expect(normalizeNoticeCard(plain as Extract<Card, { type: 'notice' }>)).toBe(plain);
    // Through a stored message: the bad chips are gone after a load.
    const doc = normalizeDoc({ ...baseDoc(), conversation: [{ id: 'm1', role: 'assistant', text: 'x', at: 1, cards: [bad] }] } as never);
    expect((doc.conversation[0].cards?.[0] as Extract<Card, { type: 'notice' }>).fixes).toEqual([free]);
  });
});

describe('v5 §16.2 normalizeDoc', () => {
  it('is idempotent on old, sample and rich v5 docs', () => {
    for (const raw of [ownerLiveDoc(), makeSampleDoc(), richDoc()]) {
      const once = normalizeDoc(JSON.parse(JSON.stringify(raw)));
      expect(normalizeDoc(JSON.parse(JSON.stringify(once)))).toEqual(once);
      expect(normalizeDoc(once)).toEqual(once);
    }
  });

  it('old docs get the exact old-doc defaults', () => {
    const doc = normalizeDoc(ownerLiveDoc());
    expect(doc.letterStyle).toEqual({ presetId: 'classic' });
    expect(doc.cover.lettering).toBeUndefined();
    expect(doc.book).toEqual(DEFAULT_BOOK);
    expect(doc.reader).toEqual(DEFAULT_READER);
    expect(doc.archive).toEqual([]);
    expect(doc.trash).toEqual([]);
    expect(doc.refInbox).toEqual([]);
    expect(doc.i18n).toEqual({ editions: {}, glossary: [] });
    expect(doc.settings.reviewFirstRender).toBe(true);
    expect('safety' in doc).toBe(false);
    expect('publication' in doc).toBe(false);
    expect('planInputHash' in doc).toBe(false);
  });

  it('new docs: director may auto-pick lettering', () => {
    expect(normalizeDoc(createEmptyDoc('n', 'New', 1)).letterStyle).toEqual({ presetId: 'classic', auto: true });
  });

  it('preserves unknown keys; drops legacy i18n keys, malformed nextSteps, refs and publication; renumbers pages', () => {
    const raw = {
      ...makeSampleDoc(),
      futureKey: { a: 1 },
      i18n: {
        published: ['hi'],
        allowFallback: true,
        editions: {
          hi: { lang: 'hi', status: 'draft', updatedAt: 5, inArtPolicy: 'x', lines: { pg_1_l1: { text: 'नमस्ते', status: 'machine', sourceHash: 'h', at: 1 }, bad: { text: 3 } } },
          en: { lang: 'en', lines: {} }, // the source language — dropped
          xx: { lang: 'xx', lines: {} } // not a registry tag — dropped
        },
        glossary: [{ id: 'g1', term: 'Maya' }, { id: 'g2' }]
      },
      publication: { visibility: 'public', status: 'live', publishedRev: 'nope' },
      conversation: [
        {
          id: 'm1', role: 'assistant', text: 'hi', at: 1,
          nextSteps: [{ label: 'ok', say: 'go' }, { label: '' }, { label: 'two', say: 'a', client: { type: 'undo' } }],
          attachments: [{ path: 'a.png', source: 'upload', at: 1, label: 'nonsense' }, { path: 'a.png', source: 'upload', at: 1 }, { nope: true }]
        }
      ],
      pages: makeSampleDoc().pages.map((p) => ({ ...p, n: 3 }))
    } as unknown as ComicDoc;
    const doc = normalizeDoc(raw);
    expect((doc as unknown as { futureKey: unknown }).futureKey).toEqual({ a: 1 });
    expect(Object.keys(doc.i18n!.editions)).toEqual(['hi']);
    expect(doc.i18n!.editions.hi).toEqual({
      lang: 'hi', lines: { pg_1_l1: { text: 'नमस्ते', status: 'machine', sourceHash: 'h', at: 1 } }, balloons: {}, register: 'everyday'
    });
    expect(doc.i18n!.glossary).toEqual([{ id: 'g1', term: 'Maya', kind: 'term', policy: 'transliterate', forms: {} }]);
    expect('published' in doc.i18n!).toBe(false);
    expect(doc.publication).toBeUndefined();
    expect(doc.conversation[0].nextSteps).toEqual([{ label: 'ok', say: 'go' }]);
    expect(doc.conversation[0].attachments).toEqual([{ path: 'a.png', source: 'upload', at: 1 }]);
    expect(doc.pages.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(doc.pages.map((p) => p.id)).toEqual(['pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5', 'pg_6']);
  });

  it('keeps a valid publication mirror and drops an invalid rating', () => {
    const pub = { visibility: 'unlisted' as const, status: 'live' as const, slug: 'A1b2C3d4E5f6G7h8J', publishedRev: 3, publishedAt: 9, languages: ['en'] };
    const doc = normalizeDoc({ ...makeSampleDoc(), publication: pub, settings: { ...DEFAULT_SETTINGS_FOR_TEST, rating: 'R' as never } });
    expect(doc.publication).toEqual(pub);
    expect(doc.settings.rating).toBeUndefined();
  });
});

const DEFAULT_SETTINGS_FOR_TEST = { quality: 'standard' as const, confirm: 'big' as const, bigSpendUsd: 0.5 };

/** A v5 doc that exercises every new collection. */
function richDoc(): ComicDoc {
  let doc = normalizeDoc(makeSampleDoc());
  doc = applyOps(doc, [
    { op: 'edition', lang: 'hi', patch: { register: 'everyday' } },
    { op: 'translation', lang: 'hi', lineId: 'pg_1_l2', patch: { text: 'बस एक और…', status: 'reviewed', sourceHash: 'x', at: 5 } },
    { op: 'edition_balloon', lang: 'hi', lineId: 'pg_1_l2', patch: { x: 0.1, fontScale: 0.9 } },
    { op: 'glossary_term', id: 'g_maya', patch: { term: 'Maya', kind: 'character', refId: 'ch_maya', forms: { hi: 'माया' } } },
    { op: 'ref_add', owner: { kind: 'character', id: 'ch_maya' }, ref: { path: 'u/proj/refs/maya2.jpg', source: 'upload', at: 2, label: 'side' } },
    { op: 'ref_add', owner: { kind: 'inbox' }, ref: { path: 'u/proj/refs/inbox1.jpg', source: 'upload', at: 3 } },
    { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { shape: 'jagged', textColor: '#aa0000' } },
    { op: 'letter_style', patch: { presetId: 'storybook' } },
    { op: 'book', patch: { titlePage: true, blurb: 'A thief with a heart.' } },
    { op: 'reader', patch: { turn: 'slide', credits: 'Made with love' } },
    { op: 'page', id: 'pg_2', patch: { chapterTitle: 'The Chase' } }
  ], 7);
  return doc;
}

describe('v5 §16.3 wire round trip (R4)', () => {
  it('every new op survives encodeStudioEvent → JSON.parse → applyOp', () => {
    const doc = richDoc();
    const ready = doc.pages[0].render;
    const ops: DocOp[] = [
      { op: 'letter_style', patch: { presetId: 'manga', base: { fill: '#fafafa' }, kinds: { shout: { shape: 'jagged' } }, safeMargin: 0.05 } },
      { op: 'letter_style', patch: null },
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l2'], patch: { italic: true }, mode: 'merge' },
      { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p1', id: 'new_l', patch: { kind: 'caption', text: 'Later' }, index: 0 },
      { op: 'pages_reorder', order: ['pg_3', 'pg_1'] },
      { op: 'page_insert', id: 'pg_new', after: 2, patch: { summary: 'Inserted' } },
      { op: 'page_duplicate', id: 'pg_1', newId: 'pg_dup' },
      { op: 'page_delete', id: 'pg_2', deletedAt: 100 },
      { op: 'book', patch: { endPage: true } },
      { op: 'reader', patch: { ambient: false } },
      { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: ready.history[0].path, at: 200 },
      { op: 'version_star', path: ready.history[0].path, starred: true },
      { op: 'asset_meta', path: ready.asset!.path, patch: { safety: { assessed: 'G', at: 1 }, variants: [{ path: 'v480.webp', w: 480, h: 720 }] } },
      { op: 'ref_patch', owner: { kind: 'character', id: 'ch_maya' }, path: 'u/proj/refs/maya2.jpg', patch: { note: 'side view' } },
      { op: 'ref_move', owner: { kind: 'character', id: 'ch_maya' }, path: 'u/proj/refs/maya2.jpg', to: 0 },
      { op: 'ref_transfer', from: { kind: 'inbox' }, to: { kind: 'style' }, path: 'u/proj/refs/inbox1.jpg' },
      { op: 'ref_remove', owner: { kind: 'character', id: 'ch_maya' }, path: 'u/proj/refs/maya.jpg' },
      { op: 'edition', lang: 'te', patch: { register: 'formal' } },
      { op: 'translations', lang: 'hi', lines: { pg_1_l4: { text: 'माया, तुम्हें समझाना होगा।', status: 'machine', sourceHash: 's', at: 9 } } },
      { op: 'edition_text', lang: 'hi', field: 'cover.title', value: { text: 'केसर चोर', status: 'edited', sourceHash: 't', at: 3 } },
      { op: 'edition_balloon', lang: 'hi', lineId: 'pg_1_l2', patch: { y: 0.3 } },
      { op: 'glossary_term', id: 'g_maya', patch: { forms: { te: 'మాయ' } } },
      { op: 'safety', patch: { ipNoted: ['LEGO'], text: { hash: 'h', categories: [], at: 1 } } },
      { op: 'publication', value: { visibility: 'unlisted', status: 'live', publishedRev: 4, publishedAt: 5, languages: ['en'] } },
      { op: 'spend', entry: { id: 'sv', at: 1, kind: 'page', label: 'Reused page 1', usd: 0, byok: false, estimated: false, savedUsd: 0.07 } },
      { op: 'page_restore', id: 'pg_2', n: 1 }
    ];
    let direct = doc;
    let wired = doc;
    for (const op of ops) {
      direct = applyOp(direct, op);
      const parsed = JSON.parse(encodeStudioEvent({ type: 'ops', rev: 1, ops: [op], origin: 'user', label: 'x' })) as { ops: DocOp[] };
      wired = applyOp(wired, parsed.ops[0]);
      expect(wired).toEqual(direct);
    }
  });
});

const page1 = (doc: ComicDoc) => doc.pages.find((p) => p.id === 'pg_1')!;
const asset2 = (path: string, extra: Partial<AssetRef> = {}): AssetRef => ({ path, source: 'generated', at: 10, ...extra });

describe('v5 §16.4 op invariants', () => {
  it('every new op leaves a frozen input untouched (immutability)', () => {
    const doc = deepFreeze(richDoc());
    const snapshot = JSON.stringify(doc);
    const ops: DocOp[] = [
      { op: 'letter_style', patch: { presetId: 'noir' } },
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l1'], patch: { fill: '#000000' } },
      { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p2', id: 'pg_1_l2', patch: null },
      { op: 'pages_reorder', order: ['pg_6'] },
      { op: 'page_insert', id: 'x', after: 0 },
      { op: 'page_duplicate', id: 'pg_1', newId: 'dup' },
      { op: 'page_delete', id: 'pg_1', deletedAt: 1 },
      { op: 'book', patch: { backCover: 'auto' } },
      { op: 'reader', patch: { turn: 'fade' } },
      { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/proj/pages/p1.png.old', at: 1 },
      { op: 'version_star', path: 'u/proj/pages/p1.png.old', starred: true },
      { op: 'asset_meta', path: 'u/proj/pages/p1.png', patch: { safety: null } },
      { op: 'ref_add', owner: { kind: 'style' }, ref: { path: 'z.png', source: 'upload', at: 1 } },
      { op: 'ref_transfer', from: { kind: 'inbox' }, to: { kind: 'place', id: 'pl_market' }, path: 'u/proj/refs/inbox1.jpg' },
      { op: 'edition', lang: 'hi', patch: null },
      { op: 'glossary_term', id: 'g_maya', patch: null },
      { op: 'safety', patch: { ipNoted: [] } },
      { op: 'publication', value: null },
      { op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: asset2('fresh.png') } }
    ];
    for (const op of ops) expect(() => applyOp(doc, op)).not.toThrow();
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('tolerance: missing entities, malformed and over-limit ops are no-ops (same object)', () => {
    const doc = richDoc();
    const noops: DocOp[] = [
      { op: 'line_style', pageId: 'nope', lineIds: ['x'], patch: { italic: true } },
      { op: 'line', pageId: 'nope', panelId: 'x', id: 'y', patch: { text: 'hi' } },
      { op: 'page_duplicate', id: 'nope', newId: 'z' },
      { op: 'page_duplicate', id: 'pg_1', newId: 'pg_2' },
      { op: 'page_duplicate', id: 'pg_3', newId: 'busy_copy' }, // pg_3 is queued
      { op: 'page_delete', id: 'pg_4', deletedAt: 1 }, // rendering
      { op: 'page_delete', id: 'nope', deletedAt: 1 },
      { op: 'page_restore', id: 'nope' },
      { op: 'page_insert', id: 'pg_1', after: 0 },
      { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'not/in/doc.png', at: 1 },
      { op: 'render_use', target: { kind: 'page', id: 'pg_4' }, path: 'u/proj/pages/p1.png', at: 1 },
      { op: 'render_use', target: { kind: 'sheet', id: 'nope' }, path: 'u/proj/pages/p1.png', at: 1 },
      { op: 'version_star', path: 'nope.png', starred: true },
      { op: 'ref_add', owner: { kind: 'character', id: 'nope' }, ref: { path: 'a', source: 'upload', at: 1 } },
      { op: 'ref_add', owner: { kind: 'character', id: 'ch_maya' }, ref: { path: 'u/proj/refs/maya.jpg', source: 'upload', at: 1 } },
      { op: 'ref_remove', owner: { kind: 'style' }, path: 'nope' },
      { op: 'ref_transfer', from: { kind: 'inbox' }, to: { kind: 'character', id: 'nope' }, path: 'u/proj/refs/inbox1.jpg' },
      { op: 'edition', lang: 'en', patch: {} }, // source language
      { op: 'edition', lang: 'klingon', patch: {} },
      { op: 'translation', lang: 'fr', lineId: 'pg_1_l1', patch: { text: 'x', status: 'edited', sourceHash: 'h', at: 1 } },
      { op: 'translation', lang: 'hi', lineId: 'nope', patch: { text: 'x', status: 'edited', sourceHash: 'h', at: 1 } },
      { op: 'translation', lang: 'hi', lineId: 'pg_1_l1', patch: { text: 'x' } }, // create needs status/sourceHash/at
      { op: 'edition_balloon', lang: 'hi', lineId: 'nope', patch: { x: 1 } },
      { op: 'glossary_term', id: 'g_new', patch: { forms: {} } }, // create needs term
      { op: 'letter_style', patch: { presetId: 'comic-sans' as never } },
      { op: 'publication', value: { visibility: 'everyone' } as never },
      { op: 'asset_meta', path: 'nope.png', patch: { safety: null } }
    ];
    for (const op of noops) expect(applyOp(doc, op), op.op).toBe(doc);
    // page cap
    let full = normalizeDoc(createEmptyDoc('cap', 'Cap', 1));
    full = applyOps(full, Array.from({ length: DOC_LIMITS.pages }, (_, i): DocOp => ({ op: 'page_insert', id: `p${i}`, after: i })));
    expect(full.pages).toHaveLength(DOC_LIMITS.pages);
    expect(full.format.pageCount).toBe(DOC_LIMITS.pages);
    expect(applyOp(full, { op: 'page_insert', id: 'one_more', after: 0 })).toBe(full);
    // edition cap
    expect(DOC_LIMITS.editions).toBe(19);
  });

  it('pages_reorder appends unmentioned pages (a concurrent server page is never dropped) and syncs the count', () => {
    const doc = richDoc();
    const next = applyOp(doc, { op: 'pages_reorder', order: ['pg_5', 'ghost', 'pg_5', 'pg_2'] });
    expect(next.pages.map((p) => p.id)).toEqual(['pg_5', 'pg_2', 'pg_1', 'pg_3', 'pg_4', 'pg_6']);
    expect(next.pages.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(next.pages[0].render).toBe(doc.pages[4].render); // renders untouched → nothing goes stale
  });

  it('page_duplicate: deterministic SAFE_ID child ids for a 52-char newId; ready and not stale; translations remapped', () => {
    const doc = richDoc();
    const newId = 'p'.repeat(52);
    const next = applyOp(doc, { op: 'page_duplicate', id: 'pg_1', newId });
    const copy = next.pages.find((p) => p.id === newId)!;
    expect(copy.n).toBe(2);
    const ids = [copy.id, ...copy.panels.map((p) => p.id), ...copy.panels.flatMap((p) => p.lines.map((l) => l.id))];
    for (const id of ids) expect(id).toMatch(SAFE_ID_RE);
    expect(copy.panels[2].lines[1].id).toBe(`${newId}_l2_1`);
    expect(copy.render.status).toBe('ready');
    expect(copy.render.history).toEqual([]);
    expect(copy.render.asset).toEqual(page1(doc).render.asset);
    expect(isPageStale(next, copy)).toBe(false);
    expect(copy.balloons.every((b) => b.lineId.startsWith(newId))).toBe(true);
    expect(copy.panels[2].lines[0].style).toEqual({ shape: 'jagged', textColor: '#aa0000' });
    expect(next.i18n!.editions.hi.lines[`${newId}_l1_0`]?.text).toBe('बस एक और…');
    expect(next.i18n!.editions.hi.balloons[`${newId}_l1_0`]).toEqual({ x: 0.1, fontScale: 0.9 });
    expect(next.format.pageCount).toBe(7);
  });

  it('page_delete trashes, restore puts it back; trash overflow archives the oldest page renders', () => {
    const doc = richDoc();
    const deleted = applyOp(doc, { op: 'page_delete', id: 'pg_1', deletedAt: 50 });
    expect(deleted.pages.map((p) => p.n)).toEqual([1, 2, 3, 4, 5]);
    expect(trashOf(deleted)[0]).toMatchObject({ fromN: 1, deletedAt: 50 });
    expect(collectAssetPaths(deleted)).toContain('u/proj/pages/p1.png'); // still GC-protected
    const restored = applyOp(deleted, { op: 'page_restore', id: 'pg_1' });
    expect(restored.pages.map((p) => p.id)).toEqual(doc.pages.map((p) => p.id));
    expect(trashOf(restored)).toEqual([]);
    // purge only when nothing would become unreferenced
    expect(applyOp(doc, { op: 'page_delete', id: 'pg_1', deletedAt: 1, purge: true }).trash).toHaveLength(1);
    const dup = applyOp(doc, { op: 'page_duplicate', id: 'pg_1', newId: 'cp' });
    expect(trashOf(applyOp(dup, { op: 'page_delete', id: 'cp', deletedAt: 1, purge: true }))).toEqual([]);
    // overflow
    let many = normalizeDoc(createEmptyDoc('t', 'T', 1));
    many = applyOps(many, Array.from({ length: MAX_TRASH + 1 }, (_, i): DocOp => ({ op: 'page_insert', id: `p${i}`, after: i })));
    many = applyOps(many, [{ op: 'render', target: { kind: 'page', id: 'p0' }, patch: { status: 'ready', asset: asset2('p0.png') } }]);
    many = applyOps(many, Array.from({ length: MAX_TRASH + 1 }, (_, i): DocOp => ({ op: 'page_delete', id: `p${i}`, deletedAt: 100 + i })));
    expect(trashOf(many)).toHaveLength(MAX_TRASH);
    expect(archiveOf(many)[0]).toMatchObject({ path: 'p0.png', targetKey: 'page:p0', label: 'Deleted page 1', archivedAt: 100 + MAX_TRASH });
  });

  it('render_use case A (history): swaps, lifts meta, restores balloons with pinned-outgoing priority', () => {
    let doc = richDoc();
    const old = asset2('old.png');
    doc = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { history: [] } }]);
    // v1 = old.png (with its own meta and layout), then v2 = current.
    doc = applyOps(doc, [
      { op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: old, specHash: 'h_old', qc: { score: 0.5, issues: [], checkedAt: 1 }, costUsd: 0.05 } },
      { op: 'balloons', pageId: 'pg_1', balloons: [{ lineId: 'pg_1_l1', x: 0.5, y: 0.5, w: 0.2 }, { lineId: 'pg_1_l3', x: 0.1, y: 0.1, w: 0.2 }] },
      { op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: asset2('new.png'), specHash: 'h_new', aspect: '2:3' } },
      { op: 'balloons', pageId: 'pg_1', balloons: [{ lineId: 'pg_1_l1', x: 0.9, y: 0.9, w: 0.2 }, { lineId: 'pg_1_l3', x: 0.7, y: 0.7, w: 0.2, pinned: true }] }
    ]);
    const r0 = page1(doc).render;
    expect(r0.history[0]).toMatchObject({ path: 'old.png', specHash: 'h_old', costUsd: 0.05 });
    expect(r0.history[0].balloons).toEqual([{ lineId: 'pg_1_l1', x: 0.5, y: 0.5, w: 0.2 }, { lineId: 'pg_1_l3', x: 0.1, y: 0.1, w: 0.2 }]);
    const used = applyOp(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'old.png', at: 999 });
    const r = page1(used).render;
    expect(r.asset?.path).toBe('old.png');
    expect(r).toMatchObject({ status: 'ready', specHash: 'h_old', costUsd: 0.05, updatedAt: 999 });
    expect(r.aspect).toBeUndefined(); // keys the chosen version lacks are cleared
    expect(r.history[0]).toMatchObject({ path: 'new.png', specHash: 'h_new', aspect: '2:3' });
    expect(page1(used).balloons).toEqual([
      { lineId: 'pg_1_l1', x: 0.5, y: 0.5, w: 0.2 },
      { lineId: 'pg_1_l3', x: 0.7, y: 0.7, w: 0.2, pinned: true } // the user's pin wins
    ]);
  });

  it('render_use case B (archive) and case C (adopt); blocked assets are refused', () => {
    let doc = richDoc();
    const archived: ArchivedVersion = { ...asset2('arch.png'), targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 3, specHash: 'h_arch' };
    doc = { ...doc, archive: [archived] };
    const b = applyOp(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'arch.png', at: 5 });
    expect(page1(b).render).toMatchObject({ asset: { path: 'arch.png' }, specHash: 'h_arch' });
    expect(archiveOf(b)).toEqual([]);
    // archive entries of another target are not case B (but still adoptable as case C)
    const c = applyOp(doc, { op: 'render_use', target: { kind: 'cover' }, path: 'u/proj/sheets/maya-v2.png', at: 6 });
    expect(c.cover.render.asset?.path).toBe('u/proj/sheets/maya-v2.png');
    expect(c.cover.render.origin).toBe('adopted');
    expect(c.cover.render.specHash).toBeUndefined();
    expect(c.cover.render.qc).toBeUndefined();
    // blocked
    const blocked = applyOp(doc, { op: 'asset_meta', path: 'u/proj/pages/p1.png.old', patch: { safety: { assessed: 'X', at: 1 } } });
    expect(applyOp(blocked, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/proj/pages/p1.png.old', at: 1 })).toBe(blocked);
    const quarantined = applyOp(doc, { op: 'asset_meta', path: 'u/proj/pages/p1.png.old', patch: { safety: { quarantined: true, at: 1 } } });
    expect(applyOp(quarantined, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/proj/pages/p1.png.old', at: 1 })).toBe(quarantined);
  });

  it('asset replacement clears the outgoing meta; a meta-only patch merges as before', () => {
    let doc = richDoc();
    doc = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { specHash: 'h1', qc: { score: 1, issues: [], checkedAt: 1 }, jobHash: 'j1' } }]);
    const replaced = applyOp(doc, { op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: asset2('n.png'), costUsd: 0.06 } });
    const r = page1(replaced).render;
    expect(r.specHash).toBeUndefined();
    expect(r.qc).toBeUndefined();
    expect(r.jobHash).toBeUndefined();
    expect(r.costUsd).toBe(0.06);
    expect(r.model).toBe('nano-banana-2.1'); // non-meta keys of the previous state are kept
    expect(r.history[0]).toMatchObject({ path: 'u/proj/pages/p1.png', specHash: 'h1', jobHash: 'j1' });
    const merged = applyOp(replaced, { op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { qc: { score: 0.9, issues: [], checkedAt: 2 } } });
    expect(page1(merged).render).toMatchObject({ costUsd: 0.06, qc: { score: 0.9 } });
    // character.sheet patches share the code path
    const sheet = applyOp(doc, { op: 'character', id: 'ch_maya', patch: { sheet: { status: 'ready', asset: asset2('sheet3.png') } as never } });
    expect(sheet.cast[0].sheet.history.map((v) => v.path)).toEqual(['u/proj/sheets/maya-v2.png', 'u/proj/sheets/maya-v1.png']);
  });

  it('history overflow moves to the archive (lean); starred and referenced entries are never evicted; the cap is soft', () => {
    let doc = normalizeDoc(makeSampleDoc());
    const target = { kind: 'page' as const, id: 'pg_1' };
    for (let i = 0; i < MAX_RENDER_HISTORY + 3; i += 1) {
      doc = applyOp(doc, { op: 'render', target, patch: { status: 'ready', asset: asset2(`r${i}.png`), specHash: `h${i}`, qc: { score: 1, issues: [], checkedAt: i }, updatedAt: 1000 + i } });
    }
    expect(page1(doc).render.history).toHaveLength(MAX_RENDER_HISTORY);
    const archive = archiveOf(doc);
    expect(archive.length).toBeGreaterThan(0);
    expect(archive.every((a) => a.targetKey === 'page:pg_1' && a.label === 'Page 1')).toBe(true);
    expect('qc' in archive[0]).toBe(false);
    expect('balloons' in archive[0]).toBe(false);
    expect(collectAssetPaths(doc)).toEqual(expect.arrayContaining(archive.map((a) => a.path)));
    // eviction
    const filler: ArchivedVersion[] = Array.from({ length: MAX_ARCHIVE }, (_, i) => ({ ...asset2(`f${i}.png`), targetKey: 'page:pg_9', label: 'x', archivedAt: 10 + i }));
    filler[MAX_ARCHIVE - 1] = { ...filler[MAX_ARCHIVE - 1], starred: true, archivedAt: 0 }; // oldest but starred
    filler[MAX_ARCHIVE - 2] = { ...filler[MAX_ARCHIVE - 2], path: 'u/proj/style/board.png', archivedAt: 1 }; // referenced elsewhere
    let full: ComicDoc = { ...normalizeDoc(makeSampleDoc()), archive: filler };
    for (let i = 0; i < MAX_RENDER_HISTORY + 2; i += 1) full = applyOp(full, { op: 'render', target, patch: { asset: asset2(`z${i}.png`), updatedAt: 5000 + i } });
    const after = archiveOf(full);
    expect(after.length).toBe(MAX_ARCHIVE);
    expect(after.some((a) => a.starred)).toBe(true);
    expect(after.some((a) => a.path === 'u/proj/style/board.png')).toBe(true);
    expect(after.some((a) => a.path === 'f0.png')).toBe(false); // oldest evictable went first
    // soft cap: nothing evictable → stays over the cap
    const allStarred = filler.map((a) => ({ ...a, starred: true }));
    let soft: ComicDoc = { ...normalizeDoc(makeSampleDoc()), archive: allStarred };
    // star every version as it enters history, so the overflowing entries are not evictable either
    for (const p of page1(soft).render.history.map((v) => v.path).concat(page1(soft).render.asset!.path)) soft = applyOp(soft, { op: 'version_star', path: p, starred: true });
    for (let i = 0; i < MAX_RENDER_HISTORY + 2; i += 1) {
      soft = applyOp(soft, { op: 'render', target, patch: { asset: asset2(`s${i}.png`), updatedAt: 9000 + i } });
      soft = applyOp(soft, { op: 'version_star', path: `s${i}.png`, starred: true });
    }
    expect(archiveOf(soft).length).toBeGreaterThan(MAX_ARCHIVE);
  });

  it('asset_meta hits every occurrence (current, history, refs, attachments) and is idempotent', () => {
    let doc = richDoc();
    doc = applyOps(doc, [
      { op: 'ref_add', owner: { kind: 'style' }, ref: { path: 'u/proj/pages/p1.png', source: 'generated', at: 1 } },
      { op: 'message', msg: { id: 'mm', role: 'user', text: 'see', at: 1, attachments: [{ path: 'u/proj/pages/p1.png', source: 'upload', at: 1 }] } },
      { op: 'page_duplicate', id: 'pg_1', newId: 'cp' }
    ]);
    const verdict = { assessed: 'PG' as const, categories: ['violence' as const], at: 4 };
    const once = applyOp(doc, { op: 'asset_meta', path: 'u/proj/pages/p1.png', patch: { safety: verdict } });
    expect(page1(once).render.asset?.safety).toEqual(verdict);
    expect(once.pages.find((p) => p.id === 'cp')!.render.asset?.safety).toEqual(verdict);
    expect(once.style.refs[0].safety).toEqual(verdict);
    expect(once.conversation.at(-1)!.attachments![0].safety).toEqual(verdict);
    expect(applyOp(once, { op: 'asset_meta', path: 'u/proj/pages/p1.png', patch: { safety: verdict } })).toEqual(once);
    const cleared = applyOp(once, { op: 'asset_meta', path: 'u/proj/pages/p1.png', patch: { safety: null } });
    expect(page1(cleared).render.asset?.safety).toBeUndefined();
  });

  it('ref ops: cap, dedupe, index 0 = main, transfer never loses', () => {
    let doc = richDoc();
    const owner = { kind: 'character' as const, id: 'ch_maya' };
    doc = applyOp(doc, { op: 'ref_add', owner, ref: { path: 'main.jpg', source: 'upload', at: 1 }, index: 0 });
    expect(doc.cast[0].refs[0].path).toBe('main.jpg');
    // fill to the cap
    for (let i = 0; i < 20; i += 1) doc = applyOp(doc, { op: 'ref_add', owner, ref: { path: `r${i}.jpg`, source: 'upload', at: 1 } });
    expect(doc.cast[0].refs).toHaveLength(DOC_LIMITS.refsPerCharacter);
    // 5 photos in → 5 refs (the old slice(-4) bug)
    let five = normalizeDoc(createEmptyDoc('f', 'F', 1));
    five = applyOps(five, [{ op: 'character', id: 'c', patch: { name: 'Kid' } }]);
    five = applyOps(five, Array.from({ length: 5 }, (_, i): DocOp => ({ op: 'ref_add', owner: { kind: 'character', id: 'c' }, ref: { path: `p${i}.jpg`, source: 'upload', at: 1 } })));
    expect(five.cast[0].refs.map((r) => r.path)).toEqual(['p0.jpg', 'p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']);
    // transfer to a full owner is refused; the ref stays where it was
    const t = applyOp(doc, { op: 'ref_transfer', from: { kind: 'inbox' }, to: owner, path: 'u/proj/refs/inbox1.jpg' });
    expect(t).toBe(doc);
    const moved = applyOp(doc, { op: 'ref_transfer', from: { kind: 'inbox' }, to: { kind: 'style' }, path: 'u/proj/refs/inbox1.jpg', index: 0 });
    expect(moved.refInbox).toEqual([]);
    expect(moved.style.refs[0].path).toBe('u/proj/refs/inbox1.jpg');
    // ref_patch re-key (crop) and conflicts
    const rekey = applyOp(doc, { op: 'ref_patch', owner, path: 'main.jpg', patch: { path: 'main_crop.jpg', label: 'face' } });
    expect(rekey.cast[0].refs[0]).toMatchObject({ path: 'main_crop.jpg', label: 'face' });
    expect(applyOp(doc, { op: 'ref_patch', owner, path: 'main.jpg', patch: { path: 'r0.jpg' } })).toBe(doc);
    const moved2 = applyOp(doc, { op: 'ref_move', owner, path: 'r0.jpg', to: 0 });
    expect(moved2.cast[0].refs[0].path).toBe('r0.jpg');
  });

  it('line: index inserts; delete prunes balloons, translations and edition balloons', () => {
    const doc = richDoc();
    const inserted = applyOp(doc, { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'nl', patch: { text: 'First!' }, index: 0 });
    expect(page1(inserted).panels[2].lines.map((l) => l.id)).toEqual(['nl', 'pg_1_l3', 'pg_1_l4', 'pg_1_l5']);
    expect(page1(inserted).panels[2].lines[0]).toEqual({ id: 'nl', kind: 'speech', text: 'First!' });
    const deleted = applyOp(doc, { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p2', id: 'pg_1_l2', patch: null });
    expect(page1(deleted).balloons.some((b) => b.lineId === 'pg_1_l2')).toBe(false);
    expect(deleted.i18n!.editions.hi.lines.pg_1_l2).toBeUndefined();
    expect(deleted.i18n!.editions.hi.balloons.pg_1_l2).toBeUndefined();
    // style in a line patch merges like line_style
    const styled = applyOp(doc, { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: { style: { italic: true } } });
    expect(page1(styled).panels[2].lines[0].style).toEqual({ shape: 'jagged', textColor: '#aa0000', italic: true });
  });

  it('balloon: locked implies pinned', () => {
    const next = applyOp(richDoc(), { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1', patch: { locked: true, z: 4 } });
    expect(page1(next).balloons[0]).toMatchObject({ locked: true, pinned: true, z: 4 });
  });

  it('edition / translation validation and edition_text / glossary upserts', () => {
    let doc = richDoc();
    doc = applyOp(doc, { op: 'edition', lang: 'te', patch: {} });
    expect(doc.i18n!.editions.te).toEqual({ lang: 'te', lines: {}, balloons: {}, register: 'everyday' });
    doc = applyOp(doc, { op: 'edition', lang: 'te', patch: { register: 'code_mixed' } });
    expect(doc.i18n!.editions.te.register).toBe('code_mixed');
    const src = page1(doc).panels[0].lines[0];
    doc = applyOp(doc, { op: 'translation', lang: 'te', lineId: src.id, patch: { text: 'పాత ఢిల్లీ.', status: 'machine', sourceHash: lineSourceHash(src), at: 1, gloss: 'Old Delhi.' } });
    doc = applyOp(doc, { op: 'translation', lang: 'te', lineId: src.id, patch: { gloss: null as never, status: 'reviewed' } });
    expect(doc.i18n!.editions.te.lines[src.id]).toEqual({ text: 'పాత ఢిల్లీ.', status: 'reviewed', sourceHash: lineSourceHash(src), at: 1 });
    doc = applyOp(doc, { op: 'edition_text', lang: 'te', field: 'brief.logline', value: { text: 'L', status: 'edited', sourceHash: 's', at: 1 } });
    expect(doc.i18n!.editions.te.brief?.logline?.text).toBe('L');
    doc = applyOp(doc, { op: 'edition_text', lang: 'te', field: 'brief.logline', value: null });
    expect(doc.i18n!.editions.te.brief).toBeUndefined();
    doc = applyOp(doc, { op: 'edition_balloon', lang: 'te', lineId: src.id, patch: { x: 7, fontScale: 3 } });
    expect(doc.i18n!.editions.te.balloons[src.id]).toEqual({ x: 1, fontScale: 1.3 });
    doc = applyOp(doc, { op: 'glossary_term', id: 'g_maya', patch: { forms: { te: 'మాయ' }, policy: 'keep' } });
    expect(doc.i18n!.glossary[0]).toMatchObject({ forms: { hi: 'माया', te: 'మాయ' }, policy: 'keep' });
    // creation refused past the editions cap
    const langs = ['hi', 'te', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'ur', 'es', 'fr', 'pt', 'de', 'id', 'ja', 'ko', 'zh-Hans', 'ar'];
    let all = normalizeDoc(makeSampleDoc());
    all = applyOps(all, langs.map((lang): DocOp => ({ op: 'edition', lang, patch: {} })));
    expect(Object.keys(all.i18n!.editions)).toHaveLength(19);
  });

  it('letter_style: preset switch clears base/kinds unless keepOverrides; a manual switch stops auto', () => {
    let doc = normalizeDoc(createEmptyDoc('l', 'L', 1));
    expect(doc.letterStyle).toEqual({ presetId: 'classic', auto: true });
    doc = applyOp(doc, { op: 'letter_style', patch: { base: { fill: '#eeeeee' }, kinds: { sfx: { font: 'ultra' } }, speakers: { c1: { shape: 'electronic' } } } });
    expect(doc.letterStyle).toMatchObject({ presetId: 'classic', auto: true, base: { fill: '#eeeeee' } });
    const switched = applyOp(doc, { op: 'letter_style', patch: { presetId: 'manga' } });
    expect(switched.letterStyle).toEqual({ presetId: 'manga', auto: false, speakers: { c1: { shape: 'electronic' } } });
    const kept = applyOp(doc, { op: 'letter_style', patch: { presetId: 'noir', keepOverrides: true } });
    expect(kept.letterStyle).toMatchObject({ presetId: 'noir', auto: false, base: { fill: '#eeeeee' }, kinds: { sfx: { font: 'ultra' } } });
    const cleared = applyOp(doc, { op: 'letter_style', patch: { base: null, kinds: { sfx: null }, safeMargin: 0.5 } });
    expect(cleared.letterStyle).toEqual({ presetId: 'classic', auto: true, speakers: { c1: { shape: 'electronic' } }, safeMargin: 0.1 });
    expect(applyOp(doc, { op: 'letter_style', patch: null }).letterStyle).toEqual({ presetId: 'classic' });
  });

  it('spend.savedUsd accumulates ("saved by software")', () => {
    const doc = applyOps(richDoc(), [
      { op: 'spend', entry: { id: 'a', at: 1, kind: 'page', label: 'Reused', usd: 0, byok: false, estimated: false, savedUsd: 0.0655 } },
      { op: 'spend', entry: { id: 'b', at: 2, kind: 'page', label: 'Fit (free)', usd: 0, byok: false, estimated: false, savedUsd: 0.0655, target: 'page:pg_1' } }
    ]);
    expect(doc.spend.savedUsd).toBeCloseTo(0.131, 4);
    expect(doc.spend.totalUsd).toBeCloseTo(0.42, 4);
  });

  it('safety and publication (server-only) ops', () => {
    let doc = richDoc();
    doc = applyOp(doc, { op: 'safety', patch: { ipNoted: ['LEGO'], publish: { ok: true, rating: 'PG', rev: 3, at: 1, blockers: [] } } });
    expect(doc.safety).toEqual({ ipNoted: ['LEGO'], publish: { ok: true, rating: 'PG', rev: 3, at: 1, blockers: [] } });
    doc = applyOp(doc, { op: 'safety', patch: { publish: null } });
    expect(doc.safety).toEqual({ ipNoted: ['LEGO'] });
    const pub = { visibility: 'public' as const, status: 'live' as const, publishedRev: 1, publishedAt: 2, languages: ['en', 'hi'] };
    doc = applyOp(doc, { op: 'publication', value: pub });
    expect(doc.publication).toEqual(pub);
    expect('publication' in applyOp(doc, { op: 'publication', value: null })).toBe(false);
  });
});

describe('v5 §16.5 sets', () => {
  it('server-only ops are never client-patchable', () => {
    for (const op of ['pages', 'page_panels', 'style_option', 'style_options_clear', 'render', 'asset_meta', 'translations', 'message', 'message_patch', 'spend', 'gate', 'memory', 'safety', 'publication', 'plan_input_hash', 'history_restore'] as const) {
      expect(CLIENT_PATCHABLE_OPS.has(op), op).toBe(false);
      expect(SERVER_ONLY_OPS).toContain(op);
    }
    expect(CLIENT_PATCHABLE_OPS.size).toBe(17 + 22 + (PRO_PAGE_OPS_PATCHABLE ? PRO_PAGE_PATCH_OPS.length : 0)); // + line_move; K2a: + Ship 2 when on
  });

  it('spend and non-spend action types are disjoint and cover every StudioAction type', () => {
    for (const t of SPEND_ACTION_TYPES) expect(NON_SPEND_ACTION_TYPES.has(t)).toBe(false);
    const all: Record<StudioAction['type'], true> = {
      render_style_options: true, render_sheets: true, render_pages: true, edit_page: true, render_cover: true, translate: true, recheck_page: true,
      approve_gate: true, decline_gate: true, pick_style: true, plan_pages: true, approve_plan: true, patch: true, restore_render: true,
      relayout_balloons: true, cancel: true, fit_render: true, show_breakdown: true, use_preset: true, ref_crop: true, publish: true,
      update_publication: true, unpublish: true, regenerate_link: true, decline_publish: true, safety_recheck: true,
      swap_source_language: true, accept_translation_issue: true, library_save: true, library_use: true, import_classic_cast: true,
      change_image_model: true, // W-M M0-CONTRACT (models.md §3.3)
      // Comic History H0 (versions plan §3.3): every history path is free
      history_save: true, history_restore: true, history_undo_ai: true, history_forget_photo: true, history_alternative: true
    };
    for (const t of Object.keys(all)) expect(Number(SPEND_ACTION_TYPES.has(t)) + Number(NON_SPEND_ACTION_TYPES.has(t)), t).toBe(1);
    expect(SPEND_ACTION_TYPES.size + NON_SPEND_ACTION_TYPES.size).toBe(Object.keys(all).length);
    expect(isSpendAction({ type: 'translate', languages: ['hi'] })).toBe(true);
  });
});

describe('v5 §16.7 asset path sets', () => {
  it('collectAssetPaths includes archive, trash, variants, originals and inbox; displayAssetPaths excludes history/archive/trash', () => {
    let doc = richDoc();
    doc = applyOps(doc, [
      { op: 'asset_meta', path: 'u/proj/pages/p1.png', patch: { variants: [{ path: 'u/proj/pages/p1_w480.webp', w: 480, h: 720 }, { path: 'u/proj/pages/p1_w1080.webp', w: 1080, h: 1620 }] } },
      { op: 'page_delete', id: 'pg_5', deletedAt: 1 }
    ]);
    doc = { ...doc, archive: [{ ...asset2('arch.png'), targetKey: 'cover', label: 'Cover', archivedAt: 1 }] };
    doc = { ...doc, refInbox: [{ path: 'inbox.png', source: 'upload', at: 1, original: { path: 'inbox_orig.png' } }] };
    const all = collectAssetPaths(doc);
    for (const p of ['arch.png', 'u/proj/pages/p5.png', 'u/proj/pages/p5.png.old', 'u/proj/pages/p1_w480.webp', 'u/proj/pages/p1_w1080.webp', 'inbox.png', 'inbox_orig.png', 'u/proj/refs/maya2.jpg']) {
      expect(all, p).toContain(p);
    }
    const display = displayAssetPaths(doc);
    expect(display).toEqual(expect.arrayContaining(['u/proj/pages/p1.png', 'u/proj/pages/p1_w480.webp', 'inbox.png', 'inbox_orig.png', 'u/proj/refs/maya.jpg', 'u/proj/sheets/maya-v2.png']));
    for (const p of ['arch.png', 'u/proj/pages/p5.png', 'u/proj/pages/p1.png.old', 'u/proj/sheets/maya-v1.png']) expect(display, p).not.toContain(p);
  });

  it('mapAssetRefs returns the same doc when nothing changes', () => {
    const doc = richDoc();
    expect(mapAssetRefs(doc, (a) => a)).toBe(doc);
  });
});

describe('v5 doc helpers', () => {
  it('target keys, labels, versions and variants', () => {
    const doc = richDoc();
    for (const t of [{ kind: 'page', id: 'pg_1' }, { kind: 'cover' }, { kind: 'sheet', id: 'ch_maya' }, { kind: 'style_option', id: 'so_a' }] as const) {
      expect(parseTargetKey(renderTargetKey(t))).toEqual(t);
    }
    expect(parseTargetKey('bogus')).toBeNull();
    expect(targetLabel(doc, { kind: 'page', id: 'pg_3' })).toBe('Page 3');
    expect(targetLabel(doc, { kind: 'sheet', id: 'ch_maya' })).toBe('MAYA sheet');
    expect(targetLabel(doc, { kind: 'place', id: 'pl_market' })).toBe('SPICE MARKET');
    const r = page1(doc).render;
    expect(versionsOf(r).map((v) => v.path)).toEqual(['u/proj/pages/p1.png', 'u/proj/pages/p1.png.old']);
    expect((currentVersion(r) as RenderVersion).qc?.score).toBe(0.82);
    const a = asset2('o.png', { w: 2048, variants: [{ path: 'o480.webp', w: 480, h: 600 }, { path: 'o1080.webp', w: 1080, h: 1350 }] });
    expect(thumbOf(a)?.path).toBe('o480.webp');
    expect(variantFor(a, 400, 2).path).toBe('o1080.webp');
    expect(variantFor(a, 900, 3).path).toBe('o.png');
    expect(thumbOf(undefined)).toBeUndefined();
  });

  it('castNoun names groups', () => {
    const c = normalizeDoc(makeSampleDoc()).cast[0];
    expect(castNoun({ ...c, name: 'Ducklings', count: 3 })).toBe('three Ducklings');
    expect(castNoun({ ...c, name: 'Frog' })).toBe('Frog');
    expect(castNoun({ ...c, name: 'Ants', count: 40 })).toBe('40 Ants');
  });
});

describe('v5 §16.9 models', () => {
  it('pro tier letters with overlay; aspect checks', () => {
    expect(TIER_PRESETS.pro.lettering).toBe('overlay');
    expect(aspectMatches('4:5', 2048, 2048)).toBe(false);
    expect(aspectMatches('4:5', 1856, 2304)).toBe(true);
    expect(aspectMatches('4:5')).toBe(true);
    expect(ASPECT_TOLERANCE).toBe(0.03);
    expect(aspectFromSize(2048, 2048)).toBe('1:1');
    expect(aspectFromSize(1856, 2304)).toBe('4:5');
  });
});

// ── P2-AMEND: the wave-2 contract amendments (additive; old docs load unchanged; hashes pinned above) ──

import { ERROR_DETAIL_LIMITS, normalizeErrorDetail, type RenderErrorDetail } from './doc';
import { PLAN_INPUT_HASH_MAX, type BookPatch, type RefPatch } from './ops';
import { inverseOps, isUndoable } from './undo';
import { STREAM_ERROR_CODES, isStreamErrorCode } from './events';
import { STYLE_DIRECTIONS_USD, styleDirectionsUsd } from './models';
import { sanitizeStudioUsage, DEFAULT_CAPS } from './capabilities';
import { publishableText } from './safety';
import { versionList } from './book';
import { PUBLIC_COMIC_NOT_FOUND, type ReaderLanguage } from './publication';

describe('P2-AMEND RenderState.errorDetail (P1-JOBS / wm-plan shape)', () => {
  const detail: RenderErrorDetail = { code: '429', provider: 'OpenRouter', at: 1_761_000_000_000, text: 'OpenRouter · 429 · upstream Google · 17:42 UTC' };
  const page1 = { kind: 'page' as const, id: 'pg_1' };

  it('normalizeErrorDetail keeps only well-formed details, clips the strings and is idempotent', () => {
    expect(normalizeErrorDetail(detail)).toEqual(detail);
    expect(normalizeErrorDetail({ ...detail, provider: 7 })).toEqual({ code: '429', at: detail.at, text: detail.text });
    for (const bad of [null, 'OpenRouter · 503', [], { code: 1, at: 1, text: 'x' }, { code: 'x', at: 'yesterday', text: 'x' }, { code: 'x', at: 1 }, { code: ' ', at: 1, text: 'x' }]) {
      expect(normalizeErrorDetail(bad)).toBeUndefined();
    }
    const long = normalizeErrorDetail({ code: 'C'.repeat(99), provider: 'P'.repeat(99), at: 1, text: 'T'.repeat(999) })!;
    expect([long.code.length, long.provider!.length, long.text.length]).toEqual([ERROR_DETAIL_LIMITS.code, ERROR_DETAIL_LIMITS.provider, ERROR_DETAIL_LIMITS.text]);
    expect(normalizeErrorDetail(long)).toEqual(long);
    // One line, and idempotent even when the clip lands on a space (trim happens after the clip).
    const edge = normalizeErrorDetail({ code: ' 429\n', provider: 'Open\tRouter\u0000', at: 1, text: `${'a'.repeat(ERROR_DETAIL_LIMITS.text - 1)} tail\nmore` })!;
    expect(edge).toEqual({ code: '429', provider: 'Open Router', at: 1, text: 'a'.repeat(ERROR_DETAIL_LIMITS.text - 1) });
    expect(normalizeErrorDetail(edge)).toEqual(edge);
    expect(normalizeErrorDetail({ code: '\n\t', at: 1, text: 'x' })).toBeUndefined();
    expect(normalizeErrorDetail({ code: 'x', provider: ' \n ', at: 1, text: 'x' })).toEqual({ code: 'x', at: 1, text: 'x' });
  });

  it('normalizeDoc keeps a valid detail on a failed render and drops a malformed one (old string shape too)', () => {
    const raw = makeSampleDoc();
    raw.pages[5].render = { ...raw.pages[5].render, status: 'failed', error: 'The provider is busy.', errorDetail: detail };
    raw.pages[4].render = { ...raw.pages[4].render, errorDetail: 'OpenRouter · 503' as unknown as RenderErrorDetail };
    const doc = normalizeDoc(raw);
    expect(doc.pages[5].render.errorDetail).toEqual(detail);
    expect('errorDetail' in doc.pages[4].render).toBe(false);
    expect(normalizeDoc(doc)).toEqual(doc);
    // The hashes never read it.
    expect(doc.pages.map((p) => pageSpecHash(doc, p))).toEqual(makeSampleDoc().pages.map((p) => pageSpecHash(makeSampleDoc(), p)));
  });

  it('is set with error and cleared whenever error is cleared (also over the wire, where undefined → null)', () => {
    let doc = normalizeDoc(makeSampleDoc());
    doc = applyOp(doc, { op: 'render', target: page1, patch: { status: 'failed', error: 'Busy', errorDetail: detail, updatedAt: 1 } });
    expect(doc.pages[0].render.errorDetail).toEqual(detail);
    // A patch that leaves the error alone keeps the detail.
    expect(applyOp(doc, { op: 'render', target: page1, patch: { attempts: 2 } }).pages[0].render.errorDetail).toEqual(detail);
    // Retry: error cleared → detail cleared (server side and after encodeStudioEvent).
    const retry: DocOp = { op: 'render', target: page1, patch: { status: 'queued', error: undefined, updatedAt: 2 } };
    expect('errorDetail' in applyOp(doc, retry).pages[0].render).toBe(false);
    const wire = (JSON.parse(encodeStudioEvent({ type: 'ops', rev: 1, ops: [retry] })) as { ops: DocOp[] }).ops[0];
    expect('errorDetail' in applyOp(doc, wire).pages[0].render).toBe(false);
    // A new error without a detail never inherits the stale one; a status change away from failed drops it.
    expect('errorDetail' in applyOp(doc, { op: 'render', target: page1, patch: { status: 'failed', error: 'Other' } }).pages[0].render).toBe(false);
    expect('errorDetail' in applyOp(doc, { op: 'render', target: page1, patch: { status: 'rendering' } }).pages[0].render).toBe(false);
    // A detail without an error is never stored; a malformed one is never stored.
    const fresh = normalizeDoc(makeSampleDoc());
    expect('errorDetail' in applyOp(fresh, { op: 'render', target: { kind: 'page', id: 'pg_2' }, patch: { errorDetail: detail } }).pages[1].render).toBe(false);
    expect(
      'errorDetail' in applyOp(fresh, { op: 'render', target: page1, patch: { status: 'failed', error: 'x', errorDetail: { code: 9 } as unknown as RenderErrorDetail } }).pages[0].render
    ).toBe(false);
    // Switching to a saved version clears error and detail together.
    const used = applyOp(doc, { op: 'render_use', target: page1, path: doc.pages[0].render.history[0].path, at: 3 });
    expect(used.pages[0].render.error).toBeUndefined();
    expect('errorDetail' in used.pages[0].render).toBe(false);
  });
});

describe('P2-AMEND ops: plan_input_hash, RefPatch null, book null, render_use adopt, archive parentPath', () => {
  it('plan_input_hash (server-only): a string sets doc.planInputHash, null deletes it, junk is a no-op', () => {
    const doc = normalizeDoc(makeSampleDoc());
    const set = applyOp(doc, { op: 'plan_input_hash', hash: 'abc123' });
    expect(set.planInputHash).toBe('abc123');
    expect(applyOp(set, { op: 'plan_input_hash', hash: 'abc123' })).toBe(set);
    expect('planInputHash' in applyOp(set, { op: 'plan_input_hash', hash: null })).toBe(false);
    expect(applyOp(doc, { op: 'plan_input_hash', hash: null })).toBe(doc);
    for (const bad of ['', 'x'.repeat(PLAN_INPUT_HASH_MAX + 1), 42]) expect(applyOp(doc, { op: 'plan_input_hash', hash: bad as string })).toBe(doc);
    expect(normalizeDoc(set).planInputHash).toBe('abc123');
    expect(CLIENT_PATCHABLE_OPS.has('plan_input_hash')).toBe(false);
    expect(SERVER_ONLY_OPS).toContain('plan_input_hash');
    expect(inverseOps(doc, [{ op: 'plan_input_hash', hash: 'abc123' }])).toEqual([]);
    expect(isUndoable(doc, [{ op: 'plan_input_hash', hash: 'abc123' }])).toBe(false);
  });

  it('ref_patch null clears a key (label/note/crop); a null path is ignored', () => {
    const doc = richDoc();
    const owner = { kind: 'character' as const, id: 'ch_maya' };
    const patch: RefPatch = { label: null, note: null, crop: null, path: null as unknown as string };
    const next = applyOp(doc, { op: 'ref_patch', owner, path: 'u/proj/refs/maya2.jpg', patch });
    const ref = next.cast.find((c) => c.id === 'ch_maya')!.refs.find((r) => r.path === 'u/proj/refs/maya2.jpg')!;
    expect(ref).toBeDefined();
    expect('label' in ref).toBe(false);
    expect('note' in ref).toBe(false);
    expect(ref.w).toBe(doc.cast.find((c) => c.id === 'ch_maya')!.refs.find((r) => r.path === 'u/proj/refs/maya2.jpg')!.w);
  });

  it('book patch: blurb/credits null clear them, and the undo of a first blurb round-trips', () => {
    const doc = richDoc();
    const cleared = applyOp(doc, { op: 'book', patch: { blurb: null, credits: null } satisfies BookPatch });
    expect('blurb' in cleared.book!).toBe(false);
    expect('credits' in cleared.book!).toBe(false);
    const before = normalizeDoc(makeSampleDoc());
    const ops: DocOp[] = [{ op: 'book', patch: { blurb: 'New blurb', credits: ['Me'] } }];
    const after = applyOps(before, ops, 5);
    const undone = applyOps(after, inverseOps(before, ops), 6);
    expect(undone.book).toEqual(before.book);
  });

  it('render_use adopt is a UI flag the reducer ignores', () => {
    const doc = richDoc();
    const path = doc.pages[0].render.history[0].path;
    const a = applyOp(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path, at: 9, adopt: true });
    const b = applyOp(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path, at: 9 });
    expect(a).toEqual(b);
  });

  it('archived versions keep parentPath (fit_render once-per-original survives archiving)', () => {
    let doc = normalizeDoc(makeSampleDoc());
    const target = { kind: 'page' as const, id: 'pg_1' };
    for (let i = 0; i < MAX_RENDER_HISTORY + 2; i += 1) {
      doc = applyOp(doc, { op: 'render', target, patch: { status: 'ready', asset: { path: `edit_${i}.webp`, source: 'generated', at: 100 + i }, parentPath: `src_${i}.webp`, origin: 'edit', updatedAt: 100 + i } });
    }
    const archived = archiveOf(doc).filter((a) => a.path.startsWith('edit_'));
    expect(archived.length).toBeGreaterThan(0);
    for (const a of archived) expect(a.parentPath).toBe(a.path.replace('edit_', 'src_'));
  });
});

describe('P2-AMEND undo: every inverse is client-patchable', () => {
  it('removing an edition restores its lines with per-line translation ops (never the server-only batch op)', () => {
    const before = richDoc();
    const ops: DocOp[] = [{ op: 'edition', lang: 'hi', patch: null }];
    const inverse = inverseOps(before, ops);
    expect(inverse.some((o) => o.op === 'translations')).toBe(false);
    expect(inverse.filter((o) => o.op === 'translation').map((o) => (o as Extract<DocOp, { op: 'translation' }>).lineId)).toEqual(Object.keys(before.i18n!.editions.hi.lines));
    const undone = applyOps(applyOps(before, ops, 8), inverse, 9);
    expect(undone.i18n!.editions.hi).toEqual(before.i18n!.editions.hi);
  });

  it('a mixed batch of every patchable op inverts to patchable ops only', () => {
    const before = richDoc();
    const ops: DocOp[] = [
      { op: 'brief', patch: { logline: 'New' } },
      { op: 'character_remove', id: 'ch_maya' },
      { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p1', id: 'pg_1_l1', patch: null },
      { op: 'page_delete', id: 'pg_2', deletedAt: 10 },
      { op: 'book', patch: { blurb: 'x' } },
      { op: 'edition', lang: 'hi', patch: null },
      { op: 'ref_transfer', from: { kind: 'inbox' }, to: { kind: 'style' }, path: 'u/proj/refs/inbox1.jpg' },
      { op: 'letter_style', patch: { presetId: 'manga' } }
    ];
    const inverse = inverseOps(before, ops);
    expect(inverse.length).toBeGreaterThan(ops.length);
    for (const op of inverse) expect(CLIENT_PATCHABLE_OPS.has(op.op), op.op).toBe(true);
  });
});

describe('P2-AMEND events, models, caps, safety text, versions, public payload', () => {
  it('stream error codes include FORBIDDEN (restricted accounts), BUSY and COOLDOWN', () => {
    for (const c of ['FORBIDDEN', 'BUSY', 'COOLDOWN', 'CONTENT_POLICY', 'NOT_AVAILABLE']) expect(isStreamErrorCode(c), c).toBe(true);
    expect(isStreamErrorCode('SOMETHING_NEW')).toBe(false);
    expect(new Set(STREAM_ERROR_CODES).size).toBe(STREAM_ERROR_CODES.length);
  });

  it('the style-directions writer cost is one shared number (markup unless BYOK)', () => {
    expect(STYLE_DIRECTIONS_USD).toBe(0.015);
    expect(styleDirectionsUsd(true)).toBe(0.015);
    expect(styleDirectionsUsd()).toBeCloseTo(0.015 * PLATFORM_MARKUP, 6);
  });

  it('StudioCaps.usage is optional, percentage-only and sanitized', () => {
    expect(DEFAULT_CAPS.usage).toBeUndefined();
    expect(sanitizeStudioUsage({ governed: true, pctLeft: 140, exhausted: false, pctPerStandardPage: -3 })).toEqual({ governed: true, pctLeft: 100, exhausted: false, pctPerStandardPage: 0 });
    expect(sanitizeStudioUsage({ governed: true, pctLeft: 0, exhausted: true, pctPerStandardPage: 'x' })).toEqual({ governed: true, pctLeft: 0, exhausted: true, pctPerStandardPage: null });
    expect(sanitizeStudioUsage({ governed: 'yes', pctLeft: 1 })).toBeUndefined();
    expect(sanitizeStudioUsage(null)).toBeUndefined();
    // No dollar keys can ride along.
    expect(Object.keys(sanitizeStudioUsage({ governed: false, pctLeft: 50, exhausted: false, pctPerStandardPage: 2, usd: 4.2, budgetUsd: 10 })!).sort()).toEqual(['exhausted', 'governed', 'pctLeft', 'pctPerStandardPage']);
  });

  it('publishableText covers every published author text, and docs without them keep their exact text', () => {
    const plain = normalizeDoc(makeSampleDoc((d) => { delete d.style.name; }));
    // The pre-amendment formula: docs without the extra author texts keep their exact text (and cached text-check hash).
    const lines = plain.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines.map((l) => l.text)));
    const legacy = [plain.brief.title, plain.brief.logline, plain.cover.title, plain.cover.tagline, ...plain.cast.map((c) => c.name), ...lines]
      .map((t) => (t || '').trim())
      .filter(Boolean)
      .join('\n');
    const plainText = publishableText(plain);
    expect(plainText).toBe(legacy);
    const doc = applyOps(plain, [
      { op: 'page', id: 'pg_2', patch: { chapterTitle: 'CHAPTER-TEXT' } },
      { op: 'book', patch: { blurb: 'BLURB-TEXT', credits: ['CREDIT-TEXT'] } },
      { op: 'reader', patch: { credits: 'ENDCARD-TEXT', dedication: 'DEDICATION-TEXT' } },
      { op: 'style', patch: { name: 'STYLE-NAME' } }
    ], 3);
    const words = publishableText(doc);
    for (const t of ['CHAPTER-TEXT', 'BLURB-TEXT', 'CREDIT-TEXT', 'ENDCARD-TEXT', 'DEDICATION-TEXT', 'STYLE-NAME']) expect(words).toContain(t);
    expect(words.startsWith(plainText)).toBe(true);
  });

  it('versionList numbers v1 = oldest across current, history and archive (one path once)', () => {
    let doc = normalizeDoc(makeSampleDoc());
    const target = { kind: 'page' as const, id: 'pg_1' };
    for (let i = 0; i < MAX_RENDER_HISTORY + 3; i += 1) {
      const at = 2_000_000_000_000 + i; // newer than every sample asset
      doc = applyOp(doc, { op: 'render', target, patch: { status: 'ready', asset: { path: `v_${String(i).padStart(2, '0')}.webp`, source: 'generated', at }, updatedAt: at } });
    }
    const list = versionList(doc, target);
    expect(list.map((v) => v.n)).toEqual(list.map((_, i) => i + 1));
    expect(list.filter((v) => v.current)).toHaveLength(1);
    expect(list[list.length - 1]).toMatchObject({ current: true, path: 'v_10.webp' });
    expect(list.some((v) => v.archived)).toBe(true);
    expect(new Set(list.map((v) => v.path)).size).toBe(list.length);
    const ats = list.map((v) => v.version.at || 0);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(versionList(doc, { kind: 'page', id: 'nope' })).toEqual([]);
  });

  it('GET /public/:id shapes: one canonical 404 body; ReaderLanguage fields', () => {
    expect(PUBLIC_COMIC_NOT_FOUND).toEqual({ error: { message: "This comic isn't available.", code: 'NOT_FOUND' } });
    const lang: ReaderLanguage = { code: 'te', endonym: 'తెలుగు', english: 'Telugu', complete: false, isSource: false };
    expect(Object.keys(lang).sort()).toEqual(['code', 'complete', 'endonym', 'english', 'isSource']);
  });

  it('translate lineIds have a shared cap', () => {
    expect(DOC_LIMITS.translateLineIds).toBe(200);
    expect(isSpendAction({ type: 'translate', languages: ['te'], lineIds: ['pg_1_l1'] })).toBe(true);
  });
});

// ── Comic History H0 (versions plan §3.3) ────────────────────────────────────
import { expectTypeOf } from 'vitest';
import { HISTORY_ACTION_TYPES, type HistoryCard } from './history/types';
import { HISTORY_LIMITS, MAX_ALTERNATIVES } from './limits';
import { KNOWN_DOC_OPS, isKnownDocOp } from './ops';
import { STREAM_EVENT_NAMES, normalizeTimeZone } from './events';
import { HISTORY_ENV, historyEnabled, historyFlagOn, maxAlternativesOf, resolveStudioCaps, withHistoryCaps } from './capabilities';

describe('Comic History contract (H0)', () => {
  it('history_restore is server-only: never client-patchable, never undoable, but known to every client', () => {
    expect(SERVER_ONLY_OPS).toContain('history_restore');
    expect(CLIENT_PATCHABLE_OPS.has('history_restore' as DocOp['op'])).toBe(false);
    for (const op of SERVER_ONLY_OPS) expect(CLIENT_PATCHABLE_OPS.has(op), op).toBe(false);
    expect(isKnownDocOp({ op: 'history_restore' })).toBe(true);
    expect(isKnownDocOp({ op: 'panel_frames_from_the_future' })).toBe(false);
    // K2a: the Ship 2 ops are known to every client even while they are not client-patchable yet.
    expect(KNOWN_DOC_OPS.size).toBe(CLIENT_PATCHABLE_OPS.size + SERVER_ONLY_OPS.length + (PRO_PAGE_OPS_PATCHABLE ? 0 : PRO_PAGE_PATCH_OPS.length));
    const doc = richDoc();
    const restore: DocOp = { op: 'history_restore', set: { brief: { ...doc.brief, title: 'Then' } }, mode: 'merge', versionId: 'v1', at: 5 };
    expect(isUndoable(doc, [restore])).toBe(false);
    expect(inverseOps(doc, [restore])).toEqual([]);
  });

  it('every history action is NON_SPEND (free), never a spend action', () => {
    expect([...HISTORY_ACTION_TYPES].sort()).toEqual(['history_alternative', 'history_forget_photo', 'history_restore', 'history_save', 'history_undo_ai']);
    for (const t of HISTORY_ACTION_TYPES) {
      expect(NON_SPEND_ACTION_TYPES.has(t), t).toBe(true);
      expect(SPEND_ACTION_TYPES.has(t), t).toBe(false);
    }
    expect(isSpendAction({ type: 'history_restore', versionId: 'v', scope: { kind: 'book' } })).toBe(false);
    expect(isSpendAction({ type: 'history_undo_ai' })).toBe(false);
  });

  it('the history card is a conversation Card (typecheck), holds ids only and survives normalizeDoc', () => {
    // Type contract (npm run typecheck): the `history` member of Card is exactly HistoryCard.
    expectTypeOf<Extract<Card, { type: 'history' }>>().toEqualTypeOf<HistoryCard>();
    const card: HistoryCard = { type: 'history', id: 'card_h', view: 'compare', a: 'v1', b: 'now', pageId: 'pg_1', scope: { kind: 'page', pageId: 'pg_1', mode: 'replace', part: 'text' } };
    const asCard: Card = card;
    // Ids only: every field is a short id/enum string, or a scope made of them (no doc bodies, no URLs).
    const leaves = (v: unknown): unknown[] => (v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [v]);
    for (const leaf of leaves(asCard)) expect(typeof leaf === 'string' && leaf.length <= 64 && !/[/:]/.test(leaf), String(leaf)).toBe(true);
    const doc = normalizeDoc({ ...createEmptyDoc('h'), conversation: [{ id: 'm', role: 'assistant', text: 'Here', at: 1, cards: [card] }] });
    expect(doc.conversation[0].cards).toEqual([card]);
  });

  it('limits: one constant each (V-1: at most 5 versions inside one comic)', () => {
    expect(MAX_ALTERNATIVES).toBe(5);
    expect(HISTORY_LIMITS).toMatchObject({
      unpinnedRows: 300, namedRows: 100, alternatives: 5, bytesPerComic: 25_000_000, changesPerRow: 60, thumbsPerRow: 8,
      quietEditMinutes: 10, quietEditCommits: 25, quietEditPages: 3, gapMinutes: 30, aiRunGapMinutes: 10, beforeRestoreDays: 30, savesPerHour: 30
    });
  });

  it('caps: history is off unless COMIC_HISTORY is on, and off adds nothing to the caps on the wire', () => {
    expect(HISTORY_ENV).toBe('COMIC_HISTORY');
    expect('history' in DEFAULT_CAPS).toBe(false);
    expect('maxAlternatives' in DEFAULT_CAPS).toBe(false);
    const caps = resolveStudioCaps({ byok: false, isAdmin: false });
    expect(historyEnabled(caps)).toBe(false);
    expect(withHistoryCaps(caps, historyFlagOn(undefined))).toBe(caps);
    expect(withHistoryCaps(caps, historyFlagOn(''))).toBe(caps);
    expect(withHistoryCaps(caps, historyFlagOn('0'))).toBe(caps);
    const on = withHistoryCaps(caps, historyFlagOn('1'));
    expect(on).toEqual({ ...caps, history: true, maxAlternatives: 5 });
    expect(historyEnabled(on)).toBe(true);
    expect(maxAlternativesOf({ maxAlternatives: 3 })).toBe(3);
    expect(maxAlternativesOf({ maxAlternatives: 0 })).toBe(5);
  });

  it('events: the history event name and the request time zone (validated with Intl)', () => {
    expect(STREAM_EVENT_NAMES).toContain('history');
    expect(normalizeTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(normalizeTimeZone('Asia/Kolkata')).toMatch(/^Asia\/(Kolkata|Calcutta)$/);
    for (const bad of ['', 'Mars/Olympus', 'UTC; drop table', 42, null, 'a'.repeat(80)]) expect(normalizeTimeZone(bad), String(bad)).toBeUndefined();
  });
});

// ── Ship 2 contract (K2a; pro plan §5.2–§5.6) ────────────────────────────────
import {
  DEFAULT_FRAME_STYLE,
  VERSION_META_KEYS,
  artModeOf,
  consistencyOf,
  cutFor,
  frameStyleOf,
  dropPanelSourcePaths,
  mapPanelSourcePaths,
  normalizeBalloonShip2,
  normalizeConsistencyFinding,
  normalizeConsistencySettings,
  normalizePageContinuity,
  normalizePageLayers,
  normalizePanelCuts,
  normalizePanelDirection,
  normalizePanelFrame,
  normalizeScenes,
  normalizeVersionParts,
  pageSourcePaths,
  scenesOf,
  type PanelCuts
} from './doc';
import { INVERTIBLE_OPS, PRO_PAGE_OPS_PATCHABLE, PRO_PAGE_PATCH_OPS, clampBalloonPatch } from './ops';
import { describeOps } from './undo';
import { PANEL_RES_STEP, tierPanelPrice } from './models';
import { CONSISTENCY_LIMITS, EDITOR_LIMITS, PRO_PAGE_LIMITS } from './limits';
import { drawnPanelBoxes, estimatePanelBoxes, panelBoxesFor } from './pageGeometry';
import { letteringAspect, planLettering, estimateMeasure } from './lettering/layout';
import { composeAspect, frameAffine, pageSpaceQc } from './panelize/space';
import { partsOf } from './parts';
import { TOP_LEVEL_SECTIONS, TYPED_META_KEYS, excludedOf, isExtraMetaKey, joinSections, sectionSignatures, splitSections, unassignedKeys } from './history/sections';
import { AI_ACTIONS, EDITOR_ACTIONS, opActor, touchedKeys } from './history/touched';
import { describeChanges, panelMomentsOfOps, withPanelMoments } from './history/describe';
import { diffBooks } from './history/diff';
import { historyV4Doc, historyV5Doc } from './history/__fixtures__/books';
import { randomBook, rngOf } from './history/__fixtures__/random';
import type { StudioFocus } from './events';

describe('Ship 2 contract (K2a)', () => {
  // ── Fixtures (synthetic) ──
  const K_PATH = 'u/user-k/p/proj-k/img/p1.webp';
  const bx = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const FRAMES = [bx(0.02, 0.02, 0.96, 0.46), bx(0.02, 0.5, 0.47, 0.48), bx(0.51, 0.5, 0.47, 0.48)];
  const CUTS: PanelCuts = { status: 'ok', by: 'detect', at: 11, cuts: FRAMES.map((box, i) => ({ panelId: `pk_${i + 1}`, drawn: i + 1, box, conf: 0.95 })) };

  /** One drawn page (2:3 drawing on a 2:3 book), three panels, balloons, a Hindi override, an overlay; fresh stamp. */
  const kDoc = (opts: { panels?: boolean; square?: boolean } = {}): ComicDoc => {
    const raw = {
      ...createEmptyDoc('proj-k', 'Market', 1000),
      cast: [{ id: 'ch_k', name: 'Maya', tier: 'lead' as const, look: { summary: 'A wiry girl in a saffron scarf' }, refs: [], sheet: emptyRender() }],
      pages: [
        {
          id: 'pg_k',
          n: 1,
          summary: 'Market chase',
          layout: 'Row 1: one wide panel (panel 1). Row 2: two equal panels side by side (panels 2–3).',
          panels: [
            { id: 'pk_1', n: 1, size: 'wide' as const, shot: 'establishing' as const, action: 'The market at dawn.', castIds: ['ch_k'], lines: [{ id: 'lk_1', kind: 'caption' as const, text: 'Dawn.' }] },
            { id: 'pk_2', n: 2, size: 'medium' as const, shot: 'close_up' as const, action: 'Maya grabs a tin.', castIds: ['ch_k'], lines: [{ id: 'lk_2', kind: 'speech' as const, speakerId: 'ch_k', text: 'Just one more.' }] },
            { id: 'pk_3', n: 3, size: 'medium' as const, shot: 'medium' as const, action: 'She runs.', castIds: ['ch_k'], lines: [{ id: 'lk_3', kind: 'shout' as const, speakerId: 'ch_k', text: 'Run!' }] }
          ],
          render: {
            status: 'ready' as const,
            history: [],
            asset: { path: K_PATH, source: 'generated' as const, at: 10, w: opts.square ? 1024 : 1000, h: opts.square ? 1024 : 1500 },
            origin: 'render' as const,
            cuts: CUTS,
            qc: {
              score: 0.9,
              issues: [],
              checkedAt: 12,
              panelBoxes: FRAMES,
              keepOut: [{ panel: 2, box: bx(0.1, 0.6, 0.1, 0.1), kind: 'face' as const }],
              heads: [{ panel: 2, characterId: 'ch_k', head: { x: 0.2, y: 0.7 } }]
            }
          },
          balloons: [
            { lineId: 'lk_1', x: 0.05, y: 0.05, w: 0.3 },
            { lineId: 'lk_2', x: 0.1, y: 0.55, w: 0.25, tailX: 0.2, tailY: 0.8, pinned: true },
            { lineId: 'lk_3', x: 0.6, y: 0.55, w: 0.2, locked: true, pinned: true }
          ],
          layers: [{ id: 'ly_star', kind: 'shape' as const, box: bx(0.6, 0.6, 0.1, 0.1), clip: 'pk_3', shape: { type: 'ellipse' as const, fill: '#ffcc00' } }]
        }
      ]
    };
    let doc = normalizeDoc(raw as unknown as ComicDoc);
    doc = applyOps(doc, [
      { op: 'render', target: { kind: 'page', id: 'pg_k' }, patch: { specHash: pageSpecHash(doc, doc.pages[0]) } },
      { op: 'edition', lang: 'hi', patch: {} },
      { op: 'translation', lang: 'hi', lineId: 'lk_2', patch: { text: 'बस एक और।', status: 'reviewed', sourceHash: 'h', at: 3 } },
      { op: 'edition_balloon', lang: 'hi', lineId: 'lk_2', patch: { x: 0.12, y: 0.56 } }
    ], 5);
    if (opts.panels) doc = applyOps(doc, [{ op: 'page_frames', pageId: 'pg_k', artMode: 'panels', frames: FRAMES.map((box, i) => ({ panelId: `pk_${i + 1}`, frame: { box } })), moveBalloons: false }], 6);
    return doc;
  };

  /** R4 wire equality (null ≡ unset; updatedAt ignored). */
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (val !== null && val !== undefined) out[k] = canon(val);
      return out;
    }
    return v;
  };
  const same = (doc: ComicDoc) => canon({ ...doc, updatedAt: 0 });
  const wire = (ops: DocOp[]): DocOp[] => (JSON.parse(encodeStudioEvent({ type: 'ops', rev: 1, ops })) as { ops: DocOp[] }).ops;
  const json = (v: unknown) => JSON.parse(JSON.stringify(v));

  /** A random book with its drawn pages panelized (frames = cuts = the blueprint boxes); every third drawn page is stale;
   *  on some pages the last panel has no frame. */
  const panelized = (seed: number): ComicDoc => {
    const r = rngOf(seed * 31 + 7);
    const book = randomBook(seed);
    const pages = book.pages.map((p, i) => {
      if (!p.render.asset || !p.panels.length || p.render.status !== 'ready') return p;
      const boxes = estimatePanelBoxes(p, { readingDirection: book.format.readingDirection, kind: book.format.kind });
      const cuts: PanelCuts = { status: 'ok', by: 'detect', at: 1, cuts: p.panels.map((pn, j) => ({ panelId: pn.id, drawn: j + 1, box: boxes[j], conf: 0.9 })) };
      const findings = r() < 0.5 ? [{ id: `f_${i}`, kind: 'identity' as const, panel: 1, severity: 'minor' as const, note: 'The scarf is blue here' }] : undefined;
      return {
        ...p,
        ...(r() < 0.8 ? { artMode: 'panels' as const } : {}),
        ...(r() < 0.5 ? { frameStyle: { gutter: 0.03, color: '#101010' } } : {}),
        // Some pages leave their last panel without a frame (opted in, shown as drawn until it gets one or goes).
        panels: p.panels.map((pn, j) => ((seed + i) % 4 === 0 && p.panels.length > 1 && j === p.panels.length - 1 ? pn : { ...pn, frame: { box: boxes[j] } })),
        render: { ...p.render, cuts, ...(findings ? { qc: { score: 0.9, issues: [], checkedAt: 1, findings } } : {}) }
      };
    });
    const out = normalizeDoc({ ...book, pages, scenes: [{ id: 'sc_a', name: 'Market' }] });
    return { ...out, pages: out.pages.map((p, i) => (p.render.asset ? { ...p, render: { ...p.render, specHash: i % 3 === 2 ? 'stale000' : pageSpecHash(out, p) } } : p)) };
  };

  /** A random Ship 2 op (some of them no-ops on purpose: a ghost page, a wrong path). */
  const k2Op = (doc: ComicDoc, r: () => number, step: number): DocOp => {
    const pick = <T,>(l: readonly T[]): T => l[Math.floor(r() * l.length)];
    const chance = (p: number) => r() < p;
    const page = doc.pages.length ? pick(doc.pages) : undefined;
    const pageId = page && chance(0.95) ? page.id : 'ghost';
    const panel = page?.panels.length ? pick(page.panels) : undefined;
    const box = () => {
      const w = 0.1 + r() * 0.5;
      const h = 0.1 + r() * 0.4;
      return bx(Math.round(r() * (1 - w) * 1000) / 1000, Math.round(r() * (1 - h) * 1000) / 1000, Math.round(w * 1000) / 1000, Math.round(h * 1000) / 1000);
    };
    const uid = (p: string) => `${p}_k${step}_${Math.floor(r() * 1e6)}`;
    switch (pick(['frames', 'frames', 'mode', 'style', 'cuts', 'order', 'add', 'remove', 'layer', 'layer', 'continuity', 'scene', 'consistency', 'finding'] as const)) {
      case 'frames':
        return { op: 'page_frames', pageId, frames: [{ panelId: panel?.id ?? 'ghost', frame: chance(0.15) ? null : { box: box(), ...(chance(0.3) ? { fit: { s: 1 + r(), x: r() * 2 - 1, y: 0 } } : {}) } }], ...(chance(0.2) ? { moveBalloons: false } : {}) };
      case 'mode':
        return { op: 'page_frames', pageId, artMode: chance(0.5) ? 'panels' : null };
      case 'style':
        return { op: 'page_frames', pageId, frameStyle: chance(0.3) ? null : chance(0.2) ? undefined : { gutter: r() * 0.1, color: '#223344' } };
      case 'cuts': {
        const path = page?.render.asset?.path;
        return { op: 'page_cuts', pageId, path: chance(0.85) && path ? path : 'u/other.webp', cuts: chance(0.2) ? null : { status: 'unsure', by: 'detect', at: step, cuts: (page?.panels || []).map((pn, j) => ({ panelId: pn.id, drawn: j + 1, box: box(), conf: 0.8 })) } };
      }
      case 'order':
        return { op: 'panels_order', pageId, order: (page?.panels || []).map((p) => p.id).sort(() => r() - 0.5) };
      case 'add': {
        const sibling = page?.panels.length ? pick(page.panels) : undefined;
        const take = sibling?.lines.length && chance(0.5) ? [sibling.lines[0]] : [];
        return {
          op: 'panel_add',
          pageId,
          index: Math.floor(r() * ((page?.panels.length || 0) + 1)),
          panel: { id: uid('pn'), n: 0, size: 'medium', shot: 'medium', action: 'A new beat', castIds: [], lines: [...take, ...(chance(0.5) ? [{ id: uid('ln'), kind: 'speech' as const, text: 'Hey!' }] : [])], ...(chance(0.8) ? { frame: { box: box() } } : {}) }
        };
      }
      case 'remove': {
        // Half the time a panel without a frame when there is one (on an opted-in page its removal flips the display).
        const frameless = (page?.panels || []).filter((p) => !p.frame);
        const gone = frameless.length && chance(0.5) ? pick(frameless) : panel;
        const others = (page?.panels || []).filter((p) => p.id !== gone?.id);
        return { op: 'panel_remove', pageId, id: gone?.id ?? 'ghost', ...(others.length && chance(0.5) ? { linesTo: pick(others).id } : {}) };
      }
      case 'layer': {
        const existing = page?.layers || [];
        if (existing.length && chance(0.6)) {
          const l = pick(existing);
          if (chance(0.3)) return { op: 'layer', pageId, id: l.id, patch: null };
          return { op: 'layer', pageId, id: l.id, patch: chance(0.5) ? { box: box(), opacity: chance(0.5) ? undefined : 0.5 } : { kind: 'image', src: { path: 'u/user-r/sticker.webp' } } };
        }
        return { op: 'layer', pageId, id: uid('ly'), index: 0, patch: { kind: 'shape', box: box(), shape: { type: 'rect', fill: '#ff0000' }, ...(panel && chance(0.6) ? { clip: panel.id } : {}) } };
      }
      case 'continuity':
        return { op: 'continuity', pageId, patch: chance(0.2) ? null : { ...(chance(0.5) ? { notes: [`note ${step}`] } : {}), cast: { [doc.cast[0]?.id ?? 'c_x']: { outfit: 'red coat' } }, ...(chance(0.3) ? { sceneId: 'sc_a' } : {}) } };
      case 'scene': {
        const scenes = doc.scenes || [];
        if (scenes.length && chance(0.5)) {
          const s = pick(scenes);
          return chance(0.4) ? { op: 'scene', id: s.id, patch: null } : { op: 'scene', id: s.id, patch: { light: chance(0.5) ? 'golden' : null } };
        }
        return { op: 'scene', id: uid('sc'), patch: { name: `Scene ${step}`, time: 'dusk' }, index: 0 };
      }
      case 'consistency':
        return { op: 'consistency', patch: chance(0.3) ? { maxRefs: null, skip: null } : { maxRefs: 1 + Math.floor(r() * 10), skip: [`place:${step}`] } };
      default: {
        const f = page?.render.qc?.findings?.[0];
        return { op: 'finding', pageId, id: f?.id ?? 'ghost', patch: { dismissed: chance(0.5) ? true : null } };
      }
    }
  };

  /** Every Ship 2 field filled on a doc (valid values): frames, directions, page objects, balloon rot/minH, raster meta. */
  const fillShip2 = (base: ComicDoc): ComicDoc => {
    const d = json(base) as ComicDoc;
    d.scenes = [{ id: 'sc_1', name: 'Market', placeId: d.places[0]?.id, time: 'dawn', light: 'golden' }];
    d.consistency = { maxRefs: 8, styleKeyPageId: d.pages[0]?.id, skip: ['place:x'] };
    for (const page of d.pages) {
      const boxes = estimatePanelBoxes(page, { readingDirection: d.format.readingDirection, kind: d.format.kind });
      page.artMode = 'panels';
      page.frameStyle = { gutter: 0.03, border: 0.006, color: '#202020' };
      page.layers = [{ id: 'ly_1', kind: 'shape', box: bx(0.4, 0.4, 0.2, 0.1), shape: { type: 'rect', fill: '#ffffff' }, print: false }];
      page.continuity = { cast: { [d.cast[0]?.id || 'c']: { outfit: 'blue coat', holding: ['lantern'] } }, props: { lantern: 'lit' }, notes: ['rain stops'], by: 'writer' };
      page.panels.forEach((panel, j) => {
        panel.frame = { box: boxes[j], fit: { s: 1.2, x: 0, y: -0.5 }, border: { w: 0.004 } };
        panel.direction = { lens: 'wide', light: 'warm dawn', background: ['awnings'], cast: { [d.cast[0]?.id || 'c']: { expression: 'wary', pos: 'left' } }, by: 'writer' };
      });
      page.balloons = page.balloons.map((b) => ({ ...b, rot: 5, minH: 0.1 }));
      if (page.render.asset) {
        page.render.cuts = { status: 'ok', by: 'detect', at: 1, cuts: page.panels.map((pn, j) => ({ panelId: pn.id, drawn: j + 1, box: boxes[j], conf: 0.9 })) };
        page.render.parts = partsOf(d, page);
        page.render.anchorKeys = ['char:x', 'place:y'];
        page.render.qc = { ...(page.render.qc || { score: 0.9, issues: [], checkedAt: 1 }), checkV: 2, findings: [{ id: 'f1', kind: 'identity', panel: 1, severity: 'minor', note: 'Scarf colour' }] };
      }
    }
    return normalizeDoc(d);
  };

  // Spec hashes and the normalized-doc fingerprint, captured on the base (bde91dcb) before any Ship 2 code existed.
  const GOLDEN = {
    v4: {
      pages: ['e4ad3dae', '78c45272', '6dda590e', 'c2ceaab5', 'a07596b1'],
      sheets: ['1a50eb87', '7d5cad60', 'bf08b1f8', '14819b42'],
      places: [] as string[],
      cover: '674ba56c',
      plan: '89305a3e',
      norm: '6da9d578'
    },
    v5: {
      pages: ['ef2237d9', '81f85b58', 'e7462403', 'e940374a', '8ae0118d', 'e653234c'],
      sheets: ['e4acb465', 'd537483e', 'cf4cd9f1'],
      places: ['1beeaee2', '1a59baa9'],
      cover: '54f22bff',
      plan: 'ad156042',
      norm: '73b6edb8'
    }
  };
  const specHashes = (d: ComicDoc) => ({
    pages: d.pages.map((p) => pageSpecHash(d, p)),
    sheets: d.cast.map((c) => sheetSpecHash(d, c)),
    places: d.places.map((p) => placeSpecHash(d, p)),
    cover: coverSpecHash(d),
    plan: planInputHashOf(d)
  });

  it('I1: golden spec hashes are unchanged on both fixture shapes, and old docs normalize deep-equal', () => {
    for (const [name, make] of [['v4', historyV4Doc], ['v5', historyV5Doc]] as const) {
      const old = normalizeDoc(json(make()));
      const { norm, ...hashes } = GOLDEN[name];
      expect(specHashes(old), name).toEqual(hashes);
      // Old docs deep-equal: the normalized doc is byte-for-byte what bde91dcb produced, and normalizing again changes nothing.
      expect(hashString(stableStringify(old)), name).toBe(norm);
      expect(normalizeDoc(json(old)), name).toEqual(old);
      // Every Ship 2 field filled (frames, fits, directions, overlays, continuity, scenes, cuts, parts, findings, rot/minH):
      // no spec hash moves (nothing new is hashed), the values are kept, and the filled doc is idempotent.
      const full = fillShip2(old);
      expect(specHashes(full), name).toEqual(hashes);
      expect(full.pages.every((p) => p.artMode === 'panels' && p.layers?.length === 1 && p.continuity && p.panels.every((pn) => pn.frame && pn.direction)), name).toBe(true);
      expect(full.scenes?.length && full.consistency?.maxRefs, name).toBe(8);
      expect(normalizeDoc(json(full)), name).toEqual(full);
      for (const p of full.pages.filter((x) => x.render.asset)) expect(isPageStale(full, { ...p, render: { ...p.render, specHash: pageSpecHash(old, old.pages.find((o) => o.id === p.id)!) } }), p.id).toBe(false);
    }
  });

  it('normalizers drop the malformed, clamp ranges and are idempotent (property over garbage)', () => {
    expect(normalizePanelFrame({ box: bx(NaN, 0, 0.5, 0.5) })).toBeUndefined();
    expect(normalizePanelFrame({ box: bx(0.9, -1, 0.01, 3), fit: { s: 9, x: -3, y: 0.5 }, z: 500, locked: 'yes' })).toEqual({ box: bx(0.9, 0, 0.04, 1), fit: { s: 4, x: -1, y: 0.5 }, z: 100 });
    expect(normalizePageLayers([{ id: 'nope', kind: 'shape', box: bx(0, 0, 0.1, 0.1), shape: { type: 'rect' } }, { id: 'ly_img', kind: 'image', box: bx(0, 0, 0.1, 0.1) }])).toBeUndefined();
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `ly_${i % 26}`, kind: 'shape', box: bx(0, 0, 0.1, 0.1), shape: { type: 'rect' } }));
    expect(normalizePageLayers(many)).toHaveLength(EDITOR_LIMITS.layersPerPage);
    expect(normalizePanelCuts({ status: 'ok', by: 'detect', at: 1, cuts: Array.from({ length: 13 }, (_, i) => ({ drawn: i + 1, box: bx(0, 0, 0.1, 0.1), conf: 1 })) })!.cuts).toHaveLength(EDITOR_LIMITS.maxCuts);
    expect(normalizePanelCuts({ status: 'great', by: 'detect', at: 1, cuts: [] })).toBeUndefined();
    expect(normalizeScenes(Array.from({ length: 61 }, (_, i) => ({ id: `sc_${i}`, name: `S${i}` })))).toHaveLength(CONSISTENCY_LIMITS.scenes);
    const polluted = normalizePageContinuity(JSON.parse('{"cast":{"__proto__":{"outfit":"x"},"c_1":{"outfit":"red"}},"props":{"constructor":"x","lamp":null}}'));
    expect(polluted).toEqual({ cast: { c_1: { outfit: 'red' } }, props: { lamp: null } });
    expect(({} as Record<string, unknown>).outfit).toBeUndefined();
    expect(normalizeBalloonShip2({ lineId: 'l', x: 0, y: 0, w: 0.2, rot: 90, minH: 0.9 })).toEqual({ lineId: 'l', x: 0, y: 0, w: 0.2, rot: 45, minH: 0.6 });
    expect(normalizeBalloonShip2({ lineId: 'l', x: 0, y: 0, w: 0.2, minH: -1 } as never)).toEqual({ lineId: 'l', x: 0, y: 0, w: 0.2 });
    expect(clampBalloonPatch({ rot: -80, minH: 2 })).toEqual({ rot: -45, minH: 0.6 });
    expect(normalizeConsistencyFinding({ id: 'f', kind: 'identity', panel: 2, severity: 'major', note: ' x ', fix: { kind: 'rebind', order: [2, 1] } })).toEqual({ id: 'f', kind: 'identity', panel: 2, severity: 'major', note: 'x', fix: { kind: 'rebind', order: [2, 1] } });
    expect(normalizeVersionParts({ panels: { p1: { c: 'abcdef', a: 'abcdef', p: 'abcdef', s: 'abcdef', m: 'xyz' } } })).toBeUndefined();
    expect(normalizeConsistencySettings({ maxRefs: 40, skip: [] })).toEqual({ maxRefs: PRO_PAGE_LIMITS.maxRefsMax });
    expect(frameStyleOf({ frameStyle: { gutter: 0.05 } })).toEqual({ ...DEFAULT_FRAME_STYLE, gutter: 0.05 });
    expect(scenesOf(createEmptyDoc('x'))).toEqual([]);
    expect(consistencyOf(createEmptyDoc('x'))).toEqual({});
    // Property: any garbage normalizes to a fixed point.
    const r = rngOf(99);
    const junk = (depth: number): unknown => {
      const k = Math.floor(r() * 8);
      if (depth > 3 || k === 0) return [null, undefined, NaN, -5, 0.5, 1e9, 'x', '#ffffff', 'ly_a', true][Math.floor(r() * 10)];
      if (k < 3) return Array.from({ length: Math.floor(r() * 4) }, () => junk(depth + 1));
      const keys = ['box', 'x', 'y', 'w', 'h', 'fit', 's', 'src', 'path', 'id', 'kind', 'shape', 'type', 'cuts', 'drawn', 'conf', 'status', 'by', 'at', 'cast', 'outfit', 'notes', 'lens', 'name', 'panels', 'c', 'a'];
      return Object.fromEntries(Array.from({ length: 1 + Math.floor(r() * 6) }, () => [keys[Math.floor(r() * keys.length)], junk(depth + 1)]));
    };
    const normalizers: ((v: unknown) => unknown)[] = [normalizePanelFrame, normalizePageLayers, normalizePanelCuts, normalizePageContinuity, normalizePanelDirection, normalizeScenes, normalizeConsistencySettings, normalizeVersionParts, normalizeConsistencyFinding];
    for (let i = 0; i < 400; i += 1) {
      const raw = junk(0);
      for (const n of normalizers) {
        const once = n(raw);
        expect(n(json(once ?? null)) ?? undefined).toEqual(once === undefined ? undefined : json(once));
      }
    }
  });

  it('artModeOf falls back to the page as drawn when frames or cuts are missing or inconsistent (I2)', () => {
    const doc = kDoc({ panels: true });
    const page = doc.pages[0];
    expect(artModeOf(page)).toBe('panels');
    expect(artModeOf(kDoc().pages[0])).toBe('page'); // never opted in
    expect(artModeOf(null)).toBe('page');
    expect(artModeOf({ ...page, panels: [] })).toBe('page');
    // One frame missing.
    expect(artModeOf(applyOps(doc, [{ op: 'page_frames', pageId: 'pg_k', frames: [{ panelId: 'pk_2', frame: null }], moveBalloons: false }]).pages[0])).toBe('page');
    // A new drawing clears the cuts (I3), so the frames have nothing to cut from.
    const redrawn = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_k' }, patch: { status: 'ready', asset: { path: 'u/user-k/p/proj-k/img/p1b.webp', source: 'generated', at: 20 } } }]);
    expect(redrawn.pages[0].render.cuts).toBeUndefined();
    expect(artModeOf(redrawn.pages[0])).toBe('page');
    // Cuts naming another plan's panels.
    expect(artModeOf({ ...page, render: { ...page.render, cuts: { ...CUTS, cuts: CUTS.cuts.map((c) => ({ ...c, panelId: `x_${c.panelId}` })) } } })).toBe('page');
    // A broken frame is dropped on load, so the page falls back too.
    const broken = normalizeDoc(json({ ...doc, pages: [{ ...page, panels: page.panels.map((p, i) => (i ? p : { ...p, frame: { box: bx(0, 0, NaN, 1) } })) }] }));
    expect(broken.pages[0].panels[0].frame).toBeUndefined();
    expect(artModeOf(broken.pages[0])).toBe('page');
    // A panel without a cut is an empty frame (still panels mode); frames with their own pictures need no cuts.
    expect(cutFor(page, 'pk_9')).toBeUndefined();
    const withEmpty = applyOps(doc, [{ op: 'panel_add', pageId: 'pg_k', panel: { id: 'pk_9', n: 0, size: 'small', shot: 'insert', action: '', castIds: [], lines: [], frame: { box: bx(0.4, 0.4, 0.2, 0.2) } } }]);
    expect(artModeOf(withEmpty.pages[0])).toBe('panels');
    const allSourced = { ...page, render: { ...page.render, cuts: undefined }, panels: page.panels.map((p) => ({ ...p, frame: { ...p.frame!, src: { path: K_PATH } } })) };
    expect(artModeOf(allSourced)).toBe('panels');
  });

  it('panelBoxesFor returns the frames only in panels mode', () => {
    const drawn = kDoc();
    const moved = bx(0.1, 0.1, 0.8, 0.3);
    const asDrawn = applyOps(drawn, [{ op: 'page_frames', pageId: 'pg_k', frames: [{ panelId: 'pk_1', frame: { box: moved } }] }]);
    // Frames stored but the page never opted in: the measured boxes, as before.
    expect(panelBoxesFor(asDrawn, asDrawn.pages[0])).toEqual(FRAMES);
    expect(drawnPanelBoxes(asDrawn, asDrawn.pages[0])).toEqual(FRAMES);
    const panels = applyOps(kDoc({ panels: true }), [{ op: 'page_frames', pageId: 'pg_k', frames: [{ panelId: 'pk_1', frame: { box: moved } }] }]);
    expect(panelBoxesFor(panels, panels.pages[0])).toEqual([moved, FRAMES[1], FRAMES[2]]);
    expect(drawnPanelBoxes(panels, panels.pages[0])).toEqual([moved, FRAMES[1], FRAMES[2]]);
    // Falls back with the mode: a redraw clears the cuts → the stored measurement again, never the stale frames.
    const redrawn = applyOps(panels, [{ op: 'render', target: { kind: 'page', id: 'pg_k' }, patch: { asset: { path: 'u/new.webp', source: 'generated', at: 30 }, qc: { score: 1, issues: [], checkedAt: 31, panelBoxes: FRAMES } } }]);
    expect(panelBoxesFor(redrawn, redrawn.pages[0])).toEqual(FRAMES);
  });

  it('letteringAspect is the book aspect in panels mode (a square drawing panelized onto a 2:3 page)', () => {
    const drawn = kDoc({ square: true });
    expect(letteringAspect(drawn, drawn.pages[0])).toBe(1);
    expect(composeAspect(drawn, drawn.pages[0])).toBe(1);
    // Page mode: the page check is the stored report itself (the lettering takes today's path, byte for byte).
    expect(pageSpaceQc(drawn, drawn.pages[0])).toBe(drawn.pages[0].render.qc);
    const doc = kDoc({ square: true, panels: true });
    const page = doc.pages[0];
    expect(letteringAspect(doc, page)).toBeCloseTo(2 / 3, 10);
    expect(composeAspect(doc, { render: page.render })).toBe(1); // without its panels a page is shown as drawn
    // Panels mode: keep-outs and heads move from the square drawing into the frame that shows them.
    const qc = pageSpaceQc(doc, page)!;
    expect(qc.panelBoxes).toEqual(FRAMES);
    expect(qc.keepOut).toHaveLength(1);
    const k = qc.keepOut![0];
    const f2 = FRAMES[1];
    expect(k.panel).toBe(2);
    expect(k.box.x >= f2.x - 1e-9 && k.box.y >= f2.y - 1e-9 && k.box.x + k.box.w <= f2.x + f2.w + 1e-9 && k.box.y + k.box.h <= f2.y + f2.h + 1e-9).toBe(true);
    const aff = frameAffine(doc, page, 'pk_2')!;
    expect(aff.toImage(qc.heads![0].head).x).toBeCloseTo(0.2, 3);
    expect(aff.toImage(qc.heads![0].head).y).toBeCloseTo(0.7, 3);
    // The lettering plans the page on the book aspect without crashing, one plan per line.
    const plans = planLettering(doc, page, letteringAspect(doc, page), estimateMeasure);
    expect(plans.map((p) => p.lineId).sort()).toEqual(['lk_1', 'lk_2', 'lk_3']);
  });

  it("estimateJobs('panel') at Standard = 0.0476 and BYOK = 0.0366 (the page tier one step down, one QC run)", () => {
    expect(estimateJobs([{ kind: 'panel', count: 1 }], 'standard').usd).toBe(0.0476);
    expect(estimateJobs([{ kind: 'panel', count: 1 }], 'standard', { byok: true }).usd).toBe(0.0366);
    expect(resolveImageJob('panel', 'standard')).toMatchObject({ resolution: '1K' });
    expect(resolveImageJob('panel', 'standard').spec.id).toBe(resolveImageJob('page', 'standard').spec.id);
    expect(resolveImageJob('panel', 'draft').resolution).toBe('1K');
    expect(PANEL_RES_STEP).toEqual({ '512': '512', '1K': '1K', '2K': '1K', '4K': '2K' });
    // The lock's model, one step down (Nano Banana Pro: 2K page → 1K panel).
    const lock = { modelId: 'nano-banana-pro', lockedAt: 1, origin: 'first_render' as const };
    expect(resolveImageJob('panel', 'standard', undefined, lock)).toMatchObject({ resolution: '1K' });
    expect(estimateJobs([{ kind: 'panel', count: 2 }], 'standard', { lock, byok: true }).usd).toBe(Math.round((0.1344 + 0.003) * 2 * 10000) / 10000);
    expect(tierPanelPrice('standard')).toBeCloseTo(0.0476, 4);
    // The page quote is unchanged.
    expect(estimateJobs([{ kind: 'page', count: 1 }], 'standard').usd).toBe(Math.round((0.0504 + 0.003) * PLATFORM_MARKUP * 10000) / 10000);
  });

  it('CLIENT_PATCHABLE_OPS ∩ SERVER_ONLY_OPS = ∅, page_panels stays server-only, and every Ship 2 op is known and invertible', () => {
    expect([...CLIENT_PATCHABLE_OPS].filter((op) => SERVER_ONLY_OPS.includes(op))).toEqual([]);
    expect(PRO_PAGE_PATCH_OPS.filter((op) => SERVER_ONLY_OPS.includes(op))).toEqual([]);
    expect(SERVER_ONLY_OPS).toContain('page_panels');
    expect(CLIENT_PATCHABLE_OPS.has('page_panels')).toBe(false);
    expect(PRO_PAGE_PATCH_OPS).not.toContain('page_panels');
    expect([...PRO_PAGE_PATCH_OPS].sort()).toEqual(['consistency', 'continuity', 'finding', 'layer', 'page_cuts', 'page_frames', 'panel_add', 'panel_remove', 'panels_order', 'scene']);
    // K2b flipped it with the server sanitizers (sanitize/panels.ts, sanitize/consistency.ts): one constant.
    expect(PRO_PAGE_OPS_PATCHABLE).toBe(true);
    for (const op of PRO_PAGE_PATCH_OPS) {
      expect(CLIENT_PATCHABLE_OPS.has(op), op).toBe(PRO_PAGE_OPS_PATCHABLE);
      expect(isKnownDocOp({ op }), op).toBe(true);
      expect(INVERTIBLE_OPS.has(op), op).toBe(true);
    }
    expect(describeOps([{ op: 'panels_order', pageId: 'p', order: [] }])).toBe('reorder panels');
    expect(describeOps([{ op: 'layer', pageId: 'p', id: 'ly_a', patch: null }, { op: 'layer', pageId: 'p', id: 'ly_b', patch: null }])).toBe('edit 2 overlays');
    // The editor's selection rides on the focus (ids only).
    const focus: StudioFocus = { pageId: 'pg_k', panelIds: ['pk_2'], layerIds: ['ly_star'] };
    expect(focus.panelIds).toEqual(['pk_2']);
  });

  it('collectAssetPaths includes frame and layer sources (trash included); displayAssetPaths shows live pages only', () => {
    const TAKE = 'u/user-k/p/proj-k/img/p1-take1.webp';
    const STICKER = 'u/user-k/p/proj-k/refs/sticker.webp';
    const GUIDE = 'u/user-k/p/proj-k/refs/guide.webp';
    let doc = kDoc({ panels: true });
    doc = applyOps(doc, [
      { op: 'page_frames', pageId: 'pg_k', frames: [{ panelId: 'pk_2', frame: { box: FRAMES[1], src: { path: TAKE } } }], moveBalloons: false },
      { op: 'layer', pageId: 'pg_k', id: 'ly_sticker', patch: { kind: 'image', box: bx(0.1, 0.1, 0.2, 0.2), src: { path: STICKER } } },
      { op: 'layer', pageId: 'pg_k', id: 'ly_guide', patch: { kind: 'image', box: bx(0.5, 0.1, 0.2, 0.2), src: { path: GUIDE }, print: false } }
    ]);
    expect(pageSourcePaths(doc.pages[0])).toEqual([TAKE, STICKER, GUIDE]);
    expect(pageSourcePaths(doc.pages[0], { printOnly: true })).toEqual([TAKE, STICKER]);
    for (const p of [TAKE, STICKER, GUIDE]) {
      expect(collectAssetPaths(doc), p).toContain(p);
      expect(displayAssetPaths(doc), p).toContain(p);
    }
    const trashed = applyOps(doc, [{ op: 'page_delete', id: 'pg_k', deletedAt: 50 }]);
    expect(trashOf(trashed)).toHaveLength(1);
    for (const p of [TAKE, STICKER, GUIDE]) {
      expect(collectAssetPaths(trashed), p).toContain(p);
      expect(displayAssetPaths(trashed), p).not.toContain(p);
    }
    // Server path rewrites reach them too (and change nothing when nothing moves).
    expect(mapPanelSourcePaths(trashed, (p) => p)).toBe(trashed);
    const rewritten = mapPanelSourcePaths(trashed, (p) => p.replace('proj-k', 'proj-copy'));
    expect(pageSourcePaths(trashOf(rewritten)[0].page).every((p) => p.includes('proj-copy'))).toBe(true);
    // Image filters (a restore leaving out forgotten or blocked images; forgetting a photo, V-4) drop them whole:
    // the frame loses its source, the overlay goes; no dangling path, nothing else touched.
    expect(dropPanelSourcePaths(trashed, () => false)).toBe(trashed);
    for (const d of [doc, trashed]) {
      const out = dropPanelSourcePaths(d, (p) => p === TAKE || p === STICKER);
      const page = out.pages.find((p) => p.id === 'pg_k') ?? trashOf(out)[0].page;
      const was = d.pages.find((p) => p.id === 'pg_k') ?? trashOf(d)[0].page;
      expect(pageSourcePaths(page)).toEqual([GUIDE]);
      expect(collectAssetPaths(out)).not.toContain(TAKE);
      expect(collectAssetPaths(out)).not.toContain(STICKER);
      expect(page.panels[1].frame).toEqual({ box: FRAMES[1] });
      expect(page.layers!.map((l) => l.id)).toEqual(was.layers!.filter((l) => l.id !== 'ly_sticker').map((l) => l.id));
      expect(page.balloons).toBe(was.balloons);
    }
    expect(dropPanelSourcePaths(doc, () => true).pages[0].layers!.map((l) => l.id)).toEqual(['ly_star']);
  });

  it("the versions 'every key assigned' test passes with scenes and consistency (book section; generic extra meta keys)", () => {
    expect(TOP_LEVEL_SECTIONS.scenes).toBe('meta');
    expect(TOP_LEVEL_SECTIONS.consistency).toBe('meta');
    expect(TYPED_META_KEYS).not.toContain('scenes');
    expect(TYPED_META_KEYS).not.toContain('consistency');
    expect(isExtraMetaKey('scenes') && isExtraMetaKey('consistency')).toBe(true);
    const doc = normalizeDoc({ ...historyV5Doc(), scenes: [{ id: 'sc_1', name: 'Market' }], consistency: { maxRefs: 7 } });
    expect(unassignedKeys(doc)).toEqual([]);
    expect(Object.keys(doc).sort()).toEqual(Object.keys(TOP_LEVEL_SECTIONS).sort());
    const s = splitSections(doc);
    expect(s.meta.scenes).toEqual([{ id: 'sc_1', name: 'Market' }]);
    const back = joinSections(s, excludedOf(doc));
    expect([back.scenes, back.consistency]).toEqual([doc.scenes, doc.consistency]);
    expect(diffBooks(doc, applyOps(doc, [{ op: 'scene', id: 'sc_2', patch: { name: 'Rooftops' } }])).meta).toEqual(['scenes']);
  });

  it('I3: cuts, parts and anchorKeys belong to their drawing — a new drawing clears them, history keeps them, switching back restores them', () => {
    expect(VERSION_META_KEYS).toEqual(expect.arrayContaining(['cuts', 'parts', 'anchorKeys']));
    let doc = kDoc({ panels: true });
    const parts = partsOf(doc, doc.pages[0]);
    doc = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_k' }, patch: { parts, anchorKeys: ['char:ch_k'] } }]);
    const meta = { cuts: doc.pages[0].render.cuts, parts, anchorKeys: ['char:ch_k'] };
    // A meta-only patch keeps them.
    const checked = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_k' }, patch: { qc: { score: 1, issues: [], checkedAt: 40 } } }]);
    expect(checked.pages[0].render).toMatchObject(meta);
    const NEW = 'u/user-k/p/proj-k/img/p1-v2.webp';
    const redrawn = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_k' }, patch: { status: 'ready', asset: { path: NEW, source: 'generated', at: 41 } } }]);
    for (const k of ['cuts', 'parts', 'anchorKeys'] as const) expect(redrawn.pages[0].render[k], k).toBeUndefined();
    expect(redrawn.pages[0].render.history[0]).toMatchObject({ path: K_PATH, ...meta });
    const back = applyOps(redrawn, [{ op: 'render_use', target: { kind: 'page', id: 'pg_k' }, path: K_PATH, at: 42 }]);
    expect(back.pages[0].render).toMatchObject({ asset: { path: K_PATH }, ...meta });
    expect(artModeOf(back.pages[0])).toBe('panels');
    // page_cuts is path-guarded and written as the user's; its inverse restores the detector's cuts exactly.
    expect(applyOps(redrawn, [{ op: 'page_cuts', pageId: 'pg_k', path: K_PATH, cuts: CUTS }], 0).pages[0].render.cuts).toBeUndefined();
    const edit: DocOp = { op: 'page_cuts', pageId: 'pg_k', path: K_PATH, cuts: { ...CUTS, by: 'detect', status: 'unsure' } };
    const edited = applyOps(doc, [edit]);
    expect(edited.pages[0].render.cuts).toMatchObject({ by: 'user', status: 'unsure' });
    expect(same(applyOps(edited, inverseOps(doc, [edit])))).toEqual(same(doc));
  });

  it('I5 (property): structural ops re-stamp only a fresh page shown in frames; op then inverse restores the original hash and doc', () => {
    let restamped = 0;
    let stale = 0;
    let flipped = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const doc = panelized(seed);
      const r = rngOf(seed);
      for (const page of doc.pages) {
        if (!page.render.asset || page.panels.length < 2) continue;
        const ids = page.panels.map((p) => p.id);
        const others = ids.slice(1);
        const frameless = page.panels.find((p) => !p.frame);
        const ops: DocOp[] = [
          { op: 'panels_order', pageId: page.id, order: [...ids].reverse() },
          { op: 'panel_remove', pageId: page.id, id: ids[0], ...(r() < 0.5 ? { linesTo: others[0] } : {}) },
          { op: 'panel_add', pageId: page.id, index: 1, panel: { id: `pn_add_${seed}`, n: 0, size: 'small', shot: 'insert', action: 'An insert', castIds: [], lines: page.panels[0].lines.slice(0, 1), frame: { box: bx(0.3, 0.3, 0.3, 0.3) } } },
          // Removing the one frameless panel of an opted-in page brings the page into frames; its undo adds it back.
          ...(frameless ? [{ op: 'panel_remove', pageId: page.id, id: frameless.id } as DocOp] : [])
        ];
        for (const op of ops) {
          const fresh = !!page.render.specHash && page.render.specHash === pageSpecHash(doc, page);
          const after = applyOps(doc, [op], 2);
          if (JSON.stringify(same(after)) === JSON.stringify(same(doc))) continue; // refused (a cap): nothing to check
          const now = after.pages.find((p) => p.id === page.id)!;
          if (op.op === 'panel_remove' && frameless && op.id === frameless.id && page.artMode === 'panels') flipped += 1;
          if (fresh && (artModeOf(page) === 'panels' || artModeOf(now) === 'panels')) {
            expect(now.render.specHash, `${seed} ${op.op}`).toBe(pageSpecHash(after, now));
            restamped += 1;
          } else {
            expect(now.render.specHash, `${seed} ${op.op}`).toBe(page.render.specHash);
            if (!fresh) stale += 1;
          }
          const undone = applyOps(after, inverseOps(doc, [op]), 3);
          expect(undone.pages.find((p) => p.id === page.id)!.render.specHash, `${seed} ${op.op}`).toBe(page.render.specHash);
          expect(same(undone), `${seed} ${op.op}`).toEqual(same(doc));
        }
      }
    }
    expect(restamped).toBeGreaterThan(40);
    expect(stale).toBeGreaterThan(10);
    expect(flipped).toBeGreaterThan(5);
    // A page shown as drawn is never re-stamped: reordering its script panels is a real change (Out of date).
    const drawn = kDoc();
    const moved = applyOps(drawn, [{ op: 'panels_order', pageId: 'pg_k', order: ['pk_2', 'pk_1', 'pk_3'] }]);
    expect(isPageStale(moved, moved.pages[0])).toBe(true);
    const panels = kDoc({ panels: true });
    const reordered = applyOps(panels, [{ op: 'panels_order', pageId: 'pg_k', order: ['pk_2', 'pk_1', 'pk_3'] }]);
    expect(isPageStale(reordered, reordered.pages[0])).toBe(false);
  });

  it('I5/I7: removing the one frameless panel of an opted-in page (it flips to frames) undoes exactly, its lines and lettering included', () => {
    // Opted in, but panel 3 has no frame, so the page is shown as drawn (I2). Removing panel 3 leaves every panel framed.
    const doc = applyOps(kDoc({ panels: true }), [
      { op: 'translation', lang: 'hi', lineId: 'lk_3', patch: { text: 'भागो!', status: 'reviewed', sourceHash: 'h', at: 3 } },
      { op: 'page_frames', pageId: 'pg_k', frames: [{ panelId: 'pk_3', frame: null }] }
    ]);
    expect(artModeOf(doc.pages[0])).toBe('page');
    expect(isPageStale(doc, doc.pages[0])).toBe(false);
    const op: DocOp = { op: 'panel_remove', pageId: 'pg_k', id: 'pk_3' };
    const after = applyOps(doc, [op]);
    expect(after.pages[0].panels.map((p) => p.id)).toEqual(['pk_1', 'pk_2']);
    expect(artModeOf(after.pages[0])).toBe('panels');
    expect(after.pages[0].balloons.some((b) => b.lineId === 'lk_3')).toBe(false);
    expect(after.i18n!.editions.hi.lines.lk_3).toBeUndefined();
    // The inverse (a frameless panel_add on a page now shown in frames) is applied: panel, line, balloon, translation.
    const inverse = inverseOps(doc, [op]);
    const undone = applyOps(after, inverse, 9);
    expect(undone.pages[0].panels.map((p) => p.id)).toEqual(['pk_1', 'pk_2', 'pk_3']);
    expect(undone.pages[0].panels[2].lines.map((l) => l.text)).toEqual(['Run!']);
    expect(undone.pages[0].render.specHash).toBe(doc.pages[0].render.specHash);
    expect(same(undone)).toEqual(same(doc));
    // Client and server agree on the undo (the wire turns undefined into null).
    expect(json(applyOps(json(after), wire(inverse), 9))).toEqual(json(undone));
  });

  it('I6: balloons, clipped overlays and every edition override follow their frame; locked balloons stay; pinned flags unchanged', () => {
    const doc = kDoc({ panels: true });
    const before = doc.pages[0];
    const dx = 0.08;
    const dy = 0.02;
    const op: DocOp = {
      op: 'page_frames',
      pageId: 'pg_k',
      frames: [
        { panelId: 'pk_2', frame: { box: bx(FRAMES[1].x + dx, FRAMES[1].y + dy, FRAMES[1].w - dx, FRAMES[1].h - dy) } },
        { panelId: 'pk_3', frame: { box: bx(FRAMES[2].x, FRAMES[2].y + dy, FRAMES[2].w, FRAMES[2].h - dy) } }
      ]
    };
    const after = applyOps(doc, [op]);
    const page = after.pages[0];
    const b2 = page.balloons.find((b) => b.lineId === 'lk_2')!;
    const was2 = before.balloons.find((b) => b.lineId === 'lk_2')!;
    // The tail tip stays on the same point of the art (through the picture: page → image → page).
    const a0 = frameAffine(doc, before, 'pk_2')!;
    const a1 = frameAffine(after, page, 'pk_2')!;
    const tailArt0 = a0.toImage({ x: was2.tailX!, y: was2.tailY! });
    const tailArt1 = a1.toImage({ x: b2.tailX!, y: b2.tailY! });
    expect(tailArt1.x).toBeCloseTo(tailArt0.x, 3);
    expect(tailArt1.y).toBeCloseTo(tailArt0.y, 3);
    expect(b2.w).toBe(was2.w); // lettering never rescales
    expect(b2.pinned).toBe(true); // flags untouched
    expect(b2.x).not.toBe(was2.x);
    // Locked stays; the untouched panel's balloon stays.
    expect(page.balloons.find((b) => b.lineId === 'lk_3')).toEqual(before.balloons.find((b) => b.lineId === 'lk_3'));
    expect(page.balloons.find((b) => b.lineId === 'lk_1')).toEqual(before.balloons.find((b) => b.lineId === 'lk_1'));
    // The overlay clipped to panel 3 moved with its frame and stays inside it.
    const star = page.layers!.find((l) => l.id === 'ly_star')!;
    expect(star.box.y).toBeGreaterThan(before.layers![0].box.y);
    const f3 = page.panels[2].frame!.box;
    expect(star.box.y >= f3.y && star.box.y + star.box.h <= f3.y + f3.h + 1e-9).toBe(true);
    // The Hindi override of line 2 followed the same mapping as its balloon.
    const ov = after.i18n!.editions.hi.balloons.lk_2;
    expect(a1.toImage({ x: ov.x! + was2.w / 2, y: ov.y! }).x).toBeCloseTo(a0.toImage({ x: 0.12 + was2.w / 2, y: 0.56 }).x, 3);
    // moveBalloons: false moves only the frames.
    const still = applyOps(doc, [{ ...op, moveBalloons: false } as DocOp]);
    expect(still.pages[0].balloons).toEqual(before.balloons);
    expect(still.i18n).toEqual(doc.i18n);
    // The inverse puts everything back exactly (snapshots, not a reverse affine).
    expect(same(applyOps(after, inverseOps(doc, [op])))).toEqual(same(doc));
    // Entering panels mode maps lettering from the drawing into the frames (here a square drawing on a 2:3 book).
    const sq = kDoc({ square: true });
    const entered = applyOps(sq, [{ op: 'page_frames', pageId: 'pg_k', artMode: 'panels', frames: FRAMES.map((box, i) => ({ panelId: `pk_${i + 1}`, frame: { box } })) }]);
    const aff = frameAffine(entered, entered.pages[0], 'pk_2')!;
    const tail = entered.pages[0].balloons.find((b) => b.lineId === 'lk_2')!;
    expect(aff.toImage({ x: tail.tailX!, y: tail.tailY! }).x).toBeCloseTo(0.2, 3);
    expect(aff.toImage({ x: tail.tailX!, y: tail.tailY! }).y).toBeCloseTo(0.8, 3);
  });

  it('I6: page_cuts carries lettering along when new cuts bring the page into frames or change what a frame shows', () => {
    // A square drawing on a 2:3 book with frames, opted in, but a redraw cleared the cuts: shown as drawn (I2).
    const doc = applyOps(kDoc({ square: true }), [
      { op: 'page_cuts', pageId: 'pg_k', path: K_PATH, cuts: null },
      { op: 'page_frames', pageId: 'pg_k', artMode: 'panels', frames: FRAMES.map((box, i) => ({ panelId: `pk_${i + 1}`, frame: { box } })), moveBalloons: false }
    ], 1);
    expect(artModeOf(doc.pages[0])).toBe('page');
    const before = doc.pages[0];
    const was2 = before.balloons.find((b) => b.lineId === 'lk_2')!;
    const enter: DocOp = { op: 'page_cuts', pageId: 'pg_k', path: K_PATH, cuts: CUTS };
    const after = applyOps(doc, [enter], 2);
    const page = after.pages[0];
    expect(artModeOf(page)).toBe('panels');
    // The tail stays on its point of the drawing (0.2, 0.8), as when page_frames enters frames.
    const aff = frameAffine(after, page, 'pk_2')!;
    const b2 = page.balloons.find((b) => b.lineId === 'lk_2')!;
    expect(aff.toImage({ x: b2.tailX!, y: b2.tailY! }).x).toBeCloseTo(0.2, 3);
    expect(aff.toImage({ x: b2.tailX!, y: b2.tailY! }).y).toBeCloseTo(0.8, 3);
    expect(b2.w).toBe(was2.w);
    expect(b2.pinned).toBe(true);
    expect(page.balloons.find((b) => b.lineId === 'lk_3')).toEqual(before.balloons.find((b) => b.lineId === 'lk_3')); // locked
    // The Hindi override followed with it; the overlay clipped to panel 3 moved into its frame.
    const ov = after.i18n!.editions.hi.balloons.lk_2;
    expect(aff.toImage({ x: ov.x! + was2.w / 2, y: ov.y! }).x).toBeCloseTo(0.12 + was2.w / 2, 3);
    expect(page.layers![0].box).not.toEqual(before.layers![0].box);
    // History names every section the move touched.
    const a = sectionSignatures(doc);
    const b = sectionSignatures(after);
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
    for (const k of changed) expect(touchedKeys(enter, doc), k).toContain(k);
    // The inverse restores the cuts it replaced and the lettering exactly; client and server agree.
    const inverse = inverseOps(doc, [enter]);
    const undone = applyOps(after, inverse, 3);
    expect(same(undone)).toEqual(same(doc));
    expect(json(applyOps(json(after), wire(inverse), 3))).toEqual(json(undone));
    // moveBalloons: false moves only the cuts.
    const still = applyOps(doc, [{ ...enter, moveBalloons: false } as DocOp], 2);
    expect(still.pages[0].balloons).toEqual(before.balloons);
    expect(still.i18n).toEqual(doc.i18n);
    expect(touchedKeys({ ...enter, moveBalloons: false } as DocOp, doc)).toEqual(['art:pg_k']);
    // Staying in frames, a moved cut changes what panel 2 shows: its balloon stays on the same point of the art.
    const framed = kDoc({ panels: true });
    const shifted: DocOp = { op: 'page_cuts', pageId: 'pg_k', path: K_PATH, cuts: { ...CUTS, cuts: CUTS.cuts.map((c, i) => (i === 1 ? { ...c, box: { ...c.box, y: c.box.y - 0.05 } } : c)) } };
    const moved = applyOps(framed, [shifted], 2);
    const f0 = framed.pages[0].balloons.find((x) => x.lineId === 'lk_2')!;
    const f1 = moved.pages[0].balloons.find((x) => x.lineId === 'lk_2')!;
    const a0 = frameAffine(framed, framed.pages[0], 'pk_2')!.toImage({ x: f0.tailX!, y: f0.tailY! });
    const a1 = frameAffine(moved, moved.pages[0], 'pk_2')!.toImage({ x: f1.tailX!, y: f1.tailY! });
    expect(f1.tailY).not.toBe(f0.tailY);
    expect(a1.x).toBeCloseTo(a0.x, 3);
    expect(a1.y).toBeCloseTo(a0.y, 3);
    expect(moved.pages[0].balloons.find((x) => x.lineId === 'lk_1')).toEqual(framed.pages[0].balloons.find((x) => x.lineId === 'lk_1')); // its cut did not move
    expect(same(applyOps(moved, inverseOps(framed, [shifted]), 3))).toEqual(same(framed));
  });

  it('I7 (property): applyOps gives deep-equal docs on client and server for Ship 2 sequences, and every inverse undoes them exactly', () => {
    let effective = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 80; seed += 1) {
      const doc = panelized(seed);
      const r = rngOf(seed * 7919);
      const ops: DocOp[] = [];
      let cur = doc;
      for (let i = 0; i < 1 + Math.floor(r() * 8); i += 1) {
        const op = k2Op(cur, r, i);
        ops.push(op);
        const next = applyOps(cur, [op], 2);
        if (JSON.stringify(same(next)) !== JSON.stringify(same(cur))) {
          effective += 1;
          kinds.add(op.op);
        }
        cur = next;
      }
      // Server applies the ops as built; the client applies what the wire delivers (undefined → null).
      const server = applyOps(doc, ops, 9);
      const client = applyOps(json(doc), wire(ops), 9);
      expect(json(client), `seed ${seed}`).toEqual(json(server));
      const inverse = inverseOps(doc, ops);
      for (const op of inverse) expect(INVERTIBLE_OPS.has(op.op), op.op).toBe(true);
      const undoneServer = applyOps(server, inverse, 10);
      const undoneClient = applyOps(client, wire(inverse), 10);
      expect(json(undoneClient), `seed ${seed}`).toEqual(json(undoneServer));
      if (JSON.stringify(same(undoneServer)) !== JSON.stringify(same(doc))) expect({ seed, ops, inverse, got: same(undoneServer) }).toEqual({ seed, ops, inverse, got: same(doc) });
    }
    expect(effective).toBeGreaterThan(150);
    expect([...PRO_PAGE_PATCH_OPS].filter((k) => !kinds.has(k))).toEqual([]);
    // Deterministic wire cases: a key present as undefined on the server arrives as null, and both clear it.
    const base = applyOps(kDoc({ panels: true }), [
      { op: 'page_frames', pageId: 'pg_k', frameStyle: { gutter: 0.05 } },
      { op: 'layer', pageId: 'pg_k', id: 'ly_star', patch: { opacity: 0.4 } },
      { op: 'continuity', pageId: 'pg_k', patch: { notes: ['rain stops'] } },
      { op: 'scene', id: 'sc_k', patch: { name: 'Market', light: 'dawn' } },
      { op: 'consistency', patch: { maxRefs: 6 } }
    ]);
    const tricky: DocOp[] = [
      { op: 'page_frames', pageId: 'pg_k', frameStyle: undefined },
      { op: 'layer', pageId: 'pg_k', id: 'ly_star', patch: { opacity: undefined, z: 3 } },
      { op: 'scene', id: 'sc_k', patch: { light: undefined } },
      { op: 'consistency', patch: { maxRefs: undefined } },
      { op: 'continuity', pageId: 'pg_k', patch: undefined as never },
      { op: 'page_frames', pageId: 'pg_k', artMode: undefined },
      { op: 'page_cuts', pageId: 'pg_k', path: K_PATH, cuts: undefined as never }
    ];
    const server = applyOps(base, tricky, 9);
    expect(json(applyOps(json(base), wire(tricky), 9))).toEqual(json(server));
    expect([server.pages[0].frameStyle, server.pages[0].layers![0].opacity, server.scenes![0].light, server.consistency, server.pages[0].continuity, server.pages[0].artMode, server.pages[0].render.cuts]).toEqual(Array(7).fill(undefined));
  });

  it('tolerance: missing pages, wrong paths, broken caps and malformed payloads are no-ops (the same doc)', () => {
    const doc = kDoc({ panels: true });
    const noops: DocOp[] = [
      { op: 'page_frames', pageId: 'ghost', artMode: 'panels' },
      { op: 'page_frames', pageId: 'pg_k', frames: 'nope' as never },
      { op: 'page_cuts', pageId: 'pg_k', path: 'u/another.webp', cuts: CUTS },
      { op: 'panels_order', pageId: 'pg_k', order: ['pk_1', 'pk_2', 'pk_3'] },
      { op: 'panel_add', pageId: 'pg_k', panel: { id: 'pk_1', n: 0, size: 'small', shot: 'insert', action: '', castIds: [], lines: [] } },
      { op: 'panel_remove', pageId: 'pg_k', id: 'pk_1', linesTo: 'pk_ghost' },
      { op: 'layer', pageId: 'pg_k', id: 'not-a-layer-id', patch: { kind: 'shape', box: bx(0, 0, 0.1, 0.1), shape: { type: 'rect' } } },
      { op: 'layer', pageId: 'pg_k', id: 'ly_new', patch: { kind: 'image', box: bx(0, 0, 0.1, 0.1) } },
      { op: 'continuity', pageId: 'pg_k', patch: null },
      { op: 'scene', id: 'sc_ghost', patch: null },
      { op: 'consistency', patch: { maxRefs: null } },
      { op: 'finding', pageId: 'pg_k', id: 'f_ghost', patch: { dismissed: true } }
    ];
    for (const op of noops) expect(applyOps(doc, [op], 1).pages, op.op).toBe(doc.pages);
    // A panel without a frame is not refused on a page shown in frames: it shows the page as drawn again (I2), and its
    // removal brings the frames back (this pair is how undo restores a removed frameless panel).
    const bare: DocOp = { op: 'panel_add', pageId: 'pg_k', panel: { id: 'pk_new', n: 0, size: 'small', shot: 'insert', action: '', castIds: [], lines: [] } };
    const added = applyOps(doc, [bare], 1);
    expect(added.pages[0].panels.map((p) => p.id)).toEqual(['pk_1', 'pk_2', 'pk_3', 'pk_new']);
    expect(added.pages[0].panels[3].frame).toBeUndefined();
    expect(artModeOf(added.pages[0])).toBe('page');
    expect(artModeOf(applyOps(added, [{ op: 'panel_remove', pageId: 'pg_k', id: 'pk_new' }], 1).pages[0])).toBe('panels');
    // ≤ 2 extra picture sources per page.
    const three = applyOps(doc, [{ op: 'page_frames', pageId: 'pg_k', frames: FRAMES.map((box, i) => ({ panelId: `pk_${i + 1}`, frame: { box, src: { path: `u/take${i}.webp` } } })) }], 1);
    expect(three.pages).toBe(applyOps(doc, [], 1).pages);
    // The generic page and panel ops never write frames or page objects (their own ops do, so lettering follows).
    const sneaky = applyOps(doc, [
      { op: 'page', id: 'pg_k', patch: { summary: 'S', artMode: undefined, layers: [] } as never },
      { op: 'panel', pageId: 'pg_k', id: 'pk_1', patch: { frame: { box: bx(0, 0, 1, 1) }, direction: { lens: 'macro', by: 'user' } } }
    ]);
    expect(sneaky.pages[0].summary).toBe('S');
    expect(sneaky.pages[0].artMode).toBe('panels');
    expect(sneaky.pages[0].layers).toEqual(doc.pages[0].layers);
    expect(sneaky.pages[0].panels[0].frame).toEqual(doc.pages[0].panels[0].frame);
    expect(sneaky.pages[0].panels[0].direction).toEqual({ lens: 'macro', by: 'user' });
  });

  it('page_duplicate carries frames, overlays, cuts and parts onto the copy with its new panel ids', () => {
    const doc = kDoc({ panels: true });
    const withParts = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_k' }, patch: { parts: partsOf(doc, doc.pages[0]) } }]);
    const dup = applyOps(withParts, [{ op: 'page_duplicate', id: 'pg_k', newId: 'pg_d' }]);
    const copy = dup.pages.find((p) => p.id === 'pg_d')!;
    expect(copy.panels.map((p) => p.id)).toEqual(['pg_d_p0', 'pg_d_p1', 'pg_d_p2']);
    expect(copy.layers![0].clip).toBe('pg_d_p2');
    expect(copy.render.cuts!.cuts.map((c) => c.panelId)).toEqual(['pg_d_p0', 'pg_d_p1', 'pg_d_p2']);
    expect(Object.keys(copy.render.parts!.panels!)).toEqual(['pg_d_p0', 'pg_d_p1', 'pg_d_p2']);
    expect(artModeOf(copy)).toBe('panels');
  });

  it('history: Ship 2 ops touch the right sections, have the right actor and read in plain words', () => {
    const doc = normalizeDoc(historyV5Doc());
    const p2 = doc.pages[1];
    expect(touchedKeys({ op: 'page_frames', pageId: p2.id, artMode: 'panels' }, doc)).toEqual(expect.arrayContaining([`page:${p2.id}`, `art:${p2.id}`]));
    expect(touchedKeys({ op: 'page_cuts', pageId: p2.id, path: 'x', cuts: null })).toEqual([`art:${p2.id}`, `page:${p2.id}`]);
    expect(touchedKeys({ op: 'page_cuts', pageId: p2.id, path: 'x', cuts: null, moveBalloons: false })).toEqual([`art:${p2.id}`]);
    expect(touchedKeys({ op: 'finding', pageId: p2.id, id: 'f', patch: { dismissed: true } })).toEqual([`art:${p2.id}`]);
    expect(touchedKeys({ op: 'layer', pageId: p2.id, id: 'ly_a', patch: null })).toEqual([`page:${p2.id}`]);
    expect(touchedKeys({ op: 'continuity', pageId: p2.id, patch: null })).toEqual([`page:${p2.id}`]);
    expect(touchedKeys({ op: 'panels_order', pageId: p2.id, order: [] })).toEqual([`art:${p2.id}`, `page:${p2.id}`]);
    expect(touchedKeys({ op: 'scene', id: 'sc', patch: null })).toEqual(['meta']);
    expect(touchedKeys({ op: 'consistency', patch: {} })).toEqual(['meta']);
    // Actors: the user's own edits are 'you'; free software actions the editor; paid panel work the AI.
    const frames: DocOp = { op: 'page_frames', pageId: p2.id, artMode: 'panels' };
    expect(opActor(frames, 'user', doc)).toBe('you');
    expect(opActor(frames, 'job', doc)).toBe('editor');
    expect(opActor({ op: 'page_panels', id: p2.id, panels: p2.panels }, 'job', doc)).toBe('ai'); // the writer, as before
    for (const a of EDITOR_ACTIONS) expect(opActor({ op: 'page_panels', id: p2.id, panels: p2.panels }, 'job', doc, a), a).toBe('editor');
    for (const a of AI_ACTIONS) expect(opActor({ op: 'render', target: { kind: 'page', id: p2.id }, patch: {} }, 'job', doc, a), a).toBe('ai');
    expect(opActor({ op: 'message', msg: { id: 'm', role: 'user', text: 'x', at: 1 } }, 'job', doc, 'panelize_page')).toBeNull();
    // Words (pro plan §5.6).
    const you = panelMomentsOfOps([{ op: 'panels_order', pageId: p2.id, order: [] }], 'you', doc);
    expect(describeChanges(you, 'edits')).toBe('You rearranged the panels on page 2');
    const editable = panelMomentsOfOps([frames, { op: 'page_cuts', pageId: p2.id, path: 'x', cuts: null }], 'editor', doc, 'panelize_page');
    expect(describeChanges(editable, 'edits')).toBe("The editor made page 2's panels editable (no AI cost)");
    const fix = panelMomentsOfOps([{ op: 'render', target: { kind: 'page', id: p2.id }, patch: {} }], 'ai', doc, { type: 'fix_panel', pageId: p2.id, panelId: p2.panels[2].id, mode: 'redraw' });
    expect(describeChanges(fix, 'ai')).toBe('AI redrew panel 3 on page 2');
    expect(describeChanges(fix, 'before_ai')).toBe('Before the AI redrew panel 3 on page 2');
    const rebind = panelMomentsOfOps([{ op: 'page_panels', id: doc.pages[0].id, panels: doc.pages[0].panels }], 'editor', doc, 'rebind_panels');
    expect(describeChanges(rebind, 'edits')).toBe("Matched page 1's script to its art (free)");
    expect(describeChanges(panelMomentsOfOps([{ op: 'scene', id: 'sc', patch: { name: 'S' } }], 'you', doc), 'edits')).toBe('You updated the scenes');
    // Dismissing a check and bringing one back read differently; "Show as drawn" is named as such.
    const finding = (dismissed: boolean | null): DocOp => ({ op: 'finding', pageId: p2.id, id: 'f', patch: { dismissed } });
    expect(describeChanges(panelMomentsOfOps([finding(true)], 'you', doc), 'edits')).toBe('You dismissed a check on page 2');
    expect(describeChanges(panelMomentsOfOps([finding(null)], 'you', doc), 'edits')).toBe('You brought back a check on page 2');
    expect(describeChanges(panelMomentsOfOps([finding(false)], 'you', doc), 'edits')).toBe('You brought back a check on page 2');
    expect(describeChanges(panelMomentsOfOps([{ op: 'page_frames', pageId: p2.id, artMode: null }], 'you', doc), 'edits')).toBe('You showed page 2 as drawn');
    expect(describeChanges(panelMomentsOfOps([{ op: 'page_frames', pageId: p2.id, artMode: undefined }], 'you', doc), 'edits')).toBe('You showed page 2 as drawn');
    expect(describeChanges(panelMomentsOfOps([{ op: 'page_frames', pageId: p2.id, artMode: null, frames: [{ panelId: p2.panels[0].id, frame: null }] }], 'you', doc), 'edits')).toBe(
      'You rearranged the panels on page 2'
    );
    expect(describeOps([finding(true)])).toBe('change a check');
    expect(describeOps([finding(null), { ...finding(true), id: 'g' } as DocOp])).toBe('change 2 checks');
    // The moments stand in for the diff's page items; a dialogue edit in the same row is still named.
    const merged = withPanelMoments(
      [
        { what: 'panels', by: 'you', key: `page:${p2.id}`, pageIds: [p2.id], pageNs: [2] },
        { what: 'art', by: 'you', key: `art:${p2.id}`, pageIds: [p2.id], pageNs: [2] },
        { what: 'dialogue', by: 'you', key: `page:${doc.pages[2].id}`, pageIds: [doc.pages[2].id], pageNs: [3] }
      ],
      you
    );
    expect(describeChanges(merged, 'edits')).toBe('You rearranged the panels on page 2 and edited dialogue on page 3');
    // Existing labels are unchanged.
    expect(describeChanges([{ what: 'balloons', by: 'editor', pageNs: [2] }], 'edits')).toBe('The editor re-fitted balloons on page 2, no AI cost');
    for (const label of [you, editable, fix, rebind].map((l) => describeChanges(l, 'edits'))) expect(label).not.toMatch(/\b(branch|merge|commit|checkout|fork|HEAD|diff|rebase|revert)\b/i);
  });

  it('consistency.maxRefs can reach every reference slot of every registered model (the lock caps the real call)', () => {
    const most = Math.max(...IMAGE_MODELS.map((m) => m.refs.total));
    expect(PRO_PAGE_LIMITS.maxRefsMax).toBeGreaterThanOrEqual(most);
    expect(normalizeConsistencySettings({ maxRefs: most })).toEqual({ maxRefs: most });
  });

  it('limits are the plan §5.5 values, one constant each', () => {
    expect(EDITOR_LIMITS).toEqual({
      layersPerPage: 24, sourcesPerPage: 2, frameMin: 0.04, fitZoomMax: 4, maxCuts: 12, balloonRot: 45, layerRot: 180, minHMax: 0.6,
      outboxOpsMax: 2000, outboxDays: 7, undoPersistMax: 100, detectConfOk: 0.85, upscaleSoft: 1.5, upscaleBad: 2.0
    });
    expect(CONSISTENCY_LIMITS).toEqual({
      scenes: 60, castChanges: 12, propChanges: 8, notes: 3, directionBackground: 4, findings: 16, partsKeys: 80, anchorKeys: 16,
      placeAnchors: 2, propAnchors: 2, maxRefsDefault: 9, promptChars: 9000, recurringPages: 2, recurringPanels: 3
    });
  });
});
