// @vitest-environment node
// render_style_options counts (stylepick SC-0): the writer is asked for `count` looks (2–6, default 3), named presets
// are drawn from their own name and spec without a writer call, at most 6 looks run at once, and the gate copy says
// what will be drawn. The quote, the run and the gate read the same count. Fakes only: no model or provider call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc.js';
import type { SpendAction } from '../../../shared/comic/ops.js';
import { estimateJobs, styleDirectionsUsd } from '../../../shared/comic/models.js';
import { getStylePreset } from '../../../shared/comic/stylePresets.js';
import { JOB_TIMINGS, estimateSpendAction, runAction, startAction } from './jobs.js';
import { narrowBlockedAction } from './models/health.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { proposeStyleDirections } from './writer.js';

vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, proposeStyleDirections: vi.fn() };
});

type StyleAction = Extract<SpendAction, { type: 'render_style_options' }>;
const looks = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Look ${i + 1}`, spec: `Spec number ${i + 1}, bold lines.` }));

const freshDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.style = { status: 'empty', refs: [], options: [] };
  return doc;
};

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.mocked(proposeStyleDirections).mockReset();
  vi.restoreAllMocks();
});

describe('count', () => {
  it('{count: 5}: the writer is asked for 5, 5 looks are drawn, the quote is 5 looks + the writer', async () => {
    vi.mocked(proposeStyleDirections).mockImplementation(async ({ count }) => ({ options: looks(count), model: 'w' }));
    const doc = freshDoc();
    const est = estimateSpendAction(doc, { type: 'render_style_options', count: 5 }, false);
    expect(est.imageCount).toBe(5);
    const images = estimateJobs([{ kind: 'style_option', count: 5 }], doc.settings.quality, { byok: false }).usd;
    expect(est.usd).toBeCloseTo(images + styleDirectionsUsd(false), 4);
    expect(est.lines.map((l) => l.label)).toEqual(['style options', 'style directions']);

    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_style_options', count: 5 }, { confirmed: true });
    expect(vi.mocked(proposeStyleDirections)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(proposeStyleDirections).mock.calls[0][0].count).toBe(5);
    expect(session.doc.style.options.map((o) => o.name)).toEqual(['Look 1', 'Look 2', 'Look 3', 'Look 4', 'Look 5']);
    expect(ctx.imagesFake.calls).toHaveLength(5);
  });

  it('clamps to 2–6 and defaults to 3 (quote and run agree)', () => {
    const doc = freshDoc();
    const n = (action: Partial<StyleAction>) => estimateSpendAction(doc, { type: 'render_style_options', ...action }, false).imageCount;
    expect(n({})).toBe(3);
    expect(n({ count: 9 })).toBe(6);
    expect(n({ count: 1 })).toBe(2);
    expect(n({ count: 4.4 })).toBe(4);
    expect(n({ count: Number.NaN })).toBe(3);
    expect(n({ count: '5' as unknown as number })).toBe(3);
  });

  it('a writer that returns more looks than asked never draws more than were quoted', async () => {
    vi.mocked(proposeStyleDirections).mockImplementation(async () => ({ options: looks(6), model: 'w' }));
    const session = newSession(freshDoc());
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_style_options', count: 2 }, { confirmed: true });
    expect(session.doc.style.options).toHaveLength(2);
    expect(ctx.imagesFake.calls).toHaveLength(2);
  });
});

describe('presetIds and directions', () => {
  it('{presetIds: [noir-ink, woodcut]}: 2 looks named and specified by the presets, no writer call', async () => {
    const doc = freshDoc();
    const est = estimateSpendAction(doc, { type: 'render_style_options', presetIds: ['noir-ink', 'woodcut'] }, false);
    expect(est.imageCount).toBe(2);
    expect(est.lines.some((l) => l.label === 'style directions')).toBe(false);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_style_options', presetIds: ['noir-ink', 'woodcut'] }, { confirmed: true });
    expect(vi.mocked(proposeStyleDirections)).not.toHaveBeenCalled();
    expect(session.doc.style.options.map((o) => [o.name, o.spec])).toEqual([
      ['Noir ink', getStylePreset('noir-ink')!.spec],
      ['Woodcut / linocut', getStylePreset('woodcut')!.spec]
    ]);
    expect(ctx.imagesFake.calls).toHaveLength(2);
  });

  it('presets first, then directions, at most 6 in all; unknown and repeated preset ids are dropped', () => {
    const doc = freshDoc();
    const n = (action: Partial<StyleAction>) => estimateSpendAction(doc, { type: 'render_style_options', ...action }, false).imageCount;
    expect(n({ directions: looks(7) })).toBe(6);
    expect(n({ presetIds: ['noir-ink', 'noir-ink', 'nope'] })).toBe(1);
    expect(n({ presetIds: ['noir-ink', 'woodcut'], directions: looks(5) })).toBe(6);
    // count never adds to named looks.
    expect(n({ presetIds: ['noir-ink'], count: 5 })).toBe(1);
  });

  it('a re-sent outage action keeps only the failed looks (presetIds and count are dropped)', () => {
    const doc = freshDoc();
    doc.style.options = [
      { id: 'so_1', name: 'Noir ink', spec: 'Heavy blacks.', render: { status: 'ready', history: [], asset: { path: 'a.webp', source: 'generated', at: 1 } } },
      { id: 'so_2', name: 'Woodcut / linocut', spec: 'Carved lines.', render: { status: 'failed', history: [], error: 'x' } }
    ];
    const action: StyleAction = { type: 'render_style_options', presetIds: ['noir-ink', 'woodcut'], count: 3, quotedUsd: 0.1 };
    expect(narrowBlockedAction(action, [{ kind: 'style_option', id: 'so_2' }], doc)).toEqual({
      type: 'render_style_options',
      quotedUsd: 0.1,
      directions: [{ name: 'Woodcut / linocut', spec: 'Carved lines.' }]
    });
  });
});

describe('gate copy', () => {
  const gateOf = async (action: StyleAction) => {
    const doc = freshDoc();
    doc.settings = { ...doc.settings, confirm: 'always' };
    const session = newSession(doc);
    const ctx = testContext(session);
    await (await startAction(ctx, action, { confirmed: false, origin: 'user' })).done;
    return session.doc.gate!;
  };

  it('count only: "Draw 3 looks picked for your story?"', async () => {
    const gate = await gateOf({ type: 'render_style_options', count: 3 });
    expect(gate.title).toBe('Draw 3 looks picked for your story?');
    expect(gate.summary.startsWith('3 looks picked for your story on ')).toBe(true);
    expect((await gateOf({ type: 'render_style_options' })).title).toBe('Draw 3 looks picked for your story?');
  });

  it('named looks: "Draw 3 looks of your comic?" with their names', async () => {
    const gate = await gateOf({
      type: 'render_style_options',
      directions: [
        { name: 'Ink wash', spec: 'Grey washes.' },
        { name: 'Riso', spec: 'Two inks.' },
        { name: 'Noir ink', spec: 'Heavy blacks.' }
      ]
    });
    expect(gate.title).toBe('Draw 3 looks of your comic?');
    expect(gate.summary.startsWith('3 looks: Ink wash, Riso and Noir ink on ')).toBe(true);
    expect((await gateOf({ type: 'render_style_options', presetIds: ['woodcut'] })).title).toBe('Draw 1 look of your comic?');
  });
});
