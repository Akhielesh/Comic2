// The publish gate (safety.md §14 #27): both visibilities, published translations included,
// platform-paid, never fails open.
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../../shared/comic/doc.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { cleanAnswer } from './fakes.js';
import { runPublishGate } from './index.js';
import { expand, installSafetyFakes, resetSafety, type SafetyFakes } from './testkit.js';

let fakes: SafetyFakes;
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  fakes = installSafetyFakes();
});
afterEach(() => {
  resetSafety();
  vi.restoreAllMocks();
});

const img = async () => `data:image/webp;base64,${(await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 40, g: 90, b: 160 } } }).webp().toBuffer()).toString('base64')}`;

const drawn = async (verdicts: Record<string, 'G' | 'PG' | 'PG-13' | 'X' | undefined>, opts: { cover?: 'G' | 'X' | null } = {}) => {
  const doc = plannedDoc();
  for (const page of doc.pages) {
    const v = verdicts[page.id];
    page.render = { ...emptyRender(), status: 'ready', asset: { path: `u/user-1/p/proj-1/img/${page.id}.webp`, source: 'generated', at: 1, ...(v ? { safety: { assessed: v, at: 1, by: 'qc' as const } } : {}) } };
  }
  if (opts.cover !== undefined) {
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/cover.webp', source: 'generated', at: 1, ...(opts.cover ? { safety: { assessed: opts.cover, at: 1 } } : {}) } };
  }
  const session = newSession(doc);
  const ctx = testContext(session);
  const data = await img();
  for (const page of doc.pages) ctx.assetsFake.files.set(page.render.asset!.path, data);
  ctx.assetsFake.files.set('u/user-1/p/proj-1/img/cover.webp', data);
  return { doc: session.doc, ctx, session };
};

const ALL = { pageIds: ['pg_1', 'pg_2', 'pg_3'], includeCover: true, languages: [] as string[] };

describe('runPublishGate', () => {
  it('everything passes → cleared, verdicts and the text check are recorded on the doc', async () => {
    const { doc, ctx, session } = await drawn({ pg_1: 'G', pg_2: 'PG', pg_3: 'G' }, { cover: 'G' });
    const gate = await runPublishGate(ctx, doc, ALL);
    expect(gate).toMatchObject({ status: 'cleared', rating: 'PG-13', cover: { status: 'pass' }, text: { status: 'pass' } });
    expect(Object.values(gate.pages).every((p) => p.status === 'pass')).toBe(true);
    expect(gate.checkedHash).toMatch(/^[0-9a-f]{24}$/);
    expect(session.doc.safety?.publish).toMatchObject({ ok: true, rating: 'PG-13', blockers: [] });
    expect(session.doc.safety?.text?.assessed).toBe('G');
    // One text classification, no image checks (every page already had a verdict).
    expect(fakes.llm.calls.map((c) => c.jsonSchema?.name)).toEqual(['comic_safety_text']);
    expect(ctx.billingFake.reserves).toEqual([]);
  });

  it('an over-rating page blocks the publish with neutral reasons and a blocker entry', async () => {
    const { doc, ctx, session } = await drawn({ pg_1: 'G', pg_2: 'PG-13', pg_3: 'G' });
    session.commit([{ op: 'settings', patch: { rating: 'PG' } }]);
    const gate = await runPublishGate(ctx, session.doc, { ...ALL, includeCover: false });
    expect(gate.status).toBe('blocked');
    expect(gate.rating).toBe('PG');
    expect(gate.pages.pg_2).toEqual({ status: 'over_rating', reasons: ['Rated PG-13 — this comic is PG'] });
    expect(gate.cover).toBeNull();
    expect(session.doc.safety?.publish?.blockers).toEqual([{ target: { kind: 'page', id: 'pg_2' }, status: 'over_rating', categories: [] }]);
    expect(fakes.store.actions.at(-1)).toMatchObject({ action: 'publish_blocked' });
    void doc;
  });

  it('a blocked page blocks; unchecked pages are checked now on the platform key and the cost is reported', async () => {
    const { doc, ctx, session } = await drawn({ pg_1: 'X', pg_2: undefined, pg_3: 'G' });
    fakes.llm.script.vision = [{ ...cleanAnswer({ role: 'vision', messages: [], jsonSchema: { name: 'comic_safety_image', schema: {} } }), rating: 'PG' }];
    const gate = await runPublishGate(ctx, doc, { ...ALL, includeCover: false });
    expect(gate.pages.pg_1.status).toBe('blocked');
    expect(gate.pages.pg_2.status).toBe('pass');
    expect(session.doc.pages[1].render.asset?.safety).toMatchObject({ assessed: 'PG', by: 'check' });
    expect(gate.costUsd).toBeGreaterThan(0);
    expect(fakes.store.costs.some((c) => c.operation === 'comic.safety.publish')).toBe(true);
  });

  it('never fails open: without a platform key, unchecked pages and text → needs_check', async () => {
    resetSafety();
    fakes = installSafetyFakes({ llm: null });
    const { doc, ctx } = await drawn({ pg_1: 'G', pg_2: undefined, pg_3: 'G' });
    const gate = await runPublishGate(ctx, doc, { ...ALL, includeCover: false });
    expect(gate.status).toBe('needs_check');
    expect(gate.pages.pg_2).toEqual({ status: 'unchecked', reasons: ["Couldn't be checked right now"] });
    expect(gate.text.status).toBe('unchecked');
  });

  it('published translations are part of the text check (a blocked word in a translation blocks)', async () => {
    const { ctx, session } = await drawn({ pg_1: 'G', pg_2: 'G', pg_3: 'G' });
    session.commit([
      { op: 'edition', lang: 'hi', patch: { register: 'everyday' } },
      { op: 'translations', lang: 'hi', lines: { ln_1_2: { text: expand('<SLUR>'), status: 'machine', sourceHash: 'x', at: 1 } } }
    ]);
    const withHi = await runPublishGate(ctx, session.doc, { ...ALL, includeCover: false, languages: ['hi'] });
    expect(withHi.text.status).toBe('blocked');
    expect(withHi.status).toBe('blocked');
    const sourceOnly = await runPublishGate(ctx, session.doc, { ...ALL, includeCover: false, languages: [] });
    expect(sourceOnly.text.status).toBe('pass');
  });

  it('the text check is cached by hash (an unchanged comic re-publishes without a new call)', async () => {
    const { doc, ctx, session } = await drawn({ pg_1: 'G', pg_2: 'G', pg_3: 'G' });
    await runPublishGate(ctx, doc, { ...ALL, includeCover: false });
    const calls = fakes.llm.calls.length;
    await runPublishGate(ctx, session.doc, { ...ALL, includeCover: false });
    expect(fakes.llm.calls.length).toBe(calls);
  });

  it('a page that is not drawn is reported, not passed', async () => {
    const doc: ComicDoc = plannedDoc();
    const ctx = testContext(newSession(doc));
    const gate = await runPublishGate(ctx, doc, { pageIds: ['pg_1'], includeCover: true, languages: [] });
    expect(gate.pages.pg_1).toEqual({ status: 'unchecked', reasons: ['Not drawn yet'] });
    expect(gate.cover).toBeNull();
    expect(gate.status).toBe('needs_check');
  });
});
