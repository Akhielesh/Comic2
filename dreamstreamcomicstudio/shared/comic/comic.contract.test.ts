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
