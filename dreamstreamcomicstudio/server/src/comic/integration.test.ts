// @vitest-environment node
// Cross-feature integration (P2-SERVER, buildplan §3): one comic walks the whole studio with every
// seam REAL — director tools, the job runner, vision/letterer, the safety module (a fake platform
// classifier), the publication module (in-memory store), translation (a scripted translator and
// linguist) — and fakes only at the network edge (image model, text model, storage). $0, offline.
//
//   message → plan (breakdown) → draw (gate, ordering) → nothing-to-draw → publish (gate) →
//   slug payload → translate → localized snapshot
//
// plus fit_render end to end and the governed-cost wording (no dollars for governed users).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { pageSpecHash, type ComicDoc, type Msg } from '../../../shared/comic/doc.js';
import { editionReadiness, localizeDoc } from '../../../shared/comic/i18n.js';
import { SLUG_RE } from '../../../shared/comic/publication.js';
import { runDirectorTurn } from './director.js';
import { routeIntent } from './intents.js';
import { JOB_TIMINGS, estimateSpendAction, startAction } from './jobs.js';
import { estimateTranslation } from './i18n/index.js';
import { fakeLinguist, fakeTranslator, times } from './i18n/testing.js';
import { newSession, plannedDoc, scriptedLlm, testContext, type ScriptStep, type TestContext } from './orchestrator.fakes.js';
import { configurePublication, createMemoryPublicationStore, type MemoryPublicationStore } from './publication/index.js';
import { installSafetyFakes, resetSafety } from './safety/testkit.js';
import { writePagePlan } from './writer.js';

vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, writePagePlan: vi.fn(actual.writePagePlan) };
});

const TIMINGS = { ...JOB_TIMINGS };
let restorePublication: (() => void) | undefined;

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  restorePublication?.();
  restorePublication = undefined;
  resetSafety();
  vi.mocked(writePagePlan).mockReset();
  vi.restoreAllMocks();
});

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: JSON.stringify(args) });

/** The story before planning: brief, cast and a place; no pages; confirmations on ('big'), pages 2:3. */
const storyDoc = (): ComicDoc => {
  const doc = plannedDoc('proj-int');
  doc.pages = [];
  doc.planStatus = 'none';
  doc.format = { ...doc.format, pageAspect: '2:3', pageCount: 3 };
  doc.settings = { ...doc.settings, confirm: 'big', bigSpendUsd: 0.5 };
  return doc;
};

const lastAssistant = (doc: ComicDoc): Msg => [...doc.conversation].reverse().find((m) => m.role === 'assistant')!;
const imageKinds = (ctx: TestContext) =>
  ctx.events.flatMap((e) => (e.type === 'ops' ? e.ops : [])).flatMap((op) => (op.op === 'spend' && typeof op.entry.target === 'string' && op.entry.usd > 0 ? [op.entry.label] : []));

describe('message → plan → draw → nothing → publish → slug → translate → localized snapshot', () => {
  it('walks the whole studio on the real seams, in order, honestly, and never spends on a finished book', async () => {
    const safety = installSafetyFakes();
    const store: MemoryPublicationStore = createMemoryPublicationStore();
    restorePublication = configurePublication({
      store,
      now: () => 1_900_000_000_000,
      renderOg: async () => ({ jpeg: Buffer.from('og'), w: 1200 as const, h: 630 as const, themeColor: '#123456' }),
      publicUrl: (p) => `https://cdn.test/${p}`
    });
    // The writer returns the 3-page plan (the plannedDoc pages), deterministically.
    vi.mocked(writePagePlan).mockImplementation(async () => ({ pages: plannedDoc('proj-int').pages, newCast: [], model: 'fake-writer' }));
    const tr = fakeTranslator();
    const director: ScriptStep[] = [
      // Turn 1: "plan it" → plan_pages (TEXT), the breakdown card rides the reply.
      { toolCalls: [toolCall('a1', 'plan_pages')] },
      { text: "Here's the plan — 3 pages. Have a look on the board." },
      // Turn 2: "draw it" → render_pages: the plan is a draft, so the user sees the quote first.
      { toolCalls: [toolCall('b1', 'render_pages', { include_cover: true })] },
      { text: 'Here is the quote — tap Approve to draw.' }
    ];
    const llm = scriptedLlm({ director, translator: times(8, tr.step), linguist: times(6, fakeLinguist()) });
    const session = newSession(storyDoc());
    store.seedProject(session.doc.id, session.userId);
    const ctx = testContext(session, { llm });

    // ── 1. message → plan (breakdown) ──
    await runDirectorTurn(ctx, { text: 'plan it', attachments: [] });
    expect(vi.mocked(writePagePlan)).toHaveBeenCalledTimes(1);
    expect(session.doc.pages.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(session.doc.planStatus).toBe('draft');
    expect(session.doc.planInputHash).toMatch(/\S/); // R5 persisted (plan_input_hash op), survives a reload
    const planReply = lastAssistant(session.doc);
    expect(planReply.text).toMatch(/plan/i);
    expect(planReply.cards?.some((c) => c.type === 'breakdown' && c.view === 'plan')).toBe(true);
    expect(ctx.imagesFake.calls).toHaveLength(0);

    // ── 2. draw: quoted first (plan_review), the breakdown sits above the gate card ──
    await runDirectorTurn(ctx, { text: 'draw it', attachments: [] });
    const gate = session.doc.gate!;
    expect(gate).toMatchObject({ status: 'open', reason: 'plan_review', action: { type: 'render_pages', includeCover: true } });
    const gateReply = lastAssistant(session.doc);
    const types = (gateReply.cards || []).map((c) => c.type);
    expect(types.indexOf('breakdown')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('breakdown')).toBeLessThan(types.indexOf('gate'));
    expect(ctx.imagesFake.calls).toHaveLength(0); // nothing drawn before the tap

    // Approve → sheets first, then page 1 alone (the continuity anchor), then the rest + the cover.
    const approved = await startAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true, origin: 'user' });
    await approved.done;
    await ctx.settled();
    const drawn = imageKinds(ctx);
    expect(drawn).toEqual(expect.arrayContaining(['Sheet: Maya', 'Sheet: Arjun', 'Page 1', 'Page 2', 'Page 3', 'Cover']));
    const at = (label: string) => drawn.indexOf(label);
    expect(Math.max(at('Sheet: Maya'), at('Sheet: Arjun'))).toBeLessThan(at('Page 1'));
    for (const later of ['Page 2', 'Page 3', 'Cover']) expect(at('Page 1')).toBeLessThan(at(later));
    expect(session.doc.planStatus).toBe('approved');
    expect(session.doc.pages.every((p) => p.render.status === 'ready' && p.render.asset?.safety?.assessed === 'G')).toBe(true);
    // Every page is lettered (balloons placed even though the fake vision reply was unusable).
    expect(session.doc.pages.every((p) => p.balloons.length === 1)).toBe(true);
    const imagesAfterDraw = ctx.imagesFake.calls.length;
    expect(imagesAfterDraw).toBe(6);

    // ── 3. nothing to draw: "draw everything" again is $0 with the book's status ──
    const spentBefore = session.doc.spend.totalUsd;
    const again = await startAction(ctx, { type: 'render_pages', includeCover: true }, { confirmed: true, origin: 'user' });
    expect(again.outcome.status).toBe('nothing');
    expect(lastAssistant(session.doc).cards?.[0]).toMatchObject({ type: 'breakdown', view: 'status' });
    expect(routeIntent(session.doc, 'generate all pages')).toMatchObject({ kind: 'nothing_to_draw' });
    expect(ctx.imagesFake.calls).toHaveLength(imagesAfterDraw);
    expect(session.doc.spend.totalUsd).toBe(spentBefore);

    // ── 4. publish (the real safety gate, the fake classifier says G) → 5. slug payload ──
    const published = await startAction(ctx, { type: 'publish', request: { visibility: 'unlisted' } }, { confirmed: false, origin: 'user' });
    expect(published.outcome.status).toBe('done');
    expect(published.outcome.message).toMatch(/^Published!/);
    const slug = session.doc.publication?.slug;
    expect(slug && SLUG_RE.test(slug)).toBe(true);
    expect(safety.llm.calls.length).toBeGreaterThan(0); // the platform classifier really ran (text + images)
    const payload = store.rpcPayload(slug!);
    expect(payload?.doc?.pages.map((p) => p.n)).toEqual([1, 2, 3]);
    for (const k of ['conversation', 'spend', 'source', 'memory']) {
      const v = (payload!.doc as unknown as Record<string, unknown>)[k];
      expect(!v || (Array.isArray((v as { entries?: unknown[] }).entries) ? (v as { entries: unknown[] }).entries.length === 0 : Array.isArray(v) ? v.length === 0 : typeof v !== 'string' || !v), k).toBe(true);
    }
    // Readers get publication copies only (pub/…), never the studio's private paths.
    const paths = (payload!.doc!.pages || []).map((p) => p.render.asset?.path || '');
    expect(paths.every((p) => p.startsWith('pub/'))).toBe(true);

    // ── 6. translate (a click with its quote) → reviewed edition ──
    const est = await estimateTranslation(ctx, { type: 'translate', languages: ['te'] });
    const tl = await startAction(ctx, { type: 'translate', languages: ['te'], quotedUsd: est.usd }, { confirmed: true, origin: 'user' });
    await tl.done;
    await ctx.settled();
    expect(editionReadiness(session.doc, 'te')).toMatchObject({ publishable: true });

    // ── 7. localized snapshot: "Update" with the Telugu edition; the reader's ?lang=te is Telugu ──
    const updated = await startAction(ctx, { type: 'publish', request: { visibility: 'unlisted', languages: ['en', 'te'] } }, { confirmed: false, origin: 'user' });
    expect(updated.outcome.message).toMatch(/^Updated — readers now see your latest version/);
    expect(session.doc.publication?.slug).toBe(slug); // same link, new snapshot
    const localized = localizeDoc(store.rpcPayload(slug!)!.doc!, 'te');
    const line = localized.pages[0].panels[1].lines[0];
    expect(line.text).toBe(session.doc.i18n!.editions.te.lines[line.id].text);
    expect(line.text).not.toBe('Line on page 1');
    // No image was drawn after the book was finished; the whole walk never touched a real network.
    expect(ctx.imagesFake.calls).toHaveLength(imagesAfterDraw);
  });
});

describe('fit_render end to end (free, QC once)', () => {
  it('a square page gets an honest notice + a free Fit chip; the fit is a $0 derived version lettered from the stored QC', async () => {
    const doc = plannedDoc('proj-fit');
    doc.format = { ...doc.format, pageAspect: '2:3' };
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', history: [], asset: { path: `u/user-1/p/proj-fit/img/${c.id}.webp`, source: 'generated', at: 1, w: 1536, h: 1024 } } }));
    doc.planStatus = 'approved';
    const session = newSession(doc);
    const ctx = testContext(session);
    // The image model returns a SQUARE page.
    ctx.assetsFake.generatedSize = { w: 1024, h: 1024 };
    const drawn = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], quotedUsd: estimateSpendAction(session.doc, { type: 'render_pages', pageIds: ['pg_1'] }, false).usd }, { confirmed: true, origin: 'user' });
    await drawn.done;
    await ctx.settled();
    const done = lastAssistant(session.doc);
    expect(done.text).toMatch(/came back 1:1 instead of 2:3/);
    const fit = done.nextSteps?.find((s) => s.action?.type === 'fit_render');
    expect(fit).toMatchObject({ label: 'Fit to 2:3 (Free)', usd: 0 });
    const visionCalls = ctx.llmFake.calls.filter((c) => c.role === 'vision').length;
    const spent = session.doc.spend.totalUsd;
    const before = session.doc.pages[0].render.asset!.path;

    // Tap "Fit to 2:3 (Free)": a derived version, $0, the original kept in history, no AI call.
    const fitted = await startAction(ctx, fit!.action!, { confirmed: false, origin: 'user' });
    await fitted.done;
    await ctx.settled();
    const page = session.doc.pages[0];
    expect(page.render.asset?.path).not.toBe(before);
    expect(page.render.asset?.source).toBe('derived');
    expect(page.render.history.some((h) => h.path === before)).toBe(true);
    expect(page.render.specHash).toBe(pageSpecHash(session.doc, page)); // QC once: still current, not stale
    expect(session.doc.spend.totalUsd).toBe(spent);
    expect(ctx.llmFake.calls.filter((c) => c.role === 'vision')).toHaveLength(visionCalls);
    expect(ctx.imagesFake.calls).toHaveLength(1);
    expect(page.balloons.length).toBe(1); // re-lettered for free
  });
});

describe('governed users never read dollars (P1-LIMITS)', () => {
  const governed: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 80, exhausted: false, pctPerStandardPage: 1.2 } };

  it('the gate, the run messages and the director summary speak in usage; admins and own keys see prices', async () => {
    const doc = plannedDoc('proj-gov');
    doc.planStatus = 'approved';
    doc.settings = { ...doc.settings, confirm: 'always' };
    const session = newSession(doc);
    const ctx = testContext(session, { caps: governed });
    const gated = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: false, origin: 'user' });
    expect(gated.outcome.status).toBe('gated');
    const texts = [gated.outcome.message, session.doc.gate!.summary, ...session.doc.conversation.map((m) => m.text)];
    for (const t of texts) expect(t).not.toMatch(/\$/);
    expect(session.doc.gate!.summary).toMatch(/% of your usage/);
    // The same quote for an admin is in dollars.
    const admin = newSession(plannedDoc('proj-adm'));
    const actx = testContext(admin, { caps: { ...DEFAULT_CAPS, admin: true } });
    admin.commit([{ op: 'settings', patch: { confirm: 'always' } }, { op: 'plan_status', status: 'approved' }]);
    await startAction(actx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: false, origin: 'user' });
    expect(admin.doc.gate!.summary).toMatch(/≈ \$\d/);
  });
});
