// @vitest-environment node
// M1-DIRECTOR-MODELS (models.md §3.8, §3.4 #6; reliability.md §2 Director): the director suggests image models
// with real numbers and never switches. Fakes only: the merged catalog over the public 17:51Z OpenRouter fixture,
// the fake model-health port, scripted model replies. No network, $0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStudioCaps, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import { emptyRender, type ComicDoc } from '../../../../shared/comic/doc.js';
import { getImageModel } from '../../../../shared/comic/models.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { makeLakeComic, LAKE_NOW } from '../../../../shared/comic/__fixtures__/lakeComic.js';
import { costFormatter, costViewFor, DOLLAR_VIEW } from '../costText.js';
import { JOB_TIMINGS } from '../jobs.js';
import { FAKE_BASE, FIXTURE_NOW, fakeOpenRouterFetch, memoryCatalogStore } from '../models/__fixtures__/catalogFakes.js';
import { fakeModelHealth } from '../models/health.fakes.js';
import { createModelCatalog, createQualitySource, setModelCatalog, type ModelCatalog } from '../models/index.js';
import { newSession, plannedDoc, testContext, type TestContext } from '../orchestrator.fakes.js';
import { buildDirectorTools, createDirectorTurn, type DirectorTool, type DirectorTurn } from '../tools.js';
import type { StudioKeys } from '../types.js';
import { toolGroupById } from './index.js';
import {
  falseSwitchClaims,
  guardModelReply,
  modelAdviceOf,
  modelAdviceReply,
  modelFactLines,
  modelStatusLine,
  modelsToolGroup,
  outageCardText,
  recentOutageCard,
  resolveModelName,
  upstreamStreak,
  type OutageCard
} from './models.js';

let ctx: TestContext;
let turn: DirectorTurn;
let tools: Map<string, DirectorTool>;
let ops: DocOp[];
const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args);

/** A paying user on their own key: dollars are shown, Nano Banana Pro is allowed, no markup (models.md §3.5 example 1). */
const BYOK_CAPS: StudioCaps = resolveStudioCaps({ planId: 'free', byok: true, isAdmin: false });
const BYOK_KEYS: StudioKeys = { openrouter: { key: 'sk-or-user-test', byok: true } };
/** A governed user (platform key, usage shown as a share): never a dollar sign. */
const GOVERNED_CAPS: StudioCaps = { ...resolveStudioCaps({ planId: 'creator', byok: false, isAdmin: false }), usage: { governed: true, pctLeft: 60, exhausted: false, pctPerStandardPage: 1 } };

const setup = (doc: ComicDoc, userText = 'the user message', opts: { caps?: StudioCaps; keys?: StudioKeys } = {}) => {
  ctx = testContext(newSession(doc), { ...(opts.caps ? { caps: opts.caps } : {}), ...(opts.keys ? { keys: opts.keys } : {}) });
  ops = [];
  ctx.session.subscribe((e) => {
    if (e.type === 'ops') ops.push(...e.ops);
  });
  turn = createDirectorTurn({ userText });
  tools = new Map([...buildDirectorTools(ctx, turn), ...modelsToolGroup.tools(ctx, turn)].map((t) => [t.spec.function.name, t]));
};

/** The merged catalog (M1-CATALOG) over the public 17:51Z OpenRouter fixture: no network, no database. */
const fixtureCatalog = (over: Partial<Parameters<typeof createModelCatalog>[0]> = {}): ModelCatalog =>
  createModelCatalog({ fetch: fakeOpenRouterFetch(), store: memoryCatalogStore(), baseUrl: FAKE_BASE, now: () => FIXTURE_NOW, quality: createQualitySource({ fetch: null }), ...over });

/** The lake comic (models.md §3.5 example 1): 4:5, Draft, 5 pages + 4 sheets + cover on Nano Banana 2.1. */
const lakeLocked = (mutate?: (d: ComicDoc) => void) =>
  makeLakeComic((d) => {
    d.imageModel = { modelId: 'nano-banana-2.1', lockedAt: LAKE_NOW - 2_900_000, origin: 'first_render' };
    mutate?.(d);
  });

const outageCard = (over: Partial<OutageCard> = {}): OutageCard => ({
  type: 'model_outage',
  id: 'card_out_1',
  modelId: 'nano-banana-2.1',
  options: [
    { kind: 'wait_and_retry', etaHint: 'about 2 min' },
    { kind: 'switch_model', modelId: 'nano-banana-pro', nickname: 'Nano Banana Pro', usdPerImage: 0.1747, consistency: 'same_family', redrawCount: 6, redrawUsd: 1.0675 }
  ],
  origin: 'preflight',
  ...over
});

/** Three page redraws that failed upstream (429) in the last few minutes (R5). */
const withUpstreamFailures = (d: ComicDoc, now: number, n = 3) => {
  d.pages.slice(-n).forEach((p, i) => {
    p.render = { ...p.render, status: 'failed', error: 'Google AI Studio is rate-limiting this model.', errorDetail: { code: 'RATE_LIMIT', provider: 'OpenRouter', at: now - (n - i) * 60_000, text: 'Google AI Studio: 429 Resource exhausted' } };
  });
};

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  setModelCatalog(fixtureCatalog());
});
afterEach(() => {
  setModelCatalog(null);
  vi.restoreAllMocks();
});

describe('set_settings on a locked comic (models.md §3.4 #6)', () => {
  it('refuses a tier change with the lock copy: resolution is the user\'s call, the model stays, nothing is committed', async () => {
    const doc = makeLakeComic((d) => {
      d.settings = { ...d.settings, quality: 'standard' };
      d.imageModel = { modelId: 'nano-banana-2.1', lockedAt: 1, origin: 'first_render' };
    });
    setup(doc);
    const out = await call('set_settings', { quality: 'draft' });
    expect(out).toMatch(/^Error: Locked comic: resolution changes are the user's call\. Offer the quality chip\./);
    expect(out).toContain('stays on Nano Banana 2.1');
    expect(out).toContain('draft would only draw new pages at 1K');
    expect(out).toContain('No tool can change the image model');
    expect(ctx.session.doc.settings.quality).toBe('standard');
    expect(ops.filter((o) => o.op === 'settings')).toEqual([]);
    // Other tightening still works on a locked comic.
    expect(await call('set_settings', { budgetUsd: 3 })).toContain('budget $3.00');
  });

  it('a legacy comic locks through its generated assets (deriveLock): even a Pro-tier comic keeps its drawn model', async () => {
    const doc = makeLakeComic((d) => {
      d.settings = { ...d.settings, quality: 'pro' };
    });
    expect(doc.imageModel).toBeUndefined();
    setup(doc);
    const out = await call('set_settings', { quality: 'standard' });
    expect(out).toMatch(/^Error: Locked comic: resolution changes are the user's call/);
    expect(out).toContain('stays on Nano Banana 2.1');
    expect(ctx.session.doc.settings.quality).toBe('pro');
  });

  it('style swatches never lock: before the first comic image the director may still lower the tier', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, quality: 'standard' };
    doc.style.options = [
      { id: 'so_1', name: 'Ink', spec: 'Bold ink', render: { ...emptyRender(), status: 'ready', asset: { path: 'u/s1.webp', source: 'generated', at: 1, model: 'nano-banana-2.1' } } }
    ];
    setup(doc);
    expect(await call('set_settings', { quality: 'draft' })).toMatch(/^Settings: draft quality;/);
    expect(ctx.session.doc.settings.quality).toBe('draft');
  });

  it('never takes a model argument: the schema has no model field and an extra one changes nothing', async () => {
    const doc = makeLakeComic();
    setup(doc);
    const spec = tools.get('set_settings')!.spec.function.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(spec.properties).sort()).toEqual(['bigSpendUsd', 'budgetUsd', 'confirm', 'quality']);
    await call('set_settings', { imageModelOverride: 'nano-banana-pro', budgetUsd: 2 } as Record<string, unknown>);
    expect(ctx.session.doc.settings.imageModelOverride).toBeUndefined();
    expect(ops.some((o) => o.op === 'settings' && 'imageModelOverride' in (o.patch as Record<string, unknown>))).toBe(false);
  });
});

describe('the models tool group (registration, phase gate)', () => {
  it('is registered once, after safety and breakdown, with an activity label per tool and the §3.8 prompt rule', () => {
    expect(toolGroupById('models')).toBe(modelsToolGroup);
    expect(modelsToolGroup.priority).toBeGreaterThan(10);
    setup(lakeLocked());
    expect([...modelsToolGroup.tools(ctx, turn)].map((t) => t.spec.function.name)).toEqual(['model_options', 'suggest_model']);
    for (const t of modelsToolGroup.tools(ctx, turn)) {
      expect(t.cost).toBe('free');
      expect(t.spec.function.description.startsWith('FREE — ')).toBe(true);
      expect(typeof modelsToolGroup.activity?.[t.spec.function.name]).toBe('string');
    }
    const rules = modelsToolGroup.promptRules!(ctx.session.doc)!;
    expect(rules).toContain('The image model is locked per comic. Never say you switched it and never call a tool to switch it.');
    expect(rules).toContain('Say plainly that consistency can be affected.');
    expect(modelsToolGroup.summaryLines!(ctx.session.doc, turn)).toEqual([
      'Image model: Nano Banana 2.1, locked for this comic; holds 4 characters per image; drawn with it: 5 pages, 4 character sheets and the cover.'
    ]);
  });

  it('is offered only when the turn is about models, or when the studio may suggest unasked (§3.8 triggers)', () => {
    const wanted = (doc: ComicDoc, text: string) => {
      setup(doc, text);
      return modelsToolGroup.when!(ctx, turn);
    };
    expect(wanted(lakeLocked(), 'make the shouts red')).toBe(false);
    expect(wanted(plannedDoc(), 'hello')).toBe(false);
    expect(wanted(lakeLocked(), 'use GPT image for this comic')).toBe(true);
    expect(wanted(lakeLocked(), 'make it cheaper')).toBe(true);
    expect(wanted(lakeLocked(), 'is there a better model?')).toBe(true);
    // 1: a page with more characters than the locked model keeps on model.
    expect(wanted(lakeLocked((d) => d.pages[2].panels[0].castIds.push('c_ducks', 'c_frog', 'c_turtle')), 'next')).toBe(true);
    // 2: R5, three upstream failures in a row in the last 10 minutes.
    expect(wanted(lakeLocked((d) => withUpstreamFailures(d, Date.now())), 'hmm')).toBe(true);
    expect(wanted(lakeLocked((d) => withUpstreamFailures(d, Date.now(), 2)), 'hmm')).toBe(false);
    // …and a recent outage card.
    expect(
      wanted(lakeLocked((d) => d.conversation.push({ id: 'm_out', role: 'assistant', text: 'Paused.', at: Date.now() - 60_000, cards: [outageCard()] })), 'ok')
    ).toBe(true);
  });
});

describe('model names', () => {
  it('resolves what users call models, never guessing an unknown name', () => {
    const id = (s: string) => resolveModelName(s)?.id;
    expect(id('GPT image')).toBe('gpt-image-2.5');
    expect(id('use openai')).toBe('gpt-image-2.5');
    expect(id('GPT Image 2.5 Flare')).toBe('gpt-image-2.5-flare');
    expect(id('nano banana pro')).toBe('nano-banana-pro');
    expect(id('Gemini 3 Pro Image')).toBe('nano-banana-pro');
    expect(id('Nano Banana 2.1')).toBe('nano-banana-2.1');
    expect(id('nano-banana-2.1')).toBe('nano-banana-2.1');
    expect(id('seedream')).toBe('seedream-5-pro');
    expect(id('flux')).toBe('flux-3');
    expect(id('midjourney v9')).toBeUndefined();
    expect(id('')).toBeUndefined();
  });
});

describe('model_options: real numbers from the catalog, read-only (models.md §3.8)', () => {
  it('"use GPT image": names its price per page, the 4:5 block and the consistency trade-off; the fitting option carries redraw quotes', async () => {
    setup(lakeLocked(), 'use GPT image for this comic', { caps: BYOK_CAPS, keys: BYOK_KEYS });
    const out = await call('model_options', { want: 'specific', model: 'GPT image' });
    // Current: Nano Banana 2.1 at 1K = $0.0336 (Google token table via OpenRouter) + $0.003 QC, own key → ≈ $0.04.
    expect(out).toMatch(/^CURRENT: Nano Banana 2\.1 — locked for this comic \(every page matches\); ≈ \$0\.04 per page at 1K \(OpenRouter list price\); holds 4 characters per image; 1 provider · 97\.7% up \(24 h\); LMArena edit #5 \(2026-10-20\)/);
    expect(out).toContain('Drawn with it: 5 pages, 4 character sheets and the cover.');
    // GPT Image 2.5: $0.2107 (dated price list) + QC → ≈ $0.21; 4:5 is a block.
    expect(out).toContain("ASKED FOR: GPT Image 2.5 — NOT POSSIBLE for this comic: Not available in Comic Studio yet; Can't draw 4:5 pages.");
    expect(out).toContain('≈ $0.21 per page at 1K (price list from 2026-10-22)');
    // The fitting option: Nano Banana Pro $0.1344 + QC → ≈ $0.14; redraw 5 pages + cover ≈ $0.82, everything ≈ $1.36 (§3.5 example 1).
    expect(out).toMatch(/OPTION 1: Nano Banana Pro\. ≈ \$0\.14 per page at 1K \(OpenRouter list price\); holds 5 characters per image; \d providers? · [\d.]+% up \(24 h\); LMArena edit #\d+ \(2026-10-20\)/);
    expect(out).toContain('Redraw to match: pages + cover ≈ $0.82; everything ≈ $1.36.');
    expect(out).toContain('Notes: About 4× the price of Nano Banana 2.1 per page. Same family, still a different model: consistency can be affected.');
    expect(out).toContain('consistency can be affected');
    expect(out).toContain('You cannot switch the model');
    // Read-only: nothing committed, the lock is untouched; the advice is kept for the reply.
    expect(ops).toEqual([]);
    expect(ctx.session.doc.imageModel?.modelId).toBe('nano-banana-2.1');
    expect(modelAdviceOf(turn)?.named?.id).toBe('gpt-image-2.5');
  });

  it('"make it cheaper": the same model at a lower tier first (light confirm), with the drawn pages\' resolution', async () => {
    setup(lakeLocked((d) => (d.settings = { ...d.settings, quality: 'standard' })), 'make it cheaper', { caps: BYOK_CAPS, keys: BYOK_KEYS });
    const out = await call('model_options', { want: 'cheaper' });
    // Standard 2K = $0.0504 + QC → ≈ $0.05; Draft 1K = $0.0336 + QC → ≈ $0.04.
    expect(out).toContain('SAME MODEL, CHEAPER: Draft draws new pages with Nano Banana 2.1 at 1K for ≈ $0.04 per page instead of ≈ $0.05 at 2K.');
    expect(out).toContain('the 5 pages already drawn stay at 2K unless redrawn');
    expect(out).toContain('suggest_model tier "draft"');
    expect(out).toContain('No other available model draws this comic for less.');
    const reply = modelAdviceReply(modelAdviceOf(turn)!, costFormatter(DOLLAR_VIEW));
    expect(reply.text).toBe(
      'The cheapest way that keeps your characters consistent is Draft: the same Nano Banana 2.1 at 1K, ≈ $0.04 a page instead of ≈ $0.05 at 2K. The 5 pages already drawn stay at 2K unless you redraw them.'
    );
    expect(reply.steps).toEqual([{ label: 'Use Draft for new pages', action: { type: 'patch', ops: [{ op: 'settings', patch: { quality: 'draft' } }] }, usd: 0 }]);
  });

  it('a cheaper model no public board ranks is never called as good: "can\'t vouch for the quality"', async () => {
    const flux = getImageModel('flux-3')!;
    const saved = { pickable: flux.pickable };
    const real = fixtureCatalog();
    // The fake catalog: FLUX made pickable, unranked and cheaper than the comic's model (prices are still the book's).
    const fake: ModelCatalog = {
      ...real,
      rows: async (o) => (await real.rows(o)).map((r) => (r.id === 'flux-3' ? { ...r, quality: [], fit: (r.fit || []).filter((f) => f.code !== 'price') } : r)),
      priceSources: async (u, o) => {
        const src = await real.priceSources(u, o);
        return { ...src, rows: src.rows.map((r) => (r.id === 'flux-3' ? { ...r, price: { '1K': { usd: 0.012, basis: 'registry' as const }, '2K': { usd: 0.02, basis: 'registry' as const } } } : r)) };
      }
    };
    setModelCatalog(fake);
    flux.pickable = true;
    try {
      setup(lakeLocked((d) => (d.settings = { ...d.settings, quality: 'standard' })), 'make it cheaper', { caps: BYOK_CAPS, keys: BYOK_KEYS });
      const out = await call('model_options', { want: 'cheaper' });
      expect(out).toMatch(/OPTION 1: FLUX\.3\. ≈ \$0\.0\d per page at 2K .*not ranked on any public leaderboard \(quality UNVERIFIED\)/);
      expect(out).toContain('never say it is as good as Nano Banana 2.1');
      const reply = modelAdviceReply(modelAdviceOf(turn)!, costFormatter(DOLLAR_VIEW)).text;
      expect(reply).toContain('Draft');
      expect(reply).toContain("FLUX.3 costs less, but no public leaderboard ranks it, so I can't vouch for the quality.");
      expect(reply).not.toMatch(/\bequal\b|as good as|same quality|just as good/i);
    } finally {
      flux.pickable = saved.pickable;
    }
  });

  it('characters: suggests a model that holds more, with the redraw cost of what is drawn (§3.8 example)', async () => {
    setup(lakeLocked((d) => d.pages[2].panels[0].castIds.push('c_ducks', 'c_frog', 'c_turtle')), 'next page', { caps: BYOK_CAPS, keys: BYOK_KEYS });
    const out = await call('model_options', { want: 'characters' });
    expect(out).toContain('PAGE 3 has 5 characters; Nano Banana 2.1 keeps up to 4 on model per image.');
    expect(out).toMatch(/OPTION 1: Nano Banana Pro\./);
    const reply = modelAdviceReply(modelAdviceOf(turn)!, costFormatter(DOLLAR_VIEW));
    expect(reply.text).toBe(
      'Nano Banana 2.1 keeps up to 4 characters on model, and page 3 has 5. Nano Banana Pro holds 5. It costs ≈ $0.14 a page instead of ≈ $0.04, and your 5 drawn pages would look different unless redrawn (≈ $0.82 with the cover). Switching models can affect character consistency. Want to see the options?'
    );
    expect(reply.steps).toEqual([{ label: 'See models', client: { type: 'open_model_picker', suggest: 'nano-banana-pro' } }]);
  });

  it('platform key: the markup is in every price; a governed user reads usage shares, never dollars', async () => {
    setup(lakeLocked(), 'use nano banana pro', { caps: { ...resolveStudioCaps({ planId: 'creator', byok: false, isAdmin: false }), usage: { governed: false, pctLeft: 100, exhausted: false, pctPerStandardPage: null } } });
    const paid = await call('model_options', { model: 'Nano Banana Pro' });
    // ($0.1344 + $0.003) × 1.3 = $0.1786 → ≈ $0.18.
    expect(paid).toContain('ASKED FOR: Nano Banana Pro. ≈ $0.18 per page at 1K');
    setup(lakeLocked(), 'use nano banana pro', { caps: GOVERNED_CAPS });
    const governed = await call('model_options', { model: 'Nano Banana Pro' });
    expect(governed).not.toMatch(/\$/);
    expect(governed).toMatch(/% of your usage per page at 1K/);
    expect(costViewFor(GOVERNED_CAPS).governed).toBe(true);
  });

  it('unknown names are an error the model can correct; a catalog outage still answers from the dated price list', async () => {
    setup(lakeLocked(), 'use midjourney', { caps: BYOK_CAPS, keys: BYOK_KEYS });
    expect(await call('model_options', { model: 'midjourney' })).toMatch(/^Error: No image model called "midjourney"\. Available: Nano Banana 2\.1, Nano Banana Pro\.$/);
    setModelCatalog({ ...fixtureCatalog(), rows: async () => Promise.reject(new Error('catalog down')), priceSources: async () => Promise.reject(new Error('catalog down')) });
    const out = await call('model_options', { want: 'characters' });
    expect(out).toContain('Live catalog data was unavailable');
    expect(out).toContain('price list from 2026-10-22');
    expect(out).toContain('provider uptime unknown');
  });
});

describe('suggest_model: chips, never a change', () => {
  it('opens the picker with the model highlighted; nothing is committed', async () => {
    setup(lakeLocked(), 'use pro', { caps: BYOK_CAPS, keys: BYOK_KEYS });
    const out = await call('suggest_model', { model: 'Nano Banana Pro' });
    expect(out).toContain('Offered “See models” with Nano Banana Pro highlighted');
    expect(out).toContain('Nothing changed — the comic stays on Nano Banana 2.1.');
    expect(turn.nextSteps).toEqual([{ label: 'See models', client: { type: 'open_model_picker', suggest: 'nano-banana-pro' } }]);
    // One picker chip per turn.
    await call('suggest_model', { model: 'gpt image' });
    expect(turn.nextSteps.filter((s) => s.client?.type === 'open_model_picker')).toHaveLength(1);
    expect(ops).toEqual([]);
    expect(await call('suggest_model', { model: 'midjourney' })).toMatch(/^Error: No image model called/);
  });

  it('a cheaper tier on the same model is the user\'s tap; a pricier tier or one that would change the model is refused', async () => {
    setup(lakeLocked((d) => (d.settings = { ...d.settings, quality: 'standard' })), 'cheaper please');
    expect(await call('suggest_model', { tier: 'draft' })).toContain('one tap draws new pages with Nano Banana 2.1 at 1K; drawn pages keep theirs');
    expect(turn.nextSteps).toEqual([{ label: 'Use Draft for new pages', action: { type: 'patch', ops: [{ op: 'settings', patch: { quality: 'draft' } }] }, usd: 0 }]);
    expect(await call('suggest_model', { tier: 'pro' })).toMatch(/^Error: Pro doesn't cost less than Standard\. Only the user raises quality/);
    expect(ctx.session.doc.settings.quality).toBe('standard');
    // Unlocked Pro-tier comic: Draft would draw on another model — set_settings handles that before the lock.
    const fresh = plannedDoc();
    fresh.settings = { ...fresh.settings, quality: 'pro' };
    setup(fresh, 'cheaper');
    expect(await call('suggest_model', { tier: 'draft' })).toMatch(/^Error: Draft would draw on Nano Banana 2\.1, not Nano Banana Pro\. Nothing is drawn yet, so set_settings can lower the tier directly\.$/);
    expect(ops).toEqual([]);
  });
});

describe('R5 and outages (reliability.md §2 Director)', () => {
  it('upstreamStreak counts consecutive upstream failures in the last 10 minutes only', () => {
    const now = LAKE_NOW;
    const doc = lakeLocked((d) => withUpstreamFailures(d, now));
    expect(upstreamStreak(doc, now)).toMatchObject({ count: 3, code: 'RATE_LIMIT', provider: 'OpenRouter', text: 'Google AI Studio: 429 Resource exhausted' });
    expect(upstreamStreak(doc, now).targets).toEqual([{ kind: 'page', id: 'pg_3' }, { kind: 'page', id: 'pg_4' }, { kind: 'page', id: 'pg_5' }]);
    expect(upstreamStreak(doc, now + 11 * 60_000).count).toBe(0);
    // A drawing that worked after them ends the streak.
    const healed = lakeLocked((d) => {
      withUpstreamFailures(d, now);
      d.cover.render = { ...d.cover.render, status: 'ready', updatedAt: now - 10_000 };
    });
    expect(upstreamStreak(healed, now).count).toBe(0);
    // Safety blocks and own-key problems are not upstream failures.
    const safety = lakeLocked((d) => {
      withUpstreamFailures(d, now);
      d.pages.slice(-3).forEach((p) => (p.render.errorDetail = { ...p.render.errorDetail!, code: 'SAFETY' }));
    });
    expect(upstreamStreak(safety, now).count).toBe(0);
  });

  it('a recent outage card is news until an image draws after it', () => {
    const now = LAKE_NOW + 3_600_000;
    const doc = lakeLocked((d) => d.conversation.push({ id: 'm_out', role: 'assistant', text: 'Paused.', at: now - 120_000, cards: [outageCard()] }));
    expect(recentOutageCard(doc, now)?.card.id).toBe('card_out_1');
    expect(recentOutageCard(doc, now + OUTAGE_MS())).toBeNull();
    doc.pages[0].render = { ...doc.pages[0].render, updatedAt: now - 1_000 };
    expect(recentOutageCard(doc, now)).toBeNull();
    expect(outageCardText(outageCard())).toBe('[paused: Nano Banana 2.1 — nothing started, nothing charged; options offered: wait and retry / switch to Nano Banana Pro]');
  });

  it('model_status fact: no I/O when nothing is wrong; the live health (breaker + OpenRouter) when something is', async () => {
    const health = fakeModelHealth({ now: LAKE_NOW });
    const getModelHealth = vi.spyOn(health, 'getModelHealth');
    setup(lakeLocked());
    expect(await modelStatusLine(ctx, ctx.session.doc, 'make the sky pink', { health, now: health.now() })).toBe('');
    expect(await modelStatusLine(ctx, ctx.session.doc, 'is it down?', { health, now: health.now() })).toBe(
      'MODEL STATUS (Nano Banana 2.1): no failures in this comic or in our recent calls; live provider status not checked.'
    );
    expect(getModelHealth).not.toHaveBeenCalled();
    expect(health.fetches).toEqual([]);

    // The 16:52 incident: OpenRouter says the only provider is failing and our last 3 calls were 429s.
    health.setPublic('google/gemini-nano-banana-2.1', [{ name: 'Google AI Studio', status: -1, uptime30m: 40, uptime1d: 90 }]);
    for (let i = 0; i < 3; i += 1) health.recordImageOutcome({ route: 'openrouter', model: 'google/gemini-nano-banana-2.1', ok: false, code: 'RATE_LIMIT', at: health.now() - 30_000 + i });
    const doc = lakeLocked((d) => {
      withUpstreamFailures(d, health.now());
      d.conversation.push({ id: 'm_out', role: 'assistant', text: 'Paused.', at: health.now() - 20_000, cards: [outageCard({ origin: 'mid_run', chargedUsd: 0 })] });
    });
    setup(doc, 'what happened?', { caps: BYOK_CAPS, keys: BYOK_KEYS });
    const line = await modelStatusLine(ctx, doc, 'what happened?', { health, now: health.now() });
    expect(getModelHealth).toHaveBeenCalledTimes(1);
    expect(health.fetches.every((f) => Object.keys(f.headers).length === 0)).toBe(true);
    expect(line).toMatch(/^MODEL STATUS \(Nano Banana 2\.1\): not serving \(down\) — Our last 3 calls failed \(RATE_LIMIT\) \(OpenRouter status, just now\)\./);
    expect(line).toContain('3 drawings in this comic failed upstream in the last 10 min (RATE_LIMIT · OpenRouter).');
    expect(line).toContain('The studio paused a run — its options are in OUTAGE OPTIONS.');
    const facts = await modelFactLines(ctx, doc, 'what happened?', { health, now: health.now() });
    expect(facts).toEqual([
      line,
      "OUTAGE OPTIONS (the studio's own check, real prices): wait and retry (free, about 2 min) · Nano Banana Pro ≈ $0.17 per image (redraw 6 images ≈ $1.07; same family). Offer them in words; a switch only through the picker."
    ]);
    expect(line).toContain('never say a drawing started unless a tool says so. Suggest waiting first (free).');
    expect(line.length).toBeLessThanOrEqual(400);
  });

  it('a hung health read never holds the turn: the breaker alone words the status', async () => {
    const health = fakeModelHealth({ now: LAKE_NOW });
    for (let i = 0; i < 3; i += 1) health.recordImageOutcome({ route: 'openrouter', model: 'google/gemini-nano-banana-2.1', ok: false, code: 'RATE_LIMIT', at: health.now() - 10_000 + i });
    vi.spyOn(health, 'getModelHealth').mockImplementation(() => new Promise(() => undefined));
    setup(lakeLocked());
    const started = Date.now();
    const lines = await modelFactLines(ctx, ctx.session.doc, 'hi', { health, now: health.now(), waitMs: 30 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(lines).toEqual(['MODEL STATUS (Nano Banana 2.1): not serving (down) (no live data). New drawing pauses before anything is charged; never say a drawing started unless a tool says so. Suggest waiting first (free).']);
  });

  it('model facts name a crowded page (trigger 1) and a locked model this plan can no longer use (trigger 3)', async () => {
    setup(lakeLocked((d) => d.pages[2].panels[0].castIds.push('c_ducks', 'c_frog', 'c_turtle')));
    const health = fakeModelHealth();
    expect(await modelFactLines(ctx, ctx.session.doc, 'next', { health })).toEqual([
      'MODEL FIT: page 3 has 5 characters but Nano Banana 2.1 keeps up to 4 on model per image. Before drawing it, say so and suggest a model that holds more (model_options, then the picker chip); never switch.'
    ]);
    // A free plan with a legacy lock on Nano Banana Pro (models.md §3.9).
    setup(lakeLocked((d) => (d.imageModel = { modelId: 'nano-banana-pro', lockedAt: 1, origin: 'migrated' })));
    expect(await modelFactLines(ctx, ctx.session.doc, 'next', { health })).toEqual([
      "MODEL: Nano Banana Pro can't draw for this account (needs a paid plan or your own key). Say so and offer the picker (model_options); never pick another model yourself."
    ]);
  });
});

describe('reply guards: never a switch, never a start that did not happen', () => {
  const dollars = costFormatter(DOLLAR_VIEW);

  it('finds claims of a switch to another model, not offers, negations or other "set … to" sentences', () => {
    const claims = (t: string) => falseSwitchClaims(t, 'nano-banana-2.1');
    expect(claims("Done — I've switched your comic to GPT Image 2.5. Enjoy!")).toEqual(["Done — I've switched your comic to GPT Image 2.5."]);
    expect(claims('Now using Nano Banana Pro for the rest of the book.')).toHaveLength(1);
    expect(claims("I'll switch it to GPT Image for page 4.")).toHaveLength(1);
    expect(claims('If you want, I can switch it to Nano Banana Pro.')).toEqual([]);
    expect(claims("I haven't switched to GPT Image.")).toEqual([]);
    expect(claims('I set the budget to $5. I changed the title to Nano Banana Days.')).toEqual([]);
    expect(claims('Your comic stays on Nano Banana 2.1; I set it to Nano Banana 2.1 at 1K.')).toEqual([]);
  });

  it('replaces a false switch claim with the lock line', () => {
    const doc = lakeLocked();
    const out = guardModelReply("Done — I've switched your comic to GPT Image 2.5. The next page will look sharper.", { doc, outages: [], queued: 0, cost: dollars });
    expect(out).toBe(
      'Your comic stays on Nano Banana 2.1 — only you can change the image model, in the model picker, and switching can affect character consistency. The next page will look sharper.'
    );
  });

  it('a paused run: drops "it\'s on its way", says nothing started or was charged, and offers the options in words with real prices', () => {
    const doc = lakeLocked();
    const out = guardModelReply("Drawing page 5 now — it's on its way! It will appear on the board soon.", { doc, outages: [outageCard()], queued: 0, cost: dollars });
    expect(out).toBe(
      "Nano Banana 2.1 isn't drawing right now, so I paused — nothing was started and nothing was charged. You can tap “Wait and retry” and it tries again once it's back, while this page is open (free, about 2 min), or switch to Nano Banana Pro (≈ $0.17 per image; redrawing 6 images to match ≈ $1.07 — character consistency can be affected)."
    );
    // An honest reply is kept as written; an empty one gets the line; a mid-run card without cost says so, one without an origin makes no money claim.
    expect(guardModelReply("Google is rate-limiting Nano Banana 2.1, so I paused — nothing was charged.", { doc, outages: [outageCard()], queued: 0, cost: dollars })).toBe(
      'Google is rate-limiting Nano Banana 2.1, so I paused — nothing was charged.'
    );
    expect(guardModelReply('', { doc, outages: [outageCard({ origin: 'mid_run', chargedUsd: 0, options: [{ kind: 'wait_and_retry' }] })], queued: 0, cost: dollars })).toBe(
      "Nano Banana 2.1 isn't drawing right now, so I paused — the part that didn't draw wasn't charged. You can tap “Wait and retry” and it tries again once it's back, while this page is open (free)."
    );
    expect(guardModelReply('', { doc, outages: [outageCard({ origin: undefined, options: [] })], queued: 0, cost: dollars })).toBe("Nano Banana 2.1 isn't drawing right now, so I paused.");
    // Governed: the same line in usage terms.
    const governed = guardModelReply('', { doc, outages: [outageCard()], queued: 0, cost: costFormatter(costViewFor(GOVERNED_CAPS)) });
    expect(governed).not.toMatch(/\$/);
    expect(governed).toMatch(/switch to Nano Banana Pro \(≈[\d.]+% of your usage per image/);
  });
});

const OUTAGE_MS = () => 31 * 60_000;
