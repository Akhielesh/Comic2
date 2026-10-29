// @vitest-environment node
// M1-DIRECTOR-MODELS (models.md §3.8, §3.4 #6; reliability.md §2 Director): the director suggests image models
// with real numbers and never switches. Fakes only: the merged catalog over the public 17:51Z OpenRouter fixture,
// the fake model-health port, scripted model replies. No network, $0.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStudioCaps, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import { emptyRender, newId, type ComicDoc, type NextStep } from '../../../../shared/comic/doc.js';
import { getImageModel, resolveImageJob } from '../../../../shared/comic/models.js';
import type { DocOp, StudioAction } from '../../../../shared/comic/ops.js';
import { makeLakeComic, LAKE_NOW } from '../../../../shared/comic/__fixtures__/lakeComic.js';
import { costFormatter, costViewFor, DOLLAR_VIEW } from '../costText.js';
import { DIRECTOR_SYSTEM_PROMPT, runDirectorTurn } from '../director.js';
import { JOB_TIMINGS, startAction } from '../jobs.js';
import { drawIntentInContext } from '../replies.js';
import { FAKE_BASE, FIXTURE_NOW, fakeOpenRouterFetch, memoryCatalogStore } from '../models/__fixtures__/catalogFakes.js';
import { fakeModelHealth, type FakeModelHealth } from '../models/health.fakes.js';
import { __setModelHealthForTests } from '../models/health.js';
import { createModelCatalog, createPriceBook, createQualitySource, setModelCatalog, type ModelCatalog } from '../models/index.js';
import { newSession, plannedDoc, scriptedLlm, testContext, type ScriptStep, type TestContext } from '../orchestrator.fakes.js';
import { buildDirectorTools, buildTurnToolset, createDirectorTurn, type DirectorTool, type DirectorTurn } from '../tools.js';
import type { StudioKeys } from '../types.js';
import { toolGroupById, toolGroups } from './index.js';
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
  turn = createDirectorTurn({ userText, drawIntent: drawIntentInContext(doc, userText) });
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
    // 1: a page still to be drawn with more characters than the locked model keeps on model…
    const crowdedUndrawn = (d: ComicDoc) => {
      d.pages[2].panels[0].castIds.push('c_ducks', 'c_frog', 'c_turtle');
      d.pages[2].render = emptyRender();
    };
    expect(wanted(lakeLocked(crowdedUndrawn), 'next')).toBe(true);
    // …or a drawn one the user asks to draw again; a drawn, current one is not brought up on every turn.
    expect(wanted(lakeLocked((d) => d.pages[2].panels[0].castIds.push('c_ducks', 'c_frog', 'c_turtle')), 'redraw page 3')).toBe(true);
    expect(wanted(lakeLocked((d) => d.pages[2].panels[0].castIds.push('c_ducks', 'c_frog', 'c_turtle')), 'next')).toBe(false);
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

  it('naming the model the comic is already on changes nothing and says so', async () => {
    setup(lakeLocked(), 'use nano banana 2.1', { caps: BYOK_CAPS, keys: BYOK_KEYS });
    const out = await call('model_options', { model: 'Nano Banana 2.1' });
    expect(out).toContain('ASKED FOR: Nano Banana 2.1, which this comic already draws with — nothing to change.');
    expect(modelAdviceReply(modelAdviceOf(turn)!, costFormatter(DOLLAR_VIEW)).text).toBe('Your comic already draws with Nano Banana 2.1 (≈ $0.04 a page at 1K), so nothing needs to change.');
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
    expect(recentOutageCard(doc, now + 31 * 60_000)).toBeNull();
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
    setup(
      lakeLocked((d) => {
        d.pages[2].panels[0].castIds.push('c_ducks', 'c_frog', 'c_turtle');
        d.pages[2].render = emptyRender();
      })
    );
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
    expect(out.steps).toEqual([{ label: 'See models', client: { type: 'open_model_picker' } }]);
    expect(out.text).toBe(
      'Your comic stays on Nano Banana 2.1 — only you can change the image model, in the model picker, and switching can affect character consistency. The next page will look sharper.'
    );
  });

  it('a paused run: drops "it\'s on its way", says nothing started or was charged, and offers the options in words with real prices', () => {
    const doc = lakeLocked();
    const out = guardModelReply("Drawing page 5 now — it's on its way! It will appear on the board soon.", { doc, outages: [outageCard()], queued: 0, cost: dollars }).text;
    expect(out).toBe(
      "Nano Banana 2.1 isn't drawing right now, so I paused — nothing was started and nothing was charged. You can tap “Wait and retry” and it tries again once it's back, while this page is open (free, about 2 min), or switch to Nano Banana Pro (≈ $0.17 per image; redrawing 6 images to match ≈ $1.07 — character consistency can be affected)."
    );
    // An honest reply is kept as written; an empty one gets the line; a mid-run card without cost says so, one without an origin makes no money claim.
    expect(guardModelReply("Google is rate-limiting Nano Banana 2.1, so I paused — nothing was charged.", { doc, outages: [outageCard()], queued: 0, cost: dollars }).text).toBe(
      'Google is rate-limiting Nano Banana 2.1, so I paused — nothing was charged.'
    );
    expect(guardModelReply('', { doc, outages: [outageCard({ origin: 'mid_run', chargedUsd: 0, options: [{ kind: 'wait_and_retry' }] })], queued: 0, cost: dollars }).text).toBe(
      "Nano Banana 2.1 isn't drawing right now, so I paused — the part that didn't draw wasn't charged. You can tap “Wait and retry” and it tries again once it's back, while this page is open (free)."
    );
    expect(guardModelReply('', { doc, outages: [outageCard({ origin: undefined, options: [] })], queued: 0, cost: dollars }).text).toBe("Nano Banana 2.1 isn't drawing right now, so I paused.");
    // Governed: the same line in usage terms.
    const governed = guardModelReply('', { doc, outages: [outageCard()], queued: 0, cost: costFormatter(costViewFor(GOVERNED_CAPS)) }).text;
    expect(governed).not.toMatch(/\$/);
    expect(governed).toMatch(/switch to Nano Banana Pro \(≈[\d.]+% of your usage per image/);
  });
});


describe('director wiring (director.ts): rule, facts, history', () => {
  it('the system prompt carries the lock rule; a locked comic\'s Settings line names its real model; the model facts sit in the summary', async () => {
    // Locked to Nano Banana Pro on the Standard tier: the tier no longer picks the model (models.md §3.4 #1).
    const doc = lakeLocked((d) => {
      d.settings = { ...d.settings, quality: 'standard' };
      d.imageModel = { modelId: 'nano-banana-pro', lockedAt: 1, origin: 'user_change' };
      d.pages[2].panels[0].castIds.push('c_ducks', 'c_frog', 'c_turtle', 'c_owl');
      d.pages[2].render = { ...d.pages[2].render, status: 'failed', error: 'Timed out.' };
    });
    const session = newSession(doc);
    const llm = scriptedLlm({ director: [{ text: 'Hi!' }] });
    const health = fakeModelHealth();
    const prev = __setModelHealthForTests(health);
    try {
      await runDirectorTurn(testContext(session, { llm, caps: BYOK_CAPS, keys: BYOK_KEYS }), { text: 'hello', attachments: [] });
    } finally {
      __setModelHealthForTests(prev);
    }
    const system = llm.calls[0].messages[0].content as string;
    expect(DIRECTOR_SYSTEM_PROMPT).toContain('9. The image model is locked per comic: never say you switched it (no tool can)');
    expect(DIRECTOR_SYSTEM_PROMPT).toContain('A drawing tool that says it paused or did not start means nothing started and nothing was charged');
    // ($0.1344 + $0.003) on the user's own key → ≈ $0.14 a page; before the fix this line said "Nano Banana 2.1 2K".
    expect(system).toContain('Settings: standard quality (Nano Banana Pro (locked) 2K, ≈ $0.14/page');
    expect(system).toContain('MODEL FIT: page 3 has 6 characters but Nano Banana Pro keeps up to 5 on model per image.');
    // Nothing was wrong with the model: no health read at all.
    expect(health.fetches).toEqual([]);
  });

  it('an outage card in the history reads as "paused — nothing started"; prices stay out of the history', async () => {
    const doc = lakeLocked((d) =>
      d.conversation.push(
        { id: 'm_ask', role: 'user', text: 'draw pages 3 to 5', at: Date.now() - 9_000 },
        { id: 'm_out', role: 'assistant', text: 'Paused.', at: Date.now() - 5_000, cards: [outageCard()] }
      )
    );
    const session = newSession(doc);
    const llm = scriptedLlm({ director: [{ text: 'Still paused — want to wait?' }] });
    const health = fakeModelHealth({ now: Date.now() });
    const prev = __setModelHealthForTests(health);
    try {
      await runDirectorTurn(testContext(session, { llm, caps: BYOK_CAPS, keys: BYOK_KEYS }), { text: 'ok', attachments: [] });
    } finally {
      __setModelHealthForTests(prev);
    }
    const history = JSON.stringify(llm.calls[0].messages.slice(1));
    expect(history).toContain('[paused: Nano Banana 2.1 — nothing started, nothing charged; options offered: wait and retry / switch to Nano Banana Pro]');
    expect(history).not.toContain('$');
    // The recent card makes the status a fact (with its real options) and offers the group.
    const system = llm.calls[0].messages[0].content as string;
    expect(system).toContain("OUTAGE OPTIONS (the studio's own check, real prices): wait and retry (free, about 2 min) · Nano Banana Pro ≈ $0.17 per image");
    expect(llm.calls[0].tools!.map((t) => t.function.name)).toContain('model_options');
  });
});

// ── Golden scenarios: golden/scenarios/{model-switch,model-429,five-characters}.json ──────────────────────────

interface GoldenTurn {
  say?: string;
  about?: string;
  action?: StudioAction;
  expectTools?: string[];
  systemIncludes?: string[];
  outageDuringTurn?: 'preflight';
  director?: Array<{ text?: string; toolCalls?: { name: string; args: unknown }[] }>;
  expect?: {
    toolResultIncludes?: Record<string, string[]>;
    reply?: string;
    replyStartsWith?: string;
    replyIncludes?: string[];
    replyExcludes?: string[];
    nextSteps?: NextStep[];
    nextStepLabels?: string[];
    /** The chips' labels, exactly and in order. */
    nextStepOrder?: string[];
    imageModel?: string;
    quality?: string;
    newImageCalls?: number;
  };
}
interface GoldenScenario {
  name: string;
  about: string;
  doc: 'lake-standard' | 'lake-429' | 'lake-five';
  caps?: 'byok';
  health?: 'rate-limited';
  turns: GoldenTurn[];
}

const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'scenarios');
const GOLDEN_FILES = ['model-switch.json', 'model-429.json', 'five-characters.json'];
const goldens: GoldenScenario[] = GOLDEN_FILES.map((f) => JSON.parse(readFileSync(join(SCENARIO_DIR, f), 'utf8')) as GoldenScenario);
const NB21_OPENROUTER = 'google/gemini-nano-banana-2.1';

/** The 16:52 incident on the fake health port: OpenRouter's only provider failing and our last 3 calls 429s. */
const rateLimitedHealth = (now: number): FakeModelHealth => {
  const health = fakeModelHealth({ now });
  health.setPublic(NB21_OPENROUTER, [{ name: 'Google AI Studio', status: -1, uptime30m: 40, uptime1d: 90 }]);
  for (let i = 0; i < 3; i += 1) health.recordImageOutcome({ route: 'openrouter', model: NB21_OPENROUTER, ok: false, code: 'RATE_LIMIT', at: now - 30_000 + i });
  return health;
};

/** A model_outage card built by the studio's own preflight (M1-RELIABILITY's options builder, live PriceBook). */
const preflightCard = async (health: FakeModelHealth, doc: ComicDoc, keys: StudioKeys, caps: StudioCaps, origin: 'preflight' | 'mid_run'): Promise<OutageCard> => {
  const spec = resolveImageJob('page', doc.settings.quality, undefined, doc.imageModel).spec;
  const pre = await health.preflightImageRun({ specs: [spec], keys, doc, caps, prices: await createPriceBook({ userId: 'user-1' }), now: health.now() });
  expect(pre.ok).toBe(false);
  return { type: 'model_outage', id: newId('card'), modelId: pre.blocked![0].modelId, options: pre.options, origin, ...(origin === 'mid_run' ? { chargedUsd: 0 } : {}) };
};

const goldenDoc = async (s: GoldenScenario, env: { health: FakeModelHealth; keys: StudioKeys; caps: StudioCaps }): Promise<ComicDoc> => {
  if (s.doc === 'lake-standard') return lakeLocked((d) => (d.settings = { ...d.settings, quality: 'standard' }));
  if (s.doc === 'lake-five') {
    return lakeLocked((d) => {
      d.cast.push({ id: 'c_turtle', name: 'Grandpa Turtle', tier: 'support', kind: 'animal', look: { summary: 'An old green turtle with round glasses' }, refs: [], sheet: emptyRender() });
      d.pages[2].panels[0].castIds.push('c_ducks', 'c_frog', 'c_turtle');
    });
  }
  // lake-429: pages 3–5 failed upstream (429) in the last 3 minutes; the run ended with the studio's outage card.
  const now = env.health.now();
  const doc = lakeLocked((d) => withUpstreamFailures(d, now));
  const card = await preflightCard(env.health, doc, env.keys, env.caps, 'mid_run');
  doc.conversation.push({ id: 'm_out', role: 'assistant', text: "Pages 3–5 weren't drawn: the provider is rate-limiting Nano Banana 2.1.", at: now - 20_000, cards: [card] });
  return doc;
};

/** Ops that change (or try to change) the comic's image model: the acceptance counts them across the golden set. */
const modelChangingOps = (ops: DocOp[], userTurn: boolean) =>
  ops.filter((op) => {
    if ((op.op as string) === 'image_model') return true;
    if (op.op !== 'settings') return false;
    const patch = op.patch as Record<string, unknown>;
    return 'imageModelOverride' in patch || (!userTurn && 'quality' in patch);
  });

const toolResults = (calls: { messages: { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string } }[] }[] }[]): Record<string, string> => {
  const last = calls[calls.length - 1];
  const names = new Map<string, string>();
  const out: Record<string, string> = {};
  for (const m of last?.messages || []) {
    for (const call of m.tool_calls || []) names.set(call.id, call.function.name);
    if (m.role === 'tool' && m.tool_call_id) {
      const name = names.get(m.tool_call_id) ?? m.tool_call_id;
      out[name] = `${out[name] ?? ''}${String(m.content)}\n`;
    }
  }
  return out;
};

let goldenModelChanges = 0;
let goldenModelAttempts = 0;
let goldenTurnsRun = 0;

describe('golden: director model behaviour (models.md §5.1 M1-DIRECTOR-MODELS)', () => {
  it('ships the three scenarios', () => {
    expect(goldens.map((g) => g.name)).toEqual(['model-switch', 'model-429', 'five-characters']);
  });

  for (const scenario of goldens) {
    it(`${scenario.name}: ${scenario.about.slice(0, 90)}…`, async () => {
      const caps = scenario.caps === 'byok' ? BYOK_CAPS : GOVERNED_CAPS;
      const keys = scenario.caps === 'byok' ? BYOK_KEYS : { openrouter: { key: 'sk-or-platform-test', byok: false } };
      const health = scenario.health === 'rate-limited' ? rateLimitedHealth(Date.now()) : fakeModelHealth({ now: Date.now() });
      const prev = __setModelHealthForTests(health);
      try {
        const session = newSession(await goldenDoc(scenario, { health, keys, caps }));
        let images: TestContext['imagesFake'] | undefined;
        for (const [i, turn] of scenario.turns.entries()) {
          const label = `${scenario.name} turn ${i + 1}`;
          const ops: DocOp[] = [];
          const unsubscribe = session.subscribe((e) => {
            if (e.type === 'ops') ops.push(...e.ops);
          });
          const e = turn.expect || {};
          try {
            if (turn.action) {
              const tctx = testContext(session, { caps, keys, ...(images ? { images } : {}) });
              await (await startAction(tctx, turn.action, { confirmed: true, origin: 'user' })).done;
              await tctx.settled();
            } else {
              const steps: ScriptStep[] = (turn.director || []).map((s, k) => ({
                text: s.text ?? '',
                ...(s.toolCalls?.length ? { toolCalls: s.toolCalls.map((c, j) => ({ id: `t${k}_${j}`, name: c.name, arguments: JSON.stringify(c.args) })) } : {})
              }));
              if (turn.outageDuringTurn) {
                // The studio's preflight pauses a run while the model is still writing (jobs.ts commits the card).
                const first = steps[0];
                steps[0] = async () => {
                  const card = await preflightCard(health, session.doc, keys, caps, 'preflight');
                  session.commit([{ op: 'message', msg: { id: newId('msg'), role: 'assistant', text: 'The image provider is busy, so nothing was drawn.', at: Date.now(), cards: [card] } }]);
                  return first;
                };
              }
              const llm = scriptedLlm({ director: steps });
              const tctx = testContext(session, { llm, caps, keys, ...(images ? { images } : {}) });
              images = tctx.imagesFake;
              const imagesBefore = tctx.imagesFake.calls.length;
              await runDirectorTurn(tctx, { text: turn.say || '', attachments: [] });
              await tctx.settled();

              const director = llm.calls.filter((c) => c.role === 'director');
              const offered = director[0]?.tools?.map((t) => t.function.name) || [];
              for (const tool of turn.expectTools || []) expect(offered, `${label}: ${tool} offered`).toContain(tool);
              const system = String(director[0]?.messages[0]?.content ?? '');
              for (const line of turn.systemIncludes || []) expect(system, `${label}: system`).toContain(line);
              const results = toolResults(director as never);
              for (const [tool, wants] of Object.entries(e.toolResultIncludes || {})) for (const want of wants) expect(results[tool], `${label}: ${tool} result`).toContain(want);
              goldenModelAttempts += (turn.director || []).flatMap((s) => s.toolCalls || []).filter((c) => c.name === 'set_settings').length;
              if (e.newImageCalls !== undefined) expect(tctx.imagesFake.calls.length - imagesBefore, `${label}: image calls`).toBe(e.newImageCalls);

              const reply = [...session.doc.conversation].reverse().find((m) => m.role === 'assistant')!;
              expect(reply.text.trim().length, `${label}: never silent`).toBeGreaterThan(0);
              if (e.reply !== undefined) expect(reply.text, label).toBe(e.reply);
              if (e.replyStartsWith) expect(reply.text.startsWith(e.replyStartsWith), `${label}: "${reply.text}"`).toBe(true);
              for (const want of e.replyIncludes || []) expect(reply.text, label).toContain(want);
              for (const not of e.replyExcludes || []) expect(reply.text.toLowerCase(), label).not.toContain(not.toLowerCase());
              if (e.nextSteps) expect(reply.nextSteps, label).toEqual(expect.arrayContaining(e.nextSteps.map((s) => expect.objectContaining(s))));
              if (e.nextStepLabels) expect((reply.nextSteps || []).map((s) => s.label), label).toEqual(expect.arrayContaining(e.nextStepLabels));
              if (e.nextStepOrder) expect((reply.nextSteps || []).map((s) => s.label), label).toEqual(e.nextStepOrder);
            }
          } finally {
            unsubscribe();
          }
          goldenTurnsRun += 1;
          goldenModelChanges += modelChangingOps(ops, !!turn.action).length;
          if (e.imageModel) expect(session.doc.imageModel?.modelId, `${label}: the lock`).toBe(e.imageModel);
          if (e.quality) expect(session.doc.settings.quality, `${label}: the tier`).toBe(e.quality);
          expect(session.doc.settings.imageModelOverride, `${label}: no override`).toBeUndefined();
        }
        // Never silent across the whole scenario.
        expect(session.doc.conversation.filter((m) => m.role === 'assistant' && !m.text.trim() && !m.cards?.some((c) => c.type === 'renders'))).toEqual([]);
      } finally {
        __setModelHealthForTests(prev);
      }
    });
  }

  it('acceptance: zero tool calls that change the model across the golden set (a misbehaving model tried)', () => {
    expect(goldenTurnsRun).toBe(goldens.reduce((n, g) => n + g.turns.length, 0));
    expect(goldenModelAttempts).toBeGreaterThan(0);
    expect(goldenModelChanges).toBe(0);
  });

  it('tool-choice accuracy: every tool a golden turn needs is offered within the per-turn budget', async () => {
    let needed = 0;
    let offered = 0;
    for (const scenario of goldens) {
      const caps = scenario.caps === 'byok' ? BYOK_CAPS : GOVERNED_CAPS;
      const keys = scenario.caps === 'byok' ? BYOK_KEYS : { openrouter: { key: 'sk-or-platform-test', byok: false } };
      const health = scenario.health === 'rate-limited' ? rateLimitedHealth(Date.now()) : fakeModelHealth({ now: Date.now() });
      const doc = await goldenDoc(scenario, { health, keys, caps });
      for (const turn of scenario.turns) {
        if (!turn.say) continue;
        const set = buildTurnToolset(testContext(newSession(doc), { caps, keys }), createDirectorTurn({ userText: turn.say, drawIntent: drawIntentInContext(doc, turn.say) }), toolGroups());
        expect(set.tools.length).toBeLessThanOrEqual(30);
        const names = new Set(set.tools.map((t) => t.spec.function.name));
        for (const tool of turn.expectTools || []) {
          needed += 1;
          if (names.has(tool)) offered += 1;
        }
      }
    }
    expect(needed).toBeGreaterThanOrEqual(8);
    expect(offered / needed).toBe(1);
  });
});
