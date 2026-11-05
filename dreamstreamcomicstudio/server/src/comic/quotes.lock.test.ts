// @vitest-environment node
// Lock-aware quotes at the source (models.md §3.4 item 1): shared/comic/plan.ts quoteRenderPages, unitPrice and
// estimateDocJobs price on the comic's locked model — the persisted lock, else the legacy migration lock — so the
// breakdown card and tool, every next-step chip and the $0 intents quote what the server will really draw, with
// no call-site change. The expected prices below are computed from the registry with an EXPLICIT lock, never through
// the helpers under test, so each assertion fails if the helpers ignore the lock.
import { describe, expect, it } from 'vitest';
import { pageSpecHash, type ComicDoc, type ImageModelLock, type RefAsset } from '../../../shared/comic/doc.js';
import { estimateJobs, formatUsd, getImageModel, type ImageJobKind } from '../../../shared/comic/models.js';
import { estimateDocJobs, quoteLockOf, quoteRenderPages, summarizeBook, unitPrice } from '../../../shared/comic/plan.js';
import { sheetRefs } from '../../../shared/comic/refRanking.js';
import { overlayFix, textlessCoverQuote } from './i18n/index.js';
import { routeIntent } from './intents.js';
import { estimateSpendAction, nextStepsFor } from './jobs.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { nothingNextSteps, retryNextSteps } from './replies.js';
import { createDirectorTurn } from './tools.js';
import { breakdownText, breakdownToolGroup } from './tools/breakdown.js';
import { refsLine } from './tools/refs.js';
import { numberRanges } from './refs/addRefs.js';
import { pageAspectForDoc } from './vision.js';
import { writerSystemPrompt } from './writer.js';

const PRO: ImageModelLock = { modelId: 'nano-banana-pro', lockedAt: 1, origin: 'user_change' };
const PRO_NAME = getImageModel('nano-banana-pro')!.nickname;

/** Registry price on Nano Banana Pro at the doc's tier (the tier picks the resolution), and unlocked. */
const pro = (doc: ComicDoc, jobs: { kind: ImageJobKind; count: number }[], byok = false) => estimateJobs(jobs, doc.settings.quality, { byok, lock: PRO }).usd;
const unlocked = (doc: ComicDoc, jobs: { kind: ImageJobKind; count: number }[], byok = false) =>
  estimateJobs(jobs, doc.settings.quality, { byok, override: doc.settings.imageModelOverride }).usd;

/** A Standard-tier comic switched to Nano Banana Pro: 3 planned pages, nothing drawn, no sheets. */
const proLocked = (): ComicDoc => {
  const doc = plannedDoc();
  doc.imageModel = { ...PRO };
  doc.planStatus = 'approved';
  return doc;
};

/** A legacy comic (no persisted lock) whose page 1 was drawn on Nano Banana Pro: deriveLock makes it Pro. */
const legacyPro = (): ComicDoc => {
  const doc = plannedDoc();
  doc.planStatus = 'approved';
  const p1 = doc.pages[0];
  p1.render = { status: 'ready', history: [], model: 'nano-banana-pro', asset: { path: 'u/x/p1.webp', source: 'generated', at: 5, model: 'nano-banana-pro', w: 800, h: 1200 }, specHash: pageSpecHash(doc, p1) };
  return doc;
};

describe('lock-aware quotes at the source (shared/comic/plan.ts)', () => {
  it('the fixture really is priced differently on Pro (otherwise these tests prove nothing)', () => {
    const doc = proLocked();
    expect(doc.settings.quality).toBe('standard');
    expect(pro(doc, [{ kind: 'page', count: 1 }])).toBeGreaterThan(2 * unlocked(doc, [{ kind: 'page', count: 1 }]));
  });

  it('quoteRenderPages and unitPrice price a Pro-locked comic on Pro with no extra argument', () => {
    const doc = proLocked();
    const q = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
    expect(q.pageIds).toHaveLength(3);
    expect(q.sheetIds).toHaveLength(2);
    expect(q.usd).toBe(pro(doc, [{ kind: 'page', count: 3 }, { kind: 'sheet', count: 2 }]));
    expect(q.model).toBe(PRO_NAME);
    for (const kind of ['page', 'cover', 'sheet', 'edit'] as const) {
      expect(unitPrice(doc, kind, { byok: false })).toEqual({ usd: pro(doc, [{ kind, count: 1 }]), model: PRO_NAME });
      expect(unitPrice(doc, kind, { byok: true }).usd).toBe(pro(doc, [{ kind, count: 1 }], true));
    }
    // A tier change only picks the resolution: Pro is still the model.
    expect(unitPrice(doc, 'page', { byok: false, tier: 'draft' }).model).toBe(PRO_NAME);
    // An explicit null lock prices the unlocked tier model (a what-if; nothing calls it that way by default).
    expect(unitPrice(doc, 'page', { byok: false, lock: null }).usd).toBe(unlocked(doc, [{ kind: 'page', count: 1 }]));
    expect(estimateDocJobs(doc, [{ kind: 'style_option', count: 3 }], { byok: false }).usd).toBe(pro(doc, [{ kind: 'style_option', count: 3 }]));
  });

  it('a legacy comic drawn on Pro derives its lock and quotes Pro too', () => {
    const doc = legacyPro();
    expect(doc.imageModel).toBeUndefined();
    expect(quoteLockOf(doc)?.modelId).toBe('nano-banana-pro');
    const q = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality });
    expect(q.pageIds).toEqual(['pg_2', 'pg_3']);
    expect(q.usd).toBe(pro(doc, [{ kind: 'page', count: 2 }, { kind: 'sheet', count: 2 }]));
  });

  it('the server gate and the shared quote agree on a locked comic (one price everywhere)', () => {
    const doc = proLocked();
    const gate = estimateSpendAction(doc, { type: 'render_pages' }, false);
    expect(gate.usd).toBe(quoteRenderPages(doc, { byok: false, tier: doc.settings.quality }).usd);
    expect(estimateSpendAction(doc, { type: 'render_cover' }, false).usd).toBe(unitPrice(doc, 'cover', { byok: false }).usd);
  });
});

describe('breakdown card and tool on a Pro-locked comic', () => {
  it('summarizeBook (what the breakdown card renders) prices pages, the cover and "Render all" on Pro', () => {
    const doc = proLocked();
    const s = summarizeBook(doc, { byok: false });
    expect(s.pricing).toMatchObject({ model: PRO_NAME, pageUsd: pro(doc, [{ kind: 'page', count: 1 }]), coverUsd: pro(doc, [{ kind: 'cover', count: 1 }]), locked: true });
    expect(s.pages.map((p) => p.quoteUsd)).toEqual(Array(3).fill(pro(doc, [{ kind: 'page', count: 1 }])));
    expect(s.cover.quoteUsd).toBe(pro(doc, [{ kind: 'cover', count: 1 }]));
    expect(s.totals.toDrawUsd).toBe(pro(doc, [{ kind: 'page', count: 3 }, { kind: 'sheet', count: 2 }]));
    expect(s.moments?.addPageUsd).toBe(pro(doc, [{ kind: 'page', count: 1 }]));
  });

  it('the director breakdown text, summary line and quote tool name Pro and its price', async () => {
    const doc = proLocked();
    const all = pro(doc, [{ kind: 'page', count: 3 }, { kind: 'sheet', count: 2 }]);
    const text = breakdownText(doc, summarizeBook(doc, { byok: false }), { subset: false, byok: false });
    expect(text).toContain(`Not drawn: pages 1–3 (≈${formatUsd(all)} incl. 2 character sheets, ${PRO_NAME}).`);
    expect(text).toContain(`cover not drawn (≈${formatUsd(pro(doc, [{ kind: 'cover', count: 1 }]))})`);
    expect(breakdownToolGroup.summaryLines?.(doc, createDirectorTurn())[0]).toContain(`to draw now: pages 1–3 ≈${formatUsd(all)}`);
    const ctx = testContext(newSession(doc));
    const quote = breakdownToolGroup.tools(ctx, createDirectorTurn()).find((t) => t.spec.function.name === 'quote')!;
    expect(await quote.execute({ action: 'render_pages' })).toContain(`≈${formatUsd(all)} to draw 3 pages + 2 character sheets (pages 1–3) on ${PRO_NAME}`);
  });
});

describe('next-step chips on a Pro-locked comic', () => {
  it('"everything is drawn" chips: the cover and a new take are quoted on Pro', () => {
    const doc = proLocked();
    doc.pages = [doc.pages[0]];
    const steps = nothingNextSteps(doc, false);
    expect(steps.find((s) => s.label === 'Make the cover')).toMatchObject({ usd: pro(doc, [{ kind: 'cover', count: 1 }]), action: { type: 'render_cover', quotedUsd: pro(doc, [{ kind: 'cover', count: 1 }]) } });
    expect(steps.find((s) => s.label === 'New take of page 1')?.usd).toBe(pro(doc, [{ kind: 'page', count: 1 }]));
  });

  it('"Try again" chips after a failure are quoted on Pro (pages, sheets, cover, style options)', () => {
    const doc = proLocked();
    doc.style = { ...doc.style, options: [{ id: 'opt_a', name: 'Inky', spec: 'Heavy blacks', render: { status: 'failed', history: [] } }] };
    const steps = retryNextSteps(
      doc,
      [
        { kind: 'page', id: 'pg_1' },
        { kind: 'page', id: 'pg_2' },
        { kind: 'sheet', id: 'c_maya' },
        { kind: 'cover' },
        { kind: 'style_option', id: 'opt_a' }
      ],
      false
    );
    expect(steps.find((s) => s.label === 'Try the pages again')?.usd).toBe(pro(doc, [{ kind: 'page', count: 2 }]));
    expect(steps.find((s) => s.label === 'Try the sheets again')?.usd).toBe(pro(doc, [{ kind: 'sheet', count: 1 }]));
    expect(steps.find((s) => s.label === 'Try the cover again')?.usd).toBe(pro(doc, [{ kind: 'cover', count: 1 }]));
    expect(steps.find((s) => s.label === 'Try again')?.usd).toBe(pro(doc, [{ kind: 'style_option', count: 1 }]));
    // BYOK chips are the provider price on Pro.
    expect(retryNextSteps(doc, [{ kind: 'page', id: 'pg_1' }], true)[0].usd).toBe(pro(doc, [{ kind: 'page', count: 1 }], true));
  });

  it('the doc-state chips (jobs.ts nextStepsFor) quote "Draw all pages" on Pro', () => {
    const doc = proLocked();
    const draw = nextStepsFor(doc).find((s) => s.label === 'Draw all pages');
    expect(draw?.usd).toBe(pro(doc, [{ kind: 'page', count: 3 }, { kind: 'sheet', count: 2 }]));
  });
});

describe('$0 intents on a Pro-locked comic', () => {
  it('"how much will it cost?" quotes what is left on Pro, and its chips are Pro-priced', () => {
    const doc = legacyPro();
    const routed = routeIntent(doc, 'how much will it cost?');
    const left = pro(doc, [{ kind: 'page', count: 2 }, { kind: 'sheet', count: 2 }, { kind: 'cover', count: 1 }]);
    expect(routed?.reply).toContain(`is about ${formatUsd(left)}.`);
    const draw = routed?.nextSteps?.find((s) => s.label === 'Draw 2 pages');
    expect(draw?.usd).toBe(pro(doc, [{ kind: 'page', count: 2 }, { kind: 'sheet', count: 2 }]));
    // A page is drawn and the cover is not: the cover chip is quoted on Pro too.
    expect(routed?.nextSteps?.find((s) => s.label === 'Make the cover')?.usd).toBe(pro(doc, [{ kind: 'cover', count: 1 }]));
  });

  it('"what\'s left?" chips are Pro-priced; nothing left to draw offers a Pro-priced cover', () => {
    const doc = legacyPro();
    expect(routeIntent(doc, "what's left?")?.nextSteps?.find((s) => s.label === 'Draw 2 pages')?.usd).toBe(pro(doc, [{ kind: 'page', count: 2 }, { kind: 'sheet', count: 2 }]));
    const done = legacyPro();
    done.pages = [done.pages[0]];
    const routed = routeIntent(done, 'draw all the pages');
    expect(routed?.kind).toBe('nothing_to_draw');
    expect(routed?.nextSteps?.find((s) => s.label === 'Make the cover')?.usd).toBe(pro(done, [{ kind: 'cover', count: 1 }]));
  });
});

// A7 wave note 1: the server's own call sites that still resolved the tier/override model. Each one now asks the
// comic's lock (quoteLockOf) first, exactly as the runner and the prompt compiler do.
describe('server call sites resolve the locked model (A7 note 1)', () => {
  it('i18n: the overlay-lettering redraw and the textless cover are quoted on the locked model', () => {
    const doc = legacyPro();
    doc.format = { ...doc.format, lettering: 'in_art' };
    doc.pages[0].panels[1].lines = [{ id: 'ln_x', kind: 'speech', speakerId: 'c_maya', text: 'Hello there.' }];
    doc.cover = { ...doc.cover, lettering: 'in_art', render: { status: 'ready', history: [], model: 'nano-banana-pro', asset: { path: 'u/x/cover.webp', source: 'generated', at: 6, model: 'nano-banana-pro' } } };
    const fix = overlayFix(doc, false)!;
    expect(fix.pages).toEqual(['pg_1']);
    expect(fix.usd).toBe(pro(doc, [{ kind: 'page', count: 1 }]));
    expect(fix.usd).toBeGreaterThan(unlocked(doc, [{ kind: 'page', count: 1 }]));
    expect(overlayFix(doc, true)!.usd).toBe(pro(doc, [{ kind: 'page', count: 1 }], true));
    expect(textlessCoverQuote(doc, false)).toBe(pro(doc, [{ kind: 'cover', count: 1 }]));
  });

  it('writer: the per-page cast limit is the locked model’s character slots', () => {
    const slotsLine = (doc: ComicDoc) => /At most (\d+) recurring named characters/.exec(writerSystemPrompt(doc))?.[1];
    expect(slotsLine(plannedDoc())).toBe(String(getImageModel('nano-banana-2.1')!.refs.characters));
    expect(slotsLine(proLocked())).toBe(String(getImageModel('nano-banana-pro')!.refs.characters));
    expect(getImageModel('nano-banana-pro')!.refs.characters).not.toBe(getImageModel('nano-banana-2.1')!.refs.characters);
  });

  it('vision: an unsized page is estimated at the shape the locked model draws', () => {
    const webtoon = (lock?: ImageModelLock): ComicDoc => {
      const doc = plannedDoc();
      doc.format = { ...doc.format, kind: 'webtoon', pageAspect: '2:3' };
      doc.pages[0].panels = [...doc.pages[0].panels, { ...doc.pages[0].panels[2], id: 'pn_1_4', n: 4 }];
      if (lock) doc.imageModel = { ...lock };
      return doc;
    };
    const free = webtoon();
    expect(pageAspectForDoc(free, free.pages[0])).toBeCloseTo(1 / 4, 6);
    // Nano Banana Pro has no 1:4: a Pro-locked webtoon is drawn 9:16, so its balloons are sized for 9:16.
    const locked = webtoon(PRO);
    expect(pageAspectForDoc(locked, locked.pages[0])).toBeCloseTo(9 / 16, 6);
  });

  it('refs tool: the photos a sheet would use follow the locked model’s character slots', () => {
    const withPhotos = (lock?: ImageModelLock): ComicDoc => {
      const doc = plannedDoc();
      doc.cast[0].refs = [1, 2, 3, 4, 5].map((i): RefAsset => ({ path: `u/x/ref${i}.webp`, source: 'upload', at: i }));
      if (lock) doc.imageModel = { ...lock };
      return doc;
    };
    const would = (doc: ComicDoc, slots: number) => {
      const c = doc.cast[0];
      return ` — no sheet yet (would use ${numberRanges(sheetRefs(c, slots).map((r) => c.refs.indexOf(r) + 1))})`;
    };
    const free = withPhotos();
    expect(refsLine(free, free.cast[0].refs, free.cast[0]).endsWith(would(free, 4))).toBe(true);
    // A legacy comic locked to Nano Banana (2 character slots) draws its sheet from 2 photos, not the tier model's 4.
    const legacy = withPhotos({ modelId: 'nano-banana-legacy', lockedAt: 1, origin: 'migrated' });
    expect(getImageModel('nano-banana-legacy')!.refs.characters).toBe(2);
    expect(refsLine(legacy, legacy.cast[0].refs, legacy.cast[0]).endsWith(would(legacy, 2))).toBe(true);
    expect(would(legacy, 2)).not.toBe(would(free, 4));
  });
});
