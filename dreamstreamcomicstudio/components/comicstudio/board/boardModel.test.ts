import { describe, expect, it } from 'vitest';
import { estimateJobs } from '../../../shared/comic/models';
import { getStylePreset } from '../../../shared/comic/stylePresets';
import {
  byokFromDoc,
  estimateDraw,
  formatElapsed,
  formatSpend,
  initials,
  pageProgress,
  pageVisualStatus,
  pagesForIds,
  pagesToDraw,
  presetOps,
  renderModelNickname,
  sheetsNeededFor
} from './boardModel';
import { makeSampleDoc } from './__fixtures__/sampleDoc';

describe('page states', () => {
  it('maps every render state, surfacing stale drawn pages', () => {
    const doc = makeSampleDoc();
    expect(doc.pages.map((p) => pageVisualStatus(doc, p))).toEqual(['ready', 'planned', 'queued', 'rendering', 'stale', 'failed']);
  });

  it('marks an explicitly stale render and an empty page', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[1].render.status = 'stale';
      d.pages[2].panels = [];
      d.pages[2].render = { status: 'none', history: [] };
    });
    expect(pageVisualStatus(doc, doc.pages[1])).toBe('stale');
    expect(pageVisualStatus(doc, doc.pages[2])).toBe('empty');
  });

  it('counts current drawn pages for the tab badge', () => {
    expect(pageProgress(makeSampleDoc())).toEqual({ ready: 1, total: 6 });
  });
});

describe('what a click would draw', () => {
  it('render-all draws planned, stale and failed pages — never ones already drawing', () => {
    const doc = makeSampleDoc();
    expect(pagesToDraw(doc).map((p) => p.id)).toEqual(['pg_2', 'pg_5', 'pg_6']);
  });

  it('a forced redraw takes the chosen pages that are not busy', () => {
    const doc = makeSampleDoc();
    expect(pagesForIds(doc, ['pg_1', 'pg_3', 'pg_4', 'pg_6']).map((p) => p.id)).toEqual(['pg_1', 'pg_6']);
  });

  it('adds missing lead/support sheets (never extras)', () => {
    const doc = makeSampleDoc();
    expect(sheetsNeededFor(doc, pagesToDraw(doc)).map((c) => c.id)).toEqual(['ch_arjun']);
  });

  it('prices pages plus sheets with the registry', () => {
    const doc = makeSampleDoc();
    const plan = estimateDraw(doc, pagesToDraw(doc), false);
    const expected = estimateJobs(
      [
        { kind: 'page', count: 3, label: 'pages' },
        { kind: 'sheet', count: 1, label: 'character sheets' }
      ],
      'standard'
    );
    expect(plan.estimate.usd).toBe(expected.usd);
    expect(estimateDraw(doc, pagesToDraw(doc), true).estimate.usd).toBeLessThan(plan.estimate.usd);
  });

  it('infers BYOK from the latest image spend', () => {
    expect(byokFromDoc(makeSampleDoc())).toBe(true);
    expect(byokFromDoc(makeSampleDoc((d) => (d.spend.entries = [])))).toBe(false);
  });

  it('names the model that drew (or will draw) a render', () => {
    const doc = makeSampleDoc();
    expect(renderModelNickname(doc, doc.pages[0].render, 'page')).toBe('Nano Banana 2.1');
    const pro = makeSampleDoc((d) => (d.settings.quality = 'pro'));
    expect(renderModelNickname(pro, undefined, 'page')).toBe('Nano Banana Pro');
  });
});

describe('presets', () => {
  it('drafts the preset, drops a board from another look, and syncs color mode', () => {
    const doc = makeSampleDoc();
    const ops = presetOps(doc, getStylePreset('noir-ink')!);
    expect(ops[0]).toMatchObject({ op: 'style', patch: { status: 'drafted', presetId: 'noir-ink', board: null } });
    expect(ops[1]).toEqual({ op: 'format', patch: { colorMode: 'bw' } });
  });

  it('keeps color mode when it already matches', () => {
    const doc = makeSampleDoc((d) => (d.style.board = undefined));
    const ops = presetOps(doc, getStylePreset('modern-heroic')!);
    expect(ops).toHaveLength(1);
    expect('board' in (ops[0] as { patch: object }).patch).toBe(false);
  });
});

describe('labels', () => {
  it('formats small things', () => {
    expect(initials('maya')).toBe('MA');
    expect(initials('Arjun Rao Mehta')).toBe('AM');
    expect(initials('')).toBe('?');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatSpend(0.004)).toBe('$0.004');
    expect(formatSpend(0.4)).toBe('$0.40');
    expect(formatSpend(0)).toBe('$0.00');
  });
});
