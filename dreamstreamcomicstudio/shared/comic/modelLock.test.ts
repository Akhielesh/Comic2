// M0-CONTRACT (models.md §3.3 / §5.1): the model lock, the registry changes, the server-only op and the
// SpendEntry / Spend running totals. Every case here fails without its code (the module, the op, the fields).

import { describe, expect, it } from 'vitest';
import {
  createEmptyDoc,
  isValidNextStep,
  normalizeDoc,
  normalizeImageModelLock,
  normalizeOutageCard,
  type Card,
  type ComicDoc,
  type ImageModelLock,
  type Msg,
  type SpendEntry
} from './doc';
import { CLIENT_PATCHABLE_OPS, NON_SPEND_ACTION_TYPES, SERVER_ONLY_OPS, SPEND_ACTION_TYPES, applyOp, applyOps, spendTotalsFromEntries, type DocOp, type StudioAction } from './ops';
import { encodeStudioEvent } from './events';
import { isUndoable } from './undo';
import { DOC_LIMITS, MAX_SPEND_ENTRIES } from './limits';
import { DEFAULT_CAPS, resolveStudioCaps } from './capabilities';
import { IMAGE_MODELS, PRO_TIER_4K, STYLE_OPTION_MODEL, TIER_PRESETS, estimateJobs, getImageModel, nearestResolution, pickableImageModels, resolveImageJob, tierPresetsFor, type ImageJobKind } from './models';
import { deriveLock, drawnModels, drawnTargets, lockedModelId, modelFit, modelFitById, redrawQuote, type PriceBook } from './modelLock';
import { LAKE_MODEL, LAKE_NOW, makeLakeComic } from './__fixtures__/lakeComic';

const KINDS: ImageJobKind[] = ['style_option', 'sheet', 'place', 'page', 'edit', 'cover'];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('deriveLock (migration: existing comics keep their model)', () => {
  it('no generated assets → undefined (the comic locks at its first image)', () => {
    expect(deriveLock(createEmptyDoc('d', 'Empty', 1))).toBeUndefined();
    const uploadsOnly = makeLakeComic((d) => {
      for (const p of d.pages) p.render.asset!.source = 'upload';
      for (const c of d.cast) c.sheet.asset!.source = 'upload';
      d.cover.render.asset!.source = 'upload';
    });
    expect(deriveLock(uploadsOnly)).toBeUndefined();
    expect(lockedModelId(uploadsOnly)).toBeUndefined();
  });

  it('Nano Banana 2.1 assets → a migrated lock dated at the latest page', () => {
    const doc = makeLakeComic();
    expect(deriveLock(doc)).toEqual({ modelId: LAKE_MODEL, lockedAt: LAKE_NOW - 1_600_000, origin: 'migrated' });
    expect(lockedModelId(doc)).toBe(LAKE_MODEL);
    expect('imageModel' in doc).toBe(false); // reads never write
  });

  it('an override that some asset used wins; otherwise the most recently rendered page; else the latest asset', () => {
    const mixed = makeLakeComic((d) => {
      d.pages[4].render.asset!.model = 'nano-banana-pro'; // latest page is on Pro
      d.cast[0].sheet.asset!.model = 'flux-3';
    });
    expect(deriveLock(mixed)?.modelId).toBe('nano-banana-pro');
    expect(deriveLock(makeLakeComic((d) => { d.settings.imageModelOverride = 'nano-banana-pro'; d.pages[1].render.asset!.model = 'nano-banana-pro'; }))).toMatchObject({ modelId: 'nano-banana-pro', origin: 'migrated' });
    // An override nothing was drawn with is ignored (it is a pre-lock preference, not a drawing).
    expect(deriveLock(makeLakeComic((d) => { d.settings.imageModelOverride = 'nano-banana-pro'; }))?.modelId).toBe(LAKE_MODEL);
    // No pages drawn: the latest sheet/cover decides.
    const sheetsOnly = makeLakeComic((d) => {
      for (const p of d.pages) p.render = { status: 'none', history: [] };
      d.cover.render = { status: 'none', history: [] };
      d.cast[3].sheet.asset!.model = 'nano-banana-pro';
    });
    expect(deriveLock(sheetsOnly)).toEqual({ modelId: 'nano-banana-pro', lockedAt: LAKE_NOW - 2_600_000, origin: 'migrated' });
    expect(drawnModels(mixed)).toEqual([{ modelId: LAKE_MODEL, images: 8 }, { modelId: 'flux-3', images: 1 }, { modelId: 'nano-banana-pro', images: 1 }]);
  });

  it('a persisted lock is returned as is, even when the registry no longer knows the id', () => {
    const lock: ImageModelLock = { modelId: 'retired-model', lockedAt: 5, origin: 'first_render' };
    const doc = makeLakeComic((d) => { d.imageModel = lock; });
    expect(deriveLock(doc)).toBe(lock);
    expect(lockedModelId(doc)).toBe('retired-model');
  });

  it('drawnTargets counts generated current images only — the render status is not a filter', () => {
    expect(drawnTargets(makeLakeComic())).toEqual({ pages: ['pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5'], sheets: ['c_baby', 'c_ducks', 'c_frog', 'c_bunny'], places: [], cover: true });
    const partial = makeLakeComic((d) => {
      d.pages[0].render.asset!.source = 'upload';
      // A re-render that failed (429) keeps the previous generated asset: the cover is still drawn on the old model.
      d.cover.render.status = 'failed';
      d.cover.render.error = 'rate limited';
      d.pages[2].render.status = 'rendering';
    });
    expect(drawnTargets(partial)).toMatchObject({ pages: ['pg_2', 'pg_3', 'pg_4', 'pg_5'], cover: true });
    // Only a target with no generated asset at all is not drawn.
    const gone = makeLakeComic((d) => {
      d.cover.render = { status: 'failed', error: 'rate limited', history: [] };
      d.pages[1].render = { status: 'none', history: [] };
    });
    expect(drawnTargets(gone)).toMatchObject({ pages: ['pg_1', 'pg_3', 'pg_4', 'pg_5'], cover: false });
  });
});

describe('resolveImageJob with a lock', () => {
  const lock: ImageModelLock = { modelId: 'nano-banana-pro', lockedAt: 1, origin: 'first_render' };

  it('every kind, style_option included, returns the locked spec; the tier only changes the resolution', () => {
    for (const kind of KINDS) {
      expect(resolveImageJob(kind, 'draft', 'flux-3', lock).spec.id, kind).toBe('nano-banana-pro');
      expect(resolveImageJob(kind, 'standard', undefined, lock).spec.id, kind).toBe('nano-banana-pro');
    }
    expect(resolveImageJob('page', 'draft', undefined, lock).resolution).toBe('1K');
    expect(resolveImageJob('page', 'standard', undefined, lock).resolution).toBe('2K');
    expect(resolveImageJob('style_option', 'pro', undefined, lock).resolution).toBe('1K'); // swatches stay cheap
    expect(resolveImageJob('cover', 'standard', undefined, lock).resolution).toBe('2K');
    // The locked model's own sizes bound the snap (legacy has none → the request is unchanged).
    expect(resolveImageJob('page', 'pro', undefined, { modelId: 'nano-banana-lite', lockedAt: 1, origin: 'migrated' }).resolution).toBe('1K');
  });

  it('without a lock the old behaviour holds (swatches on the everyday model, override honoured)', () => {
    expect(resolveImageJob('style_option', 'pro').spec.id).toBe(STYLE_OPTION_MODEL);
    expect(resolveImageJob('page', 'standard', 'nano-banana-pro').spec.id).toBe('nano-banana-pro');
    expect(resolveImageJob('page', 'standard', 'nano-banana-pro', undefined).spec.id).toBe('nano-banana-pro');
  });

  it('an unknown locked id never resolves to a replacement: it falls through for the server invariant to refuse', () => {
    const job = resolveImageJob('page', 'standard', undefined, { modelId: 'gone-model', lockedAt: 1, origin: 'migrated' });
    expect(job.spec.id).toBe(TIER_PRESETS.standard.model); // ≠ 'gone-model' → jobs.ts throws MODEL_LOCKED before any call
  });

  it('estimateJobs quotes the locked model', () => {
    const est = estimateJobs([{ kind: 'page', count: 2 }], 'draft', { byok: true, lock });
    expect(est.model).toBe('Nano Banana Pro');
    expect(est.usd).toBeCloseTo((0.1344 + 0.003) * 2, 4); // the Google list figure, unrounded (never under-quotes)
  });
});

describe('redrawQuote (models.md §3.5 example 1, the owner comic f8312c86 with an injected PriceBook)', () => {
  const prices: PriceBook = {
    unit: (modelId, res) => (modelId === 'nano-banana-pro' && res === '1K' ? { usd: 0.1344, basis: 'Google price list, 2026-10-22' } : { usd: null, basis: 'no price' }),
    qcUsd: 0.0049 // observed median, n = 7
  };

  it('pages + cover = $0.8309 and everything = $1.3685 (BYOK, 4 refs not counted in the M0 fixture)', () => {
    const doc = makeLakeComic();
    const pagesCover = redrawQuote(doc, 'nano-banana-pro', 'pages_cover', prices, true);
    expect(pagesCover.usd).toBeCloseTo(0.8309, 4);
    expect(pagesCover.lines).toEqual([
      { label: 'Pages', count: 5, usd: 0.6965 },
      { label: 'Cover', count: 1, usd: 0.1344 }
    ]);
    expect(pagesCover.basis).toEqual(['Google price list, 2026-10-22']);
    const all = redrawQuote(doc, 'nano-banana-pro', 'all', prices, true);
    expect(all.usd).toBeCloseTo(1.3685, 4);
    expect(all.lines.map((l) => l.label)).toEqual(['Pages', 'Cover', 'Character sheets']); // no places drawn → no line
    expect(all.lines[2]).toEqual({ label: 'Character sheets', count: 4, usd: 0.5376 });
  });

  it('platform-paid quotes carry the markup ($1.08 / $1.78); scope none is free', () => {
    const doc = makeLakeComic();
    expect(redrawQuote(doc, 'nano-banana-pro', 'pages_cover', prices, false).usd).toBeCloseTo(1.08, 2);
    expect(redrawQuote(doc, 'nano-banana-pro', 'all', prices, false).usd).toBeCloseTo(1.78, 2);
    expect(redrawQuote(doc, 'nano-banana-pro', 'none', prices, false)).toEqual({ usd: 0, lines: [], basis: [] });
  });

  it('a page whose last redraw failed still carries its image and is quoted (never under-quotes)', () => {
    const doc = makeLakeComic((d) => {
      d.pages[1].render.status = 'failed';
      d.pages[1].render.error = 'rate limited';
      d.cover.render.status = 'failed';
    });
    const q = redrawQuote(doc, 'nano-banana-pro', 'pages_cover', prices, true);
    expect(q.lines).toEqual([
      { label: 'Pages', count: 5, usd: 0.6965 },
      { label: 'Cover', count: 1, usd: 0.1344 }
    ]);
    expect(q.usd).toBeCloseTo(0.8309, 4);
  });

  it('any unit without a price makes the total null (never a guessed number)', () => {
    const q = redrawQuote(makeLakeComic(), 'gpt-image-2.5', 'pages_cover', prices, true);
    expect(q.usd).toBeNull();
    expect(q.lines).toEqual([
      { label: 'Pages', count: 5, usd: null },
      { label: 'Cover', count: 1, usd: null }
    ]);
    expect(q.basis).toEqual(['no price']);
  });
});

describe('modelFit', () => {
  const codes = (list: ReturnType<typeof modelFit>, severity?: 'block' | 'warn') => list.filter((r) => !severity || r.severity === severity).map((r) => r.code);
  const paid = resolveStudioCaps({ planId: 'creator', byok: false, isAdmin: false });

  it('GPT Image 2.5 on a 4:5 comic → block aspect with the exact copy', () => {
    const fit = modelFit(getImageModel('gpt-image-2.5')!, makeLakeComic(), paid);
    expect(fit.find((r) => r.code === 'aspect')).toEqual({ code: 'aspect', severity: 'block', text: "Can't draw 4:5 pages" });
    expect(codes(fit, 'block')).toContain('hidden'); // not pickable until D2
    expect(fit.findIndex((r) => r.severity === 'warn')).toBeGreaterThan(fit.findIndex((r) => r.severity === 'block')); // blocks first
  });

  it('Nano Banana 2.1 with 5 cast members on a page → warn characters (not a block)', () => {
    const doc = makeLakeComic((d) => {
      d.cast.push({ id: 'c_turtle', name: 'Turtle', tier: 'support', look: { summary: 'A turtle' }, refs: [], sheet: { status: 'none', history: [] } });
      d.pages[4].panels[0].castIds = ['c_baby', 'c_ducks', 'c_frog', 'c_bunny', 'c_turtle'];
    });
    const fit = modelFit(getImageModel(LAKE_MODEL)!, doc, paid);
    expect(fit).toContainEqual({ code: 'characters', severity: 'warn', text: 'Nano Banana 2.1 holds up to 4 characters per image; page 5 has 5.' });
    expect(codes(fit, 'block')).toEqual([]);
    expect(codes(modelFit(getImageModel('nano-banana-pro')!, doc, paid))).not.toContain('characters'); // Pro holds 5
  });

  it('a free-plan caps fixture with Nano Banana Pro → block access; a key or a paid plan lifts it', () => {
    const doc = makeLakeComic();
    expect(modelFit(getImageModel('nano-banana-pro')!, doc, DEFAULT_CAPS)).toContainEqual({ code: 'access', severity: 'block', text: 'Needs a paid plan or your own key' });
    expect(codes(modelFit(getImageModel(LAKE_MODEL)!, doc, DEFAULT_CAPS), 'block')).toEqual([]);
    expect(codes(modelFit(getImageModel('nano-banana-pro')!, doc, resolveStudioCaps({ planId: 'free', byok: true, isAdmin: false })), 'block')).toEqual([]);
    expect(codes(modelFit(getImageModel('nano-banana-pro')!, doc, paid), 'block')).toEqual([]);
  });

  it('hidden / deprecated models are blocked unless they are the comic’s current model; unknown ids are hidden', () => {
    const doc = makeLakeComic();
    expect(codes(modelFit(getImageModel('flux-3')!, doc, paid), 'block')).toContain('hidden');
    expect(codes(modelFit(getImageModel('nano-banana-2')!, doc, paid), 'block')).toContain('hidden');
    const onFlux = makeLakeComic((d) => { d.imageModel = { modelId: 'flux-3', lockedAt: 1, origin: 'migrated' }; });
    expect(codes(modelFit(getImageModel('flux-3')!, onFlux, paid), 'block')).not.toContain('hidden');
    // models.md §3.4 item 7.2: the model just switched away from (changes[0].from) stays allowed so "Switch back"
    // (§3.6 F) works when it is hidden or deprecated now; any other hidden model stays blocked.
    const switched = makeLakeComic((d) => {
      d.imageModel = {
        modelId: 'nano-banana-2.1',
        lockedAt: 10,
        origin: 'user_change',
        changes: [
          { from: 'nano-banana-2', to: 'nano-banana-2.1', at: 10, redraw: 'none', quotedUsd: 0 },
          { from: 'flux-3', to: 'nano-banana-2', at: 5, redraw: 'none', quotedUsd: 0 } // older: no longer a target
        ]
      };
    });
    expect(codes(modelFit(getImageModel('nano-banana-2')!, switched, paid), 'block')).not.toContain('hidden');
    expect(codes(modelFit(getImageModel('flux-3')!, switched, paid), 'block')).toContain('hidden');
    expect(codes(modelFitById('nano-banana-2', switched, paid), 'block')).not.toContain('hidden');
    expect(modelFitById('nope', doc, paid)).toEqual([{ code: 'hidden', severity: 'block', text: 'Not available in Comic Studio yet' }]);
    // Lite cannot hold characters at all.
    expect(codes(modelFit(getImageModel('nano-banana-lite')!, doc, paid), 'block')).toContain('refs');
  });

  it('warns about sizes, lettering, experiments and unpublished prices honestly', () => {
    const standard2k = makeLakeComic((d) => { d.settings.quality = 'standard'; d.format.lettering = 'in_art'; });
    const seedream = modelFit(getImageModel('seedream-5-pro')!, standard2k, paid);
    expect(codes(seedream, 'warn')).toEqual(expect.arrayContaining(['lettering', 'experimental', 'price_unverified']));
    expect(seedream.find((r) => r.code === 'price_unverified')?.text).toBe("Price per image isn't published, so you'll see the real cost after the first image");
    const gpt = modelFit(getImageModel('gpt-image-2.5')!, standard2k, paid);
    expect(gpt).toContainEqual({ code: 'resolution', severity: 'warn', text: 'GPT Image 2.5 has no 2K option here.' });
    // $0.2107 at max is a number (OpenAI calculator token table), so it is not "unverified"; its basis tells the
    // picker it is an estimate (reference input unpriced), see the registry test below.
    expect(codes(gpt, 'warn')).not.toContain('price_unverified');
  });
});

describe('registry data (models.md §2.2)', () => {
  it('every spec carries the §3.3 fields and a cited or owned grade', () => {
    for (const spec of IMAGE_MODELS) {
      expect(typeof spec.pickable, spec.id).toBe('boolean');
      expect(['per_image', 'per_token_table', 'per_megapixel', 'unverified'], spec.id).toContain(spec.priceBasis);
      expect(spec.factsAsOf, spec.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const grade of ['text', 'pages', 'edit'] as const) {
        const source = spec.gradeSources?.[grade] || '';
        expect(source, `${spec.id}.${grade}`).toMatch(/our judgement|#\d+/);
      }
      if (spec.perRefUsd !== undefined) expect(spec.perRefUsd).toBeGreaterThan(0);
    }
  });

  it('pickable = Nano Banana 2.1 and Nano Banana Pro; everything else is hidden but still resolves', () => {
    expect(pickableImageModels().map((m) => m.id)).toEqual(['nano-banana-2.1', 'nano-banana-pro']);
    for (const id of ['flux-3', 'seedream-5-pro', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'nano-banana-2', 'nano-banana-lite', 'nano-banana-legacy']) {
      expect(getImageModel(id)?.pickable, id).toBe(false);
    }
    expect(getImageModel('nano-banana-2.1')).toMatchObject({ api: { openrouter: 'chat', gemini: 'chat' }, factsAsOf: '2026-10-22', priceBasis: 'per_token_table' });
  });

  it('the Seedream price fix, GPT 2.5 fixedQuality + Images API, Flare added, Pro reference charge', () => {
    expect(getImageModel('seedream-5-pro')).toMatchObject({ priceUsd: { '1K': 0.045 }, perRefUsd: 0.003, refs: { total: 10 } });
    expect(getImageModel('seedream-5-pro')!.priceUsd['2K']).toBeUndefined();
    expect(getImageModel('gpt-image-2.5')).toMatchObject({ fixedQuality: 'max', priceUsd: { '1K': 0.2107 }, resolutions: [], api: { openrouter: 'images' } });
    // $0.2107 is the OpenAI calculator's token factor × $30/M output tokens, not a published per-image price
    // (models.md §1.6 #1): the basis says so, so the UI can label the total an estimate (§3.6 C).
    expect(getImageModel('gpt-image-2.5')!.priceBasis).toBe('per_token_table');
    expect(getImageModel('gpt-image-2.5-flare')!.priceBasis).toBe('per_token_table');
    // Nano Banana Pro list: 1120 tokens × $120/M = $0.1344, stored unrounded (§2.3 never under-quotes).
    expect(getImageModel('nano-banana-pro')!.priceUsd).toEqual({ '1K': 0.1344, '2K': 0.1344, '4K': 0.24 });
    // FLUX.3 refuses 4K whenever references are sent (§1.4 #16/17): a 4K tier request snaps to 2K instead of failing.
    expect(getImageModel('flux-3')!.resolutions).not.toContain('4K');
    expect(getImageModel('flux-3')!.priceUsd['4K']).toBeUndefined();
    expect(nearestResolution(getImageModel('flux-3')!, '4K')).toBe('2K');
    expect(resolveImageJob('page', 'pro', undefined, { modelId: 'flux-3', lockedAt: 1, origin: 'migrated' }).resolution).toBe('2K');
    expect(getImageModel('gpt-image-2.5')!.aspects).not.toContain('4:5');
    expect(getImageModel('gpt-image-2.5-flare')).toMatchObject({ routes: { openrouter: 'openai/gpt-image-2.5-flare' }, fixedQuality: 'max', pickable: false, lifecycle: 'experimental' });
    expect(getImageModel('nano-banana-pro')!.perRefUsd).toBe(0.0011);
    expect(getImageModel('nano-banana-legacy')!.replacement).toBe('nano-banana-2.1'); // display-only
  });

  it('grades no longer claim Nano Banana Pro letters better than Nano Banana 2.1; the blurbs match', () => {
    const pro = getImageModel('nano-banana-pro')!;
    const everyday = getImageModel('nano-banana-2.1')!;
    const rank = { none: 0, basic: 1, good: 2, excellent: 3 } as const;
    expect(rank[pro.text]).toBeLessThanOrEqual(rank[everyday.text]);
    expect(rank[pro.pages]).toBeLessThanOrEqual(rank[everyday.pages]);
    expect(pro.blurb.toLowerCase()).not.toMatch(/best|lettering/);
    expect(pro.blurb).toContain('5 characters');
    expect(TIER_PRESETS.pro.blurb.toLowerCase()).not.toMatch(/best|in-art lettering/);
  });

  it('PRO_TIER_4K is off until D1 passes; on, the Pro tier is Nano Banana 2.1 at 4K pages/cover and 2K sheets', () => {
    expect(PRO_TIER_4K).toBe(false);
    expect(TIER_PRESETS.pro).toMatchObject({ model: 'nano-banana-pro', pageRes: '2K', sheetRes: '2K', coverRes: '2K', lettering: 'overlay' });
    expect(tierPresetsFor(true).pro).toMatchObject({ model: 'nano-banana-2.1', pageRes: '4K', sheetRes: '2K', coverModel: 'nano-banana-2.1', coverRes: '4K', lettering: 'overlay' });
    expect(tierPresetsFor(false)).toEqual(TIER_PRESETS);
    expect(tierPresetsFor(true).draft).toEqual(TIER_PRESETS.draft);
    expect(tierPresetsFor(true).standard).toEqual(TIER_PRESETS.standard);
  });

  it('DOC_LIMITS.modelChanges = 20', () => {
    expect(DOC_LIMITS.modelChanges).toBe(20);
  });
});

describe('normalizeDoc and the lock', () => {
  const legacyOwnerDoc = (): ComicDoc => {
    const doc = makeLakeComic((d) => {
      // Stored v4 docs: no lock, no §3.3 entry fields, no running totals.
      d.spend.entries = d.spend.entries.map(({ res: _r, route: _o, outcome: _u, ...rest }) => rest);
    });
    for (const k of ['imageModel'] as const) delete doc[k];
    return doc;
  };

  it('leaves legacy fixtures unchanged: no imageModel key, no running-total keys, cards and entries untouched', () => {
    const raw = legacyOwnerDoc();
    raw.conversation = [
      { id: 'm1', role: 'assistant', text: 'Hi', at: 1, cards: [{ type: 'notice', id: 'n1', tone: 'info', text: 'Saved.' }, { type: 'plan', id: 'p1' }] },
      { id: 'm2', role: 'assistant', text: 'Cost', at: 2, cards: [{ type: 'breakdown', id: 'b1', view: 'cost' }] }
    ];
    const once = normalizeDoc(clone(raw));
    expect('imageModel' in once).toBe(false);
    expect(Object.keys(once.spend).sort()).toEqual(['byKind', 'entries', 'totalUsd']);
    expect(once.spend.entries).toEqual(raw.spend.entries);
    expect(once.conversation.map((m) => m.cards)).toEqual(raw.conversation.map((m) => m.cards));
    expect(normalizeDoc(clone(once))).toEqual(once);
    expect(normalizeDoc(createEmptyDoc('n', 'New', 1))).not.toHaveProperty('imageModel');
  });

  it('keeps a well-formed lock as is — even when the registry no longer lists the id — and drops a malformed one', () => {
    const lock: ImageModelLock = {
      modelId: 'gemini-9-image-retired',
      providerModel: 'google/gemini-9-image',
      canonicalSlug: 'google/gemini-9-image-20270101',
      lockedAt: 123,
      origin: 'user_change',
      changes: [{ from: LAKE_MODEL, to: 'gemini-9-image-retired', at: 124, redraw: 'pages_cover', quotedUsd: 0.83 }]
    };
    const doc = normalizeDoc(makeLakeComic((d) => { d.imageModel = lock; }));
    expect(doc.imageModel).toEqual(lock);
    expect(normalizeDoc(clone(doc)).imageModel).toEqual(lock);
    for (const bad of [null, 'nano-banana-2.1', { modelId: '', lockedAt: 1, origin: 'first_render' }, { modelId: 'x', lockedAt: 'now', origin: 'first_render' }, { modelId: 'x', lockedAt: 1, origin: 'director' }, { modelId: 'x', lockedAt: 1 }]) {
      const d = normalizeDoc(makeLakeComic((x) => { (x as { imageModel?: unknown }).imageModel = bad; }));
      expect('imageModel' in d, JSON.stringify(bad)).toBe(false);
    }
  });

  it('normalizeImageModelLock: wire nulls dropped, malformed changes dropped, changes capped at DOC_LIMITS.modelChanges', () => {
    expect(normalizeImageModelLock({ modelId: 'm', lockedAt: 1, origin: 'first_render', providerModel: null, canonicalSlug: null, changes: null })).toEqual({ modelId: 'm', lockedAt: 1, origin: 'first_render' });
    const changes = Array.from({ length: 25 }, (_, i) => ({ from: `m${i}`, to: `m${i + 1}`, at: i, redraw: 'none', quotedUsd: 0 }));
    const lock = normalizeImageModelLock({ modelId: 'm', lockedAt: 1, origin: 'user_change', changes: [...changes, { from: 'x', to: 'y', at: 1, redraw: 'everything', quotedUsd: 1 }, { from: 'x' }] });
    expect(lock!.changes).toHaveLength(DOC_LIMITS.modelChanges);
    expect(lock!.changes![0]).toEqual(changes[0]); // newest first: the head is kept
    expect(normalizeImageModelLock({ modelId: 'm', lockedAt: 1, origin: 'user_change', changes: [{ from: 'a', to: 'b', at: 2, redraw: 'all', quotedUsd: -3 }] })!.changes).toEqual([{ from: 'a', to: 'b', at: 2, redraw: 'all', quotedUsd: 0 }]);
  });
});

describe('image_model op, change_image_model action, open_model_picker chip', () => {
  const lock: ImageModelLock = { modelId: LAKE_MODEL, providerModel: 'google/gemini-nano-banana-2.1', lockedAt: 7, origin: 'first_render' };

  it('image_model is server-only, never client-patchable, never undoable; it sets the lock and ignores junk', () => {
    expect(SERVER_ONLY_OPS).toContain('image_model');
    expect(CLIENT_PATCHABLE_OPS.has('image_model')).toBe(false);
    const before = makeLakeComic();
    const op: DocOp = { op: 'image_model', lock };
    const after = applyOp(before, op);
    expect(after.imageModel).toEqual(lock);
    expect(after).not.toBe(before);
    expect('imageModel' in before).toBe(false);
    expect(isUndoable(before, [op])).toBe(false);
    expect(applyOp(before, { op: 'image_model', lock: { modelId: '', lockedAt: 1, origin: 'first_render' } })).toBe(before);
    // A user change replaces the lock whole (changes[] travels inside it, newest first).
    const changed = applyOp(after, { op: 'image_model', lock: { ...lock, modelId: 'nano-banana-pro', origin: 'user_change', changes: [{ from: LAKE_MODEL, to: 'nano-banana-pro', at: 9, redraw: 'none', quotedUsd: 0 }] } });
    expect(changed.imageModel?.modelId).toBe('nano-banana-pro');
    expect(changed.imageModel?.changes).toHaveLength(1);
    // Over the wire (undefined → null) the same lock applies identically.
    const parsed = JSON.parse(encodeStudioEvent({ type: 'ops', rev: 1, ops: [op], origin: 'job', label: 'lock' })) as { ops: DocOp[] };
    expect(applyOp(before, parsed.ops[0])).toEqual(after);
  });

  it('change_image_model is a non-spend action; open_model_picker is a valid chip client action', () => {
    expect(NON_SPEND_ACTION_TYPES.has('change_image_model')).toBe(true);
    expect(SPEND_ACTION_TYPES.has('change_image_model')).toBe(false);
    const action: StudioAction = { type: 'change_image_model', modelId: 'nano-banana-pro', redraw: 'pages_cover', quotedUsd: 0.8309, ack: true };
    expect(action.type).toBe('change_image_model');
    expect(isValidNextStep({ label: 'See models', client: { type: 'open_model_picker', suggest: 'nano-banana-pro' } })).toBe(true);
  });
});

describe('SpendEntry §3.3 fields and the Spend running totals', () => {
  const entry = (over: Partial<SpendEntry>): SpendEntry => ({ id: 'e', at: 1, kind: 'page', label: 'Page 1', usd: 0.0428, model: LAKE_MODEL, byok: true, estimated: false, target: 'page:pg_1', ...over });

  it('res / route / outcome / listUsd / refs round-trip through the spend op, the wire and normalizeDoc', () => {
    const full = entry({ id: 'full', res: '2K', route: 'gemini', outcome: 'ok', listUsd: 0.0504, refs: 4 });
    const doc = applyOp(createEmptyDoc('d', 'D', 1), { op: 'spend', entry: full });
    expect(doc.spend.entries[0]).toEqual(full);
    const parsed = JSON.parse(encodeStudioEvent({ type: 'ops', rev: 1, ops: [{ op: 'spend', entry: full }], origin: 'job', label: 'x' })) as { ops: DocOp[] };
    expect(applyOp(createEmptyDoc('d', 'D', 1), parsed.ops[0]).spend.entries[0]).toEqual(full);
    expect(normalizeDoc(clone(doc)).spend.entries[0]).toEqual(full);
  });

  it('a new doc gains byModel / byTarget on its first image call and failed on a failed attempt', () => {
    let doc = createEmptyDoc('d', 'D', 1);
    doc = applyOp(doc, { op: 'spend', entry: entry({ id: 'chat', kind: 'chat', label: 'Director', usd: 0.004, model: 'director', target: undefined }) });
    expect(Object.keys(doc.spend).sort()).toEqual(['byKind', 'entries', 'totalUsd']); // a chat spend adds no totals
    doc = applyOp(doc, { op: 'spend', entry: entry({ id: 'p1', res: '1K', outcome: 'ok', listUsd: 0.0336 }) });
    doc = applyOp(doc, { op: 'spend', entry: entry({ id: 'p2', usd: 0.0465, target: 'page:pg_2', outcome: 'ok' }) });
    doc = applyOp(doc, { op: 'spend', entry: entry({ id: 'fail', usd: 0, target: 'page:pg_3', outcome: 'failed', res: '1K' }) });
    doc = applyOp(doc, { op: 'spend', entry: entry({ id: 'qc', kind: 'qc', label: 'QC', usd: 0.0049, model: 'gemini-3.8-flash', target: 'page:pg_1' }) });
    doc = applyOp(doc, { op: 'spend', entry: entry({ id: 'reuse', usd: 0, savedUsd: 0.0428, target: 'page:pg_4' }) }); // software reuse: not an image call
    expect(doc.spend.byModel).toEqual({ [LAKE_MODEL]: { usd: 0.0893, images: 2, failed: 1 } });
    expect(doc.spend.byTarget).toEqual({ 'page:pg_1': 0.0477, 'page:pg_2': 0.0465, 'page:pg_3': 0, 'page:pg_4': 0 });
    expect(doc.spend.failed).toEqual({ count: 1, usd: 0 });
    expect(doc.spend.totalUsd).toBeCloseTo(0.0982, 4);
    expect(normalizeDoc(clone(doc)).spend).toEqual(doc.spend);
  });

  it('a legacy doc with a complete entry list is seeded exactly from its entries on the next spend', () => {
    const legacy = makeLakeComic();
    expect(legacy.spend.byModel).toBeUndefined();
    const doc = applyOp(legacy, { op: 'spend', entry: entry({ id: 'new', at: LAKE_NOW, usd: 0.05, target: 'page:pg_1', res: '1K', outcome: 'ok' }) });
    expect(doc.spend.byModel![LAKE_MODEL]).toEqual({ usd: 0.8013, images: 16, failed: 0 });
    expect(doc.spend.byTarget!['page:pg_1']).toBeCloseTo(0.0579 + 0.06 + 0.0049 * 2 + 0.05, 4);
    expect(doc.spend.failed).toBeUndefined();
    const rebuilt = spendTotalsFromEntries(doc.spend.entries);
    expect(rebuilt.byModel).toEqual(doc.spend.byModel);
    expect(rebuilt.byTarget).toEqual(doc.spend.byTarget);
  });

  it('a legacy doc whose entries already hit the cap never gets totals (a rebuild would not be exact)', () => {
    let doc = createEmptyDoc('d', 'D', 1);
    const capped: SpendEntry[] = Array.from({ length: MAX_SPEND_ENTRIES }, (_, i) => entry({ id: `old${i}`, at: i }));
    doc = { ...doc, spend: { ...doc.spend, entries: capped, totalUsd: 1 } };
    const after = applyOp(doc, { op: 'spend', entry: entry({ id: 'new', at: 999 }) });
    expect(after.spend.entries).toHaveLength(MAX_SPEND_ENTRIES);
    expect(after.spend.byModel).toBeUndefined();
    expect(after.spend.byTarget).toBeUndefined();
    // …but once totals exist they are kept exact past the cap.
    const seeded = applyOp({ ...doc, spend: { ...doc.spend, byModel: { [LAKE_MODEL]: { usd: 8.56, images: 200, failed: 0 } } } }, { op: 'spend', entry: entry({ id: 'new', at: 999 }) });
    expect(seeded.spend.byModel![LAKE_MODEL]).toEqual({ usd: 8.6028, images: 201, failed: 0 });
  });

  it('normalizeDoc keeps well-formed totals and drops malformed ones (never invents them)', () => {
    const doc = makeLakeComic((d) => {
      d.spend.byModel = { [LAKE_MODEL]: { usd: 0.75, images: 15, failed: 0 }, bad: { usd: 'x' } as never };
      d.spend.byTarget = { cover: 0.0533, nope: 'x' as never };
      d.spend.failed = { count: 0, usd: 0 };
    });
    const n = normalizeDoc(clone(doc));
    expect(n.spend.byModel).toEqual({ [LAKE_MODEL]: { usd: 0.75, images: 15, failed: 0 } });
    expect(n.spend.byTarget).toEqual({ cover: 0.0533 });
    expect(n.spend.failed).toBeUndefined();
  });
});

describe('model_outage card', () => {
  const card: Card = {
    type: 'model_outage',
    id: 'card_o1',
    modelId: LAKE_MODEL,
    options: [
      { kind: 'wait_and_retry', etaHint: 'a few minutes' },
      { kind: 'other_route', route: 'gemini', label: 'Use the same model through your Gemini key' },
      { kind: 'switch_model', modelId: 'nano-banana-pro', nickname: 'Nano Banana Pro', usdPerImage: 0.1344, consistency: 'same_family', redrawCount: 6, redrawUsd: 0.8309 },
      { kind: 'add_key', route: 'gemini', label: 'Add a Gemini key' }
    ],
    blockedAction: { type: 'render_pages', pageIds: ['pg_1'], quotedUsd: 0.05 }
  };

  it('is in the Card union and survives normalizeDoc exactly; malformed options are dropped, optionless cards removed', () => {
    const msg: Msg = { id: 'm', role: 'assistant', text: 'Google is throttling Nano Banana 2.1 right now. Nothing was charged.', at: 1, cards: [card, { type: 'notice', id: 'n', tone: 'info', text: 'x' }] };
    const doc = normalizeDoc({ ...makeLakeComic(), conversation: [msg] });
    expect(doc.conversation[0].cards).toEqual(msg.cards);
    expect(normalizeOutageCard(card)).toEqual(card);
    const dirty = { ...card, options: [...card.options, { kind: 'teleport' }, { kind: 'switch_model', modelId: 'x' }, { kind: 'other_route', route: 'mars', label: 'x' }] };
    expect(normalizeOutageCard(dirty)).toEqual(card);
    const emptied = normalizeDoc({ ...makeLakeComic(), conversation: [{ ...msg, cards: [{ ...card, options: [{ kind: 'nope' }] } as never, msg.cards![1]] }] });
    expect(emptied.conversation[0].cards).toEqual([msg.cards![1]]);
    expect(normalizeOutageCard({ type: 'model_outage', id: 'x', modelId: '', options: [{ kind: 'wait_and_retry' }] })).toBeUndefined();
  });

  it('blockedAction is kept only when its type is a StudioAction type; anything else is dropped, the card stays', () => {
    const { blockedAction: _b, ...bare } = card;
    for (const bad of [{ type: 'drop_tables' }, { type: '' }, { type: 42 }, 'render_pages', null, { pageIds: ['pg_1'] }]) {
      expect(normalizeOutageCard({ ...card, blockedAction: bad }), JSON.stringify(bad)).toEqual(bare);
    }
    expect(normalizeOutageCard({ ...card, blockedAction: { type: 'change_image_model', modelId: 'nano-banana-pro', redraw: 'none', quotedUsd: 0, ack: true } })?.blockedAction?.type).toBe('change_image_model');
    const stored = normalizeDoc({ ...makeLakeComic(), conversation: [{ id: 'm', role: 'assistant', text: 'paused', at: 1, cards: [{ ...card, blockedAction: { type: 'drop_tables' } } as never] }] });
    expect(stored.conversation[0].cards).toEqual([bare]);
  });

  it('a message op carrying the card applies through applyOps unchanged', () => {
    const doc = applyOps(makeLakeComic(), [{ op: 'message', msg: { id: 'm', role: 'assistant', text: 'paused', at: 1, cards: [card] } }]);
    expect(doc.conversation.at(-1)?.cards).toEqual([card]);
  });
});
