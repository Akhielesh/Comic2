// The publish gate (safety.md §14 #27): both visibilities, published translations included,
// platform-paid, never fails open.
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../../shared/comic/doc.js';
import { publishableText } from '../../../../shared/comic/safety.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { StudioError } from '../types.js';
import { ratingOf, sha256Hex } from './deps.js';
import { cleanAnswer } from './fakes.js';
import { runPublishGate } from './index.js';
import { gateWindows, MAX_GATE_TEXT_CHARS } from './publishGate.js';
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
    // The three pages carry render-QC passes (from the call that also read the author's script), so
    // each is re-rated image-only once (S14); the cover's non-QC verdict is reused. One text check.
    // Platform-paid: nothing is reserved against the user's usage.
    expect(fakes.llm.calls.map((c) => c.jsonSchema?.name)).toEqual(['comic_safety_image', 'comic_safety_image', 'comic_safety_image', 'comic_safety_text']);
    for (const p of session.doc.pages) expect(p.render.asset?.safety).toMatchObject({ assessed: expect.any(String), by: 'check' });
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

  it('pre-filter-only mode (classifier off by the operator): clear text passes with no model call; an outage never does', async () => {
    resetSafety();
    fakes = installSafetyFakes({ classifier: false });
    const { doc, ctx } = await drawn({ pg_1: 'G', pg_2: 'G', pg_3: 'G' });
    const gate = await runPublishGate(ctx, doc, { ...ALL, includeCover: false });
    expect(gate.text.status).toBe('pass');
    expect(gate.status).toBe('cleared');
    expect(fakes.llm.calls).toHaveLength(0);
    resetSafety();
    fakes = installSafetyFakes({ llm: null });
    const again = await drawn({ pg_1: 'G', pg_2: 'G', pg_3: 'G' });
    expect((await runPublishGate(again.ctx, again.doc, { ...ALL, includeCover: false })).status).toBe('needs_check');
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

// ── S14 (A): a render-QC pass is re-rated image-only before it can be published ─────────────

const imageCalls = () => fakes.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_image');

describe('runPublishGate: QC verdicts are not trusted as-is (S14)', () => {
  it('a QC pass is re-rated image-only (no author text) and the stricter answer is committed by:"check"', async () => {
    const { doc, ctx, session } = await drawn({ pg_1: 'G', pg_2: 'G', pg_3: 'G' });
    fakes.llm.fallback = (req) => (req.jsonSchema?.name === 'comic_safety_image' ? { ...cleanAnswer(req), rating: 'X', categories: ['graphic_gore'] } : cleanAnswer(req));
    const gate = await runPublishGate(ctx, doc, { ...ALL, includeCover: false });
    expect(gate.status).toBe('blocked');
    expect(gate.pages.pg_1.status).toBe('blocked');
    expect(session.doc.pages[0].render.asset?.safety).toMatchObject({ assessed: 'X', categories: ['graphic_gore'], by: 'check' });
    expect(imageCalls()).toHaveLength(3);
    // Image-only: the author's script (panel actions, lines, looks) never reaches the re-rate.
    for (const call of imageCalls()) {
      const sent = JSON.stringify(call.messages);
      for (const authorText of ['Action 1.', 'Line on page', 'red scarf', 'Spice Run']) expect(sent).not.toContain(authorText);
    }
    expect(gate.costUsd).toBeGreaterThan(0);
    expect(ctx.billingFake.reserves).toEqual([]);
  });

  it('a QC pass that cannot be re-rated is unchecked (fail closed → needs_check)', async () => {
    const { doc, ctx } = await drawn({ pg_1: 'G', pg_2: 'G', pg_3: 'G' });
    fakes.llm.script.vision = [null, null, null];
    const gate = await runPublishGate(ctx, doc, { ...ALL, includeCover: false });
    for (const id of ['pg_1', 'pg_2', 'pg_3']) expect(gate.pages[id]).toEqual({ status: 'unchecked', reasons: ["Couldn't be checked right now"] });
    expect(gate.status).toBe('needs_check');
  });

  it('QC blocks and over-ratings are not re-checked; a re-rated page is not paid for again on the next publish', async () => {
    const { doc, ctx, session } = await drawn({ pg_1: 'X', pg_2: 'G', pg_3: 'G' });
    const first = await runPublishGate(ctx, doc, { ...ALL, includeCover: false });
    expect(first.pages.pg_1.status).toBe('blocked');
    expect(imageCalls()).toHaveLength(2); // pg_2 and pg_3 only
    await runPublishGate(ctx, session.doc, { ...ALL, includeCover: false });
    expect(imageCalls()).toHaveLength(2); // committed by:'check' verdicts are reused at $0
  });

  it('pre-filter-only operator mode keeps QC verdicts (no model calls at all)', async () => {
    resetSafety();
    fakes = installSafetyFakes({ classifier: false });
    const { doc, ctx } = await drawn({ pg_1: 'G', pg_2: 'G', pg_3: 'G' });
    const gate = await runPublishGate(ctx, doc, { ...ALL, includeCover: false });
    expect(gate.status).toBe('cleared');
    expect(fakes.llm.calls).toHaveLength(0);
  });
});

// ── S13: every character of the publishable text is read (windows, fail closed, hard cap) ────

const BENIGN = 'The courier runs through the bright market with a basket of warm spices and a smile. ';
const lineText = (id: string, len: number) => `${id}: ${BENIGN.repeat(Math.ceil(len / BENIGN.length))}`.slice(0, len).trim();

/** plannedDoc with `pages` drawn pages (image verdicts already checked, so only text is judged). */
function longDoc(pages: number, opts: { linesPerPanel?: number; lineLen?: number; at?: { offset: number; text: string } } = {}) {
  const doc = plannedDoc();
  const template = doc.pages[0];
  const perPanel = opts.linesPerPanel ?? 8;
  const len = opts.lineLen ?? 590;
  doc.pages = Array.from({ length: pages }, (_, i) => ({
    ...template,
    id: `pg_${i + 1}`,
    n: i + 1,
    panels: template.panels.map((pn, k) => ({
      ...pn,
      id: `pn_${i + 1}_${k + 1}`,
      lines: Array.from({ length: perPanel }, (_, j) => ({ id: `ln_${i + 1}_${k + 1}_${j}`, kind: 'speech' as const, speakerId: 'c_maya', text: lineText(`L${i + 1}.${k + 1}.${j}`, len) }))
    })),
    render: { ...emptyRender(), status: 'ready' as const, asset: { path: `u/user-1/p/proj-1/img/pg_${i + 1}.webp`, source: 'generated' as const, at: 1, safety: { assessed: 'G' as const, at: 1, by: 'check' as const } } }
  }));
  if (opts.at) {
    // Replace the line that sits at about `offset` characters into the publishable text.
    let seen = 0;
    outer: for (const p of doc.pages)
      for (const pn of p.panels)
        for (const l of pn.lines) {
          seen += l.text.length + 1;
          if (seen >= opts.at.offset) {
            l.text = opts.at.text;
            break outer;
          }
        }
  }
  const session = newSession(doc);
  const ctx = testContext(session);
  return { doc: session.doc, ctx, session, ids: doc.pages.map((p) => p.id) };
}

const textCalls = () => fakes.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_text');
const sentinelAnswer = (sentinel: string) => (req: Parameters<typeof cleanAnswer>[0]) =>
  req.jsonSchema?.name === 'comic_safety_text' && JSON.stringify(req.messages).includes(sentinel)
    ? { assessed: 'X', categories: ['harassment'], adaptable: false, suggestion: '', ip: [], spans: [] }
    : cleanAnswer(req);

describe('gateWindows', () => {
  it('short text is one window; long text is covered completely by overlapping windows of at most the size', () => {
    expect(gateWindows('hello\nworld')).toEqual(['hello\nworld']);
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} ${'x'.repeat(i % 90)}`);
    const text = lines.join('\n');
    const windows = gateWindows(text, 10_000, 500);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(10_000);
    // Every line is whole inside some window, and consecutive windows overlap.
    for (const l of lines) expect(windows.some((w) => w.split('\n').includes(l))).toBe(true);
    for (let i = 1; i < windows.length; i += 1) expect(text.indexOf(windows[i])).toBeLessThan(text.indexOf(windows[i - 1]) + windows[i - 1].length);
    expect(windows.at(-1)!.endsWith(lines.at(-1)!)).toBe(true);
  });

  it('a single huge line with no breaks is still covered (hard cuts, steady progress)', () => {
    const text = 'y'.repeat(100_000);
    const windows = gateWindows(text, 10_000, 500);
    expect(windows.every((w) => w.length <= 10_000)).toBe(true);
    expect(windows.length).toBeLessThan(15);
    expect(windows.reduce((n, w) => n + w.length, 0)).toBeGreaterThanOrEqual(text.length);
  });
});

describe('runPublishGate: the whole text is read (S13)', () => {
  it('a line far past the classifier sample still decides the verdict: every window is classified', async () => {
    const sentinel = 'SENTINEL-ZETA waves from the rooftop.';
    const { doc, ctx, ids } = longDoc(10, { at: { offset: 30_000, text: sentinel } });
    const words = publishableText(doc, []);
    expect(words.length).toBeGreaterThan(130_000);
    fakes.llm.fallback = sentinelAnswer('SENTINEL-ZETA');
    const gate = await runPublishGate(ctx, doc, { pageIds: ids, includeCover: false, languages: [] });
    expect(gate.text.status).toBe('blocked');
    expect(gate.status).toBe('blocked');
    expect(textCalls().length).toBeGreaterThanOrEqual(3);
    const sent = textCalls().map((c) => String(c.messages[1].content));
    expect(sent.some((s) => s.includes('[…]'))).toBe(false); // never the head/middle/tail sample
  });

  it('every line of a long comic reaches the classifier (no gaps)', async () => {
    const { doc, ctx, ids } = longDoc(10);
    const gate = await runPublishGate(ctx, doc, { pageIds: ids, includeCover: false, languages: [] });
    expect(gate.text.status).toBe('pass');
    const sent = textCalls().map((c) => String(c.messages[1].content)).join('\n');
    for (const p of doc.pages) for (const pn of p.panels) for (const l of pn.lines) expect(sent).toContain(l.text);
    expect(gate.costUsd).toBeGreaterThan(0);
  });

  it('one window that cannot be checked leaves the whole text unchecked (fail closed)', async () => {
    const { doc, ctx, ids } = longDoc(10);
    fakes.llm.script.safety = [{ assessed: 'G', categories: [], adaptable: true, suggestion: '', ip: [], spans: [] }, null];
    const gate = await runPublishGate(ctx, doc, { pageIds: ids, includeCover: false, languages: [] });
    expect(gate.text.status).toBe('unchecked');
    expect(gate.status).toBe('needs_check');
  });

  it('pre-filter-only mode reads past 200k characters', async () => {
    resetSafety();
    fakes = installSafetyFakes({ classifier: false });
    const clean = longDoc(18);
    expect(publishableText(clean.doc, []).length).toBeGreaterThan(240_000);
    expect((await runPublishGate(clean.ctx, clean.doc, { pageIds: clean.ids, includeCover: false, languages: [] })).text.status).toBe('pass');
    const dirty = longDoc(18, { at: { offset: 236_000, text: `You are a ${expand('<SLUR>')}.` } });
    const gate = await runPublishGate(dirty.ctx, dirty.doc, { pageIds: dirty.ids, includeCover: false, languages: [] });
    expect(gate.text.status).toBe('blocked');
    expect(fakes.llm.calls).toHaveLength(0);
  });

  it('a verdict cached from a sampled read of long text is not reused', async () => {
    const sentinel = 'SENTINEL-ZETA waves from the rooftop.';
    const { doc, ctx, session, ids } = longDoc(10, { at: { offset: 30_000, text: sentinel } });
    const rating = ratingOf(ctx, doc);
    const oldHash = sha256Hex(`${rating}\n${publishableText(doc, [])}`).slice(0, 16);
    session.commit([{ op: 'safety', patch: { text: { hash: oldHash, assessed: 'G', categories: [], at: 1 } } }]);
    fakes.llm.fallback = sentinelAnswer('SENTINEL-ZETA');
    const gate = await runPublishGate(ctx, session.doc, { pageIds: ids, includeCover: false, languages: [] });
    expect(textCalls().length).toBeGreaterThan(0);
    expect(gate.text.status).toBe('blocked');
  });

  it('text past the cap is refused honestly (409 LIMIT) before any check is paid for', async () => {
    const { doc, ctx, ids } = longDoc(20, { linesPerPanel: 30, lineLen: 600 });
    expect(publishableText(doc, []).length).toBeGreaterThan(MAX_GATE_TEXT_CHARS);
    doc.pages[0].render.asset!.safety = undefined; // an unchecked page would otherwise be paid for
    const err = await runPublishGate(ctx, doc, { pageIds: ids, includeCover: false, languages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ code: 'LIMIT', status: 409 });
    expect(err.userMessage).toMatch(/more words than the safety check can read/);
    expect(fakes.llm.calls).toHaveLength(0);
  });
});
