// @vitest-environment node
// propose_styles and its gate (stylepick SC-0). Paid steps always wait for Approve: a Director-started style test
// opens an Approve card whether the user asked for looks ('policy') or not ('no_intent'), on a new comic too (the
// empty-style exemption is gone). Only a comic set to "never ask" starts at once (the daily house runner relies on
// it). The tool takes a count (2–6, clamped and said so), named presets, and directions that are refused when they
// name an artist, studio or brand. Scripted fakes only: no model or provider call, $0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc.js';
import type { SpendAction } from '../../../shared/comic/ops.js';
import { JOB_TIMINGS } from './jobs.js';
import { newSession, plannedDoc, testContext, type TestContext } from './orchestrator.fakes.js';
import { drawIntentOf } from './replies.js';
import { buildDirectorTools, createDirectorTurn, forcedGateReason, type DirectorTool, type DirectorTurn } from './tools.js';

let ctx: TestContext;
let turn: DirectorTurn;
let tools: Map<string, DirectorTool>;

/** A new comic: nothing drawn, no style yet, the default "ask for big spends" policy. */
const newComic = (patch: (doc: ComicDoc) => void = () => undefined): ComicDoc => {
  const doc = plannedDoc();
  doc.style = { status: 'empty', refs: [], options: [] };
  doc.settings = { ...doc.settings, confirm: 'big', bigSpendUsd: 0.5 };
  patch(doc);
  return doc;
};

const setup = (doc: ComicDoc, userText: string) => {
  ctx = testContext(newSession(doc));
  turn = createDirectorTurn({ userText, drawIntent: drawIntentOf(userText) });
  tools = new Map(buildDirectorTools(ctx, turn).map((t) => [t.spec.function.name, t]));
};
const propose = (args: Record<string, unknown>) => tools.get('propose_styles')!.execute(args);
const gateAction = () => ctx.session.doc.gate?.action as Extract<SpendAction, { type: 'render_style_options' }> | undefined;

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('forcedGateReason for style tests', () => {
  it('an ask for looks on a new comic waits for Approve (policy); no ask waits too (no_intent)', () => {
    const doc = newComic();
    expect(forcedGateReason(doc, createDirectorTurn({ userText: 'generate 3 styles', drawIntent: 'explicit' }), 'style')).toBe('policy');
    expect(forcedGateReason(doc, createDirectorTurn({ userText: 'ok', drawIntent: 'none' }), 'style')).toBe('no_intent');
    // A looks ask the draw regex misses (a typo, "show me") still reads as asked.
    expect(forcedGateReason(doc, createDirectorTurn({ userText: 'egernate 3 styles', drawIntent: 'none' }), 'style')).toBe('policy');
    expect(forcedGateReason(doc, createDirectorTurn({ userText: 'show me some looks', drawIntent: 'none' }), 'style')).toBe('policy');
    // A redraw ask is an ask.
    expect(forcedGateReason(doc, createDirectorTurn({ userText: 'redo the styles', drawIntent: 'redraw' }), 'style')).toBe('policy');
  });

  it('"never ask" comics start at once; other kinds keep their rules', () => {
    const never = newComic((d) => (d.settings.confirm = 'never'));
    expect(forcedGateReason(never, createDirectorTurn({ userText: 'generate 3 styles', drawIntent: 'explicit' }), 'style')).toBeUndefined();
    expect(forcedGateReason(never, createDirectorTurn({ userText: 'ok', drawIntent: 'none' }), 'style')).toBeUndefined();
    const doc = newComic();
    // Unchanged: an asked-for cover under the threshold, a no-intent sheet, a redraw.
    expect(forcedGateReason(doc, createDirectorTurn({ userText: 'make the cover', drawIntent: 'explicit' }), 'cover')).toBeUndefined();
    expect(forcedGateReason(doc, createDirectorTurn({ userText: 'ok', drawIntent: 'none' }), 'sheets')).toBe('no_intent');
    expect(forcedGateReason(never, createDirectorTurn({ userText: 'redo it', drawIntent: 'redraw' }), 'cover', { redraw: true })).toBe('redraw');
  });
});

describe('propose_styles always waits for Approve', () => {
  it('empty style + "generate 3 styles": an Approve card (policy), nothing drawn', async () => {
    setup(newComic(), 'generate 3 styles');
    const out = await propose({ count: 3 });
    expect(out).toMatch(/^Waiting for the user to approve/);
    expect(ctx.session.doc.gate).toMatchObject({ status: 'open', reason: 'policy', imageCount: 3 });
    expect(gateAction()).toMatchObject({ type: 'render_style_options', count: 3 });
    expect(turn.cards.map((c) => c.type)).toContain('gate');
    await ctx.settled();
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(ctx.session.doc.spend.totalUsd).toBe(0);
    expect(ctx.session.doc.style.options).toEqual([]);
  });

  it('empty style + "ok" (no ask): an Approve card (no_intent), nothing drawn', async () => {
    setup(newComic(), 'ok');
    await propose({});
    expect(ctx.session.doc.gate).toMatchObject({ status: 'open', reason: 'no_intent' });
    await ctx.settled();
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('a locked style + an ask: an Approve card (policy)', async () => {
    setup(newComic((d) => (d.style = { ...d.style, status: 'locked', name: 'Ink', spec: 'Bold ink outlines, flat colour.' })), 'show me 3 new looks');
    await propose({ count: 3 });
    expect(ctx.session.doc.gate).toMatchObject({ status: 'open', reason: 'policy' });
    await ctx.settled();
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('"never ask" + an ask: starts at once (the daily house runner)', async () => {
    setup(newComic((d) => (d.settings.confirm = 'never')), 'generate 2 styles');
    const out = await propose({ directions: [{ name: 'Ink', spec: 'Bold ink outlines, flat colour.' }, { name: 'Wash', spec: 'Soft watercolour washes.' }] });
    expect(out).toMatch(/^Started drawing 2 looks: Ink and Wash/);
    expect(ctx.session.doc.gate).toBeFalsy();
    await ctx.settled();
    expect(ctx.imagesFake.calls).toHaveLength(2);
  });
});

describe('propose_styles arguments', () => {
  it('count 9 is clamped to 6 and the result says 6 is the most', async () => {
    setup(newComic(), 'draw 9 looks');
    const out = await propose({ count: 9 });
    expect(gateAction()).toMatchObject({ type: 'render_style_options', count: 6 });
    expect(ctx.session.doc.gate?.imageCount).toBe(6);
    expect(out).toMatch(/6 looks is the most/);
  });

  it('count is clamped up to 2 and the default is 3', async () => {
    setup(newComic(), 'draw looks');
    await propose({ count: 1 });
    expect(gateAction()?.count).toBe(2);
    setup(newComic(), 'draw looks');
    await propose({});
    expect(gateAction()?.count).toBe(3);
  });

  it('presetIds ride the action (names and specs come from the presets, no writer call)', async () => {
    setup(newComic(), 'show me noir and woodcut');
    await propose({ presetIds: ['noir-ink', 'woodcut'] });
    expect(gateAction()).toMatchObject({ type: 'render_style_options', presetIds: ['noir-ink', 'woodcut'] });
    expect(gateAction()?.count).toBeUndefined();
    expect(ctx.session.doc.gate?.imageCount).toBe(2);
    expect(await propose({ presetIds: ['tintin-ish'] })).toMatch(/^Error: Unknown preset tintin-ish/);
  });

  it('a direction naming an artist, studio or brand is refused before anything is quoted or spent', async () => {
    for (const direction of [
      { name: 'Soft wonder', spec: 'Like Studio Ghibli: lush painted skies, gentle characters.' },
      { name: 'Ligne', spec: 'In the style of Moebius, clean lines and pastel deserts.' },
      { name: 'Marvel punch', spec: 'Bold heroic inks with halftone dots.' }
    ]) {
      setup(newComic(), 'draw 2 looks');
      const out = await propose({ directions: [direction, { name: 'Plain', spec: 'Clean outlines, flat colour.' }] });
      expect(out).toBe('Error: Describe the technique, not the artist, studio or brand (for example "soft watercolour washes, loose ink lines") and call propose_styles again.');
      expect(ctx.session.doc.gate).toBeFalsy();
      await ctx.settled();
      expect(ctx.imagesFake.calls).toHaveLength(0);
      expect(ctx.session.doc.spend.totalUsd).toBe(0);
    }
  });

  it('repeated names are refused', async () => {
    setup(newComic(), 'draw 2 looks');
    const out = await propose({ directions: [{ name: 'Ink', spec: 'Bold ink outlines.' }, { name: ' ink ', spec: 'Soft grey ink washes.' }] });
    expect(out).toMatch(/^Error: Give each look its own name/);
    expect(ctx.session.doc.gate).toBeFalsy();
    // A direction repeating a preset's name too.
    const again = await propose({ presetIds: ['noir-ink'], directions: [{ name: 'Noir ink', spec: 'Heavy blacks.' }] });
    expect(again).toMatch(/^Error: Give each look its own name/);
  });

  it('named looks win over count, and the result says so', async () => {
    setup(newComic(), 'draw 3 looks, one in ink');
    const out = await propose({ count: 3, directions: [{ name: 'Ink', spec: 'Bold ink outlines.' }] });
    expect(gateAction()).toMatchObject({ directions: [{ name: 'Ink', spec: 'Bold ink outlines.' }] });
    expect(gateAction()?.count).toBeUndefined();
    expect(out).toMatch(/draws the 1 look named/);
  });

  it('describes count, presetIds and the Approve wait (short: it sits in every director prompt)', () => {
    setup(newComic(), 'hi');
    const spec = tools.get('propose_styles')!.spec.function;
    const params = spec.parameters as { properties: Record<string, { type?: string; description?: string; items?: { type?: string } }> };
    expect(params.properties.count).toEqual({ type: 'integer', description: '2–6' });
    expect(params.properties.directions.type).toBe('array');
    expect(params.properties.presetIds).toEqual({ type: 'array', items: { type: 'string' } });
    expect(spec.description).toMatch(/default 3, max 6/);
    expect(spec.description).toMatch(/waits for Approve/);
    expect(spec.description).toMatch(/only for looks the user named/);
    expect(spec.description.length).toBeLessThan(200);
  });
});
