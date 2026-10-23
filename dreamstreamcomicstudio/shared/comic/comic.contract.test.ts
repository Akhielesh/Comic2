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
import { applyOps, isSpendAction, CLIENT_PATCHABLE_OPS } from './ops';
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

describe('v5 §16.1 hash invariance (R2)', () => {
  it('pins the sample fixture hashes (captured at HEAD before v5)', () => {
    const overlay = makeSampleDoc();
    expect(overlay.pages.map((p) => pageSpecHash(overlay, p))).toEqual(Array(6).fill('65e6794f'));
    const inArt = inArtSample();
    expect(inArt.pages.map((p) => pageSpecHash(inArt, p))).toEqual(['5e8d87fe', 'ae4db5c3', 'bc65b954', '365ca7d9', '44c4315a', 'f1f9b257']);
    // …and after normalizeDoc (the load path) the hashes are still identical.
    const norm = normalizeDoc(inArtSample());
    expect(norm.pages.map((p) => pageSpecHash(norm, p))).toEqual(['5e8d87fe', 'ae4db5c3', 'bc65b954', '365ca7d9', '44c4315a', 'f1f9b257']);
  });

  it('(a) owner live doc and (b) in_art 6-page speakers fixture: legacy hash === v5 hash after normalizeDoc', () => {
    for (const raw of [ownerLiveDoc(), inArtSample(), makeSampleDoc()]) {
      const legacy = raw.pages.map((p) => legacyPageSpecHash(raw, p));
      const doc = normalizeDoc(JSON.parse(JSON.stringify(raw)));
      expect(doc.pages.map((p) => pageSpecHash(doc, p))).toEqual(legacy);
    }
    const live = normalizeDoc(ownerLiveDoc());
    expect(isPageStale(live, live.pages[0])).toBe(false);
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
    for (const op of ['pages', 'page_panels', 'style_option', 'style_options_clear', 'render', 'asset_meta', 'translations', 'message', 'message_patch', 'spend', 'gate', 'memory', 'safety', 'publication', 'plan_input_hash'] as const) {
      expect(CLIENT_PATCHABLE_OPS.has(op), op).toBe(false);
      expect(SERVER_ONLY_OPS).toContain(op);
    }
    expect(CLIENT_PATCHABLE_OPS.size).toBe(17 + 21);
  });

  it('spend and non-spend action types are disjoint and cover every StudioAction type', () => {
    for (const t of SPEND_ACTION_TYPES) expect(NON_SPEND_ACTION_TYPES.has(t)).toBe(false);
    const all: Record<StudioAction['type'], true> = {
      render_style_options: true, render_sheets: true, render_pages: true, edit_page: true, render_cover: true, translate: true, recheck_page: true,
      approve_gate: true, decline_gate: true, pick_style: true, plan_pages: true, approve_plan: true, patch: true, restore_render: true,
      relayout_balloons: true, cancel: true, fit_render: true, show_breakdown: true, use_preset: true, ref_crop: true, publish: true,
      update_publication: true, unpublish: true, regenerate_link: true, decline_publish: true, safety_recheck: true,
      swap_source_language: true, accept_translation_issue: true, library_save: true, library_use: true, import_classic_cast: true
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
