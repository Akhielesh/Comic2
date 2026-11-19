// House comics contract (spec DC-H1): limits, payers, statuses, the daily slate planner, the calibration set, the content
// check, the runway maths and the config sanitizer. Pure: no network, no clock, no people's data (every name below is
// invented).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HOUSE_CAPPED_PAYERS,
  HOUSE_CONFIG_DEFAULTS,
  HOUSE_CONTENT_RULES,
  HOUSE_EXCLUDED_PRESETS,
  HOUSE_FAMILY_MODELS,
  HOUSE_GENRES,
  HOUSE_HELD_REASONS,
  HOUSE_LIMITS,
  HOUSE_MODES,
  HOUSE_PAYERS,
  HOUSE_SHAPES,
  HOUSE_SOURCE_LANGUAGES,
  HOUSE_STAGES,
  HOUSE_STATUSES,
  HOUSE_STYLE_PRESETS,
  HOUSE_TOPIC_BLOCKLIST,
  addHouseDays,
  calibrationSlates,
  checkHouseText,
  dayBudgetUsd,
  describeSlate,
  heldReasonForGate,
  houseCreditOptional,
  houseCreditStopped,
  houseDaysBetween,
  isHouseDay,
  normalizeHouseConfig,
  parseHouseByokVendors,
  payerOfModel,
  planDailySlate,
  sanitizeHouseConfigPatch,
  silentFormatInstructions,
  type HouseConfig,
  type HouseHistoryEntry,
  type HousePayerConfig,
  type HouseSlate,
  type PlanDailySlateInput
} from './house';
import { languageSpec } from './languages';
import { IMAGE_MODELS, getImageModel, type ImageModelSpec } from './models';
import { getStylePreset, STYLE_PRESETS } from './stylePresets';

const here = dirname(fileURLToPath(import.meta.url));
const START = '2026-12-01';
/** A named-IP detector that finds nothing (the server passes detectNamedIp). */
const NO_IP = { namedIp: () => [] as string[] };
/** Words in a look's prompt text that ask for deities or devotional imagery. */
const DEVOTIONAL_RE = /\bgods?\b|deity|deities|devotional|sacred/i;
const presetText = (id: string) => {
  const p = getStylePreset(id)!;
  return [p.name, p.tagline, p.spec].join(' ');
};

/** Plans `days` consecutive days, feeding each day's slates back as the next days' 14-day history. */
function simulate(days: number, opts: Partial<PlanDailySlateInput> = {}, count = 10): HouseSlate[][] {
  const out: HouseSlate[][] = [];
  const history: HouseHistoryEntry[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = addHouseDays(START, i);
    const history14d = history.filter((h) => houseDaysBetween(h.day, day) <= 14);
    const slates = planDailySlate({ day, count, history14d, ...opts });
    out.push(slates);
    history.push(...slates.map((s) => ({ day, presetId: s.presetId, genre: s.genre, kind: s.kind, model: s.model })));
  }
  return out;
}

const withPickable = (ids: string[], pickable: boolean): ImageModelSpec[] =>
  IMAGE_MODELS.map((m) => (ids.includes(m.id) ? { ...m, pickable } : m));

const GPT_ASPECTS = getImageModel('gpt-image-2.6-sunburst')!.aspects;
const isShort = (s: HouseSlate) => s.short;
const count = <T>(xs: readonly T[], f: (x: T) => boolean) => xs.filter(f).length;

/** Every §5.2 rule for one day (scaled for days with fewer than 10 slots). */
function expectDayRules(slates: HouseSlate[], earlier: HouseSlate[][], registry: readonly ImageModelSpec[] = IMAGE_MODELS) {
  const n = slates.length;
  const tag = slates[0]?.day ?? '(empty)';
  // Slots
  expect(slates.map((s) => s.slot), tag).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  // Kind and pages
  expect(new Set(slates.map((s) => s.kind)).size, `${tag} kinds`).toBeGreaterThanOrEqual(Math.min(4, n));
  for (const s of slates) {
    const shape = HOUSE_SHAPES.find((x) => x.id === s.shape)!;
    expect(shape.kind, `${tag} shape kind`).toBe(s.kind);
    expect(s.pages, `${tag} ${s.shape} pages`).toBeGreaterThanOrEqual(shape.pages[0]);
    expect(s.pages, `${tag} ${s.shape} pages`).toBeLessThanOrEqual(shape.pages[1]);
    expect(s.readingDirection, tag).toBe(s.kind === 'manga' ? 'rtl' : 'ltr');
    if (s.short) {
      expect(s.pages, tag).toBeLessThanOrEqual(3);
      expect(s.format, `${tag} shorts are silent`).toBe('silent');
    }
  }
  expect(count(slates, isShort), `${tag} short pieces`).toBeGreaterThanOrEqual(Math.min(2, n));
  // Format
  expect(count(slates, (s) => s.format === 'silent'), `${tag} silent`).toBeGreaterThanOrEqual(Math.min(2, n));
  // Look
  for (const s of slates) expect(getStylePreset(s.presetId), s.presetId).toBeDefined();
  expect(new Set(slates.map((s) => s.presetId)).size, `${tag} distinct looks`).toBeGreaterThanOrEqual(Math.min(7, n));
  const lastTwo = earlier.slice(-2).flat().map((s) => s.presetId);
  for (const s of slates) expect(lastTwo, `${tag} ${s.presetId} repeats within 3 days`).not.toContain(s.presetId);
  // Image model, tier, aspect, resolution
  for (const s of slates) {
    const spec = registry.find((m) => m.id === s.model)!;
    expect(spec, s.model).toBeDefined();
    expect(spec.pickable, `${tag} ${s.model} pickable`).toBe(true);
    expect(HOUSE_FAMILY_MODELS[s.family].standard.concat(HOUSE_FAMILY_MODELS[s.family].pro), tag).toContain(s.model);
    expect(['standard', 'pro'], tag).toContain(s.tier);
    expect(spec.aspects, `${tag} ${s.model} ${s.aspect}`).toContain(s.aspect);
    if (s.family === 'openai') {
      expect(GPT_ASPECTS, tag).toContain(s.aspect);
      expect(['5:4', '4:5', '1:4', '4:1', '1:8', '8:1'], tag).not.toContain(s.aspect);
    }
    expect(s.resolution, `${tag} no 4K by default`).not.toBe('4K');
    expect(s.blocked, tag).toBeUndefined();
  }
  // Colour
  for (const s of slates) {
    const p = getStylePreset(s.presetId)!;
    expect(s.colorMode, `${tag} colour follows the look`).toBe(p.colorMode ?? 'color');
  }
  expect(count(slates, (s) => s.colorMode !== 'color'), `${tag} non-colour`).toBeGreaterThanOrEqual(n >= 6 ? 3 : Math.min(2, n));
  for (const s of slates) {
    expect(HOUSE_EXCLUDED_PRESETS, `${tag} ${s.presetId} is not a house look`).not.toContain(s.presetId);
    expect(presetText(s.presetId), `${tag} ${s.presetId} asks for devotional imagery`).not.toMatch(DEVOTIONAL_RE);
  }
  // Audience and rating
  const want = { children: Math.round(n * 0.3), teen: Math.round(n * 0.3) };
  expect(count(slates, (s) => s.audience === 'children'), `${tag} children`).toBe(want.children);
  expect(count(slates, (s) => s.audience === 'teen'), `${tag} teen`).toBe(want.teen);
  expect(count(slates, (s) => s.audience === 'general'), `${tag} general`).toBe(n - want.children - want.teen);
  for (const s of slates) {
    expect(['G', 'PG', 'PG-13'], tag).toContain(s.rating);
    if (s.audience === 'children') expect(['G', 'PG'], tag).toContain(s.rating);
    if (s.audience === 'general') expect(s.rating, tag).toBe('PG');
    if (s.audience === 'teen') expect(s.rating, tag).toBe('PG-13');
  }
  // Language and editions
  const english = count(slates, (s) => s.language === 'en');
  expect(english, `${tag} English sources`).toBeGreaterThanOrEqual(n - Math.floor(n * 0.3));
  let extra = 0;
  for (const s of slates) {
    expect(languageSpec(s.language), s.language).toBeDefined();
    if (s.format === 'silent') {
      expect(s.language, tag).toBe('en');
      expect(s.editions, tag).toEqual([]);
    }
    if (s.language !== 'en') {
      expect(HOUSE_SOURCE_LANGUAGES, tag).toContain(s.language);
      expect(s.editions, `${tag} non-English sources get an English edition`).toContain('en');
      extra += s.editions.length - 1;
    } else extra += s.editions.length;
    expect(s.editions, tag).not.toContain(s.language);
    for (const e of s.editions) expect(languageSpec(e), e).toBeDefined();
  }
  expect(extra, `${tag} extra editions`).toBeLessThanOrEqual(HOUSE_LIMITS.extraEditionsMax);
  // Genre
  expect(new Set(slates.map((s) => s.genre)).size, `${tag} genre twice`).toBe(n);
  for (const s of slates) {
    const g = HOUSE_GENRES.find((x) => x.id === s.genre)!;
    expect(g, s.genre).toBeDefined();
    expect(g.audiences, `${tag} ${s.genre} for ${s.audience}`).toContain(s.audience);
  }
}

describe('HOUSE_LIMITS: the owner\'s authorisation as compiled ceilings', () => {
  it('pins the per-comic, daily-count and day ceilings', () => {
    expect(HOUSE_LIMITS.capComicMaxUsd).toBe(7);
    expect(HOUSE_LIMITS.dailyCountMax).toBe(10);
    expect(HOUSE_LIMITS.capDayMaxUsd).toBe(70);
    expect(HOUSE_LIMITS.capDayMaxUsd).toBe(HOUSE_LIMITS.capComicMaxUsd * HOUSE_LIMITS.dailyCountMax);
    expect(HOUSE_LIMITS.imageSlotsMax).toBe(2);
    expect(HOUSE_LIMITS.holdTtlMs).toBe(15 * 60_000);
    expect(HOUSE_LIMITS.stageAttemptsMax).toBe(2);
    expect(HOUSE_LIMITS.comicWallMs).toBe(45 * 60_000);
    expect(HOUSE_LIMITS.runWallMs).toBe(5 * 3_600_000);
    expect(HOUSE_LIMITS.redrawsMax).toBe(2);
    expect(Object.isFrozen(HOUSE_LIMITS)).toBe(true);
  });

  it('defaults are the spec\'s lower caps, switched off', () => {
    const d = HOUSE_CONFIG_DEFAULTS;
    expect(d.enabled).toBe(false);
    expect(d.mode).toBe('off');
    expect(d.dailyCount).toBe(3);
    expect(d.capComicUsd).toBe(7);
    expect(d.finishReserveUsd).toBe(0.4);
    expect(d.capDayUsd).toBe(30);
    expect(d.imageSlots).toBe(2);
    expect(d.allow4k).toBe(false);
    expect(d.releasePerDay).toBe(2);
    expect(d.payers.openai_credit).toEqual({ dayCapUsd: 12, creditUsd: 200, stopFraction: 0.9, runwayUntil: null, expiresOn: null });
    expect(d.payers.anthropic_credit).toEqual({ dayCapUsd: 5, creditUsd: 200, stopFraction: 0.9, runwayUntil: null, expiresOn: null });
    expect(d.payers.house_openrouter.dayCapUsd).toBe(10);
    expect(d.payers.house_openrouter.creditUsd).toBeNull();
    expect(Object.keys(d.payers).sort()).toEqual([...HOUSE_CAPPED_PAYERS].sort());
    expect(Object.isFrozen(d) && Object.isFrozen(d.payers) && Object.isFrozen(d.payers.openai_credit)).toBe(true);
    // The defaults pass their own sanitizer (an empty patch is valid).
    expect(sanitizeHouseConfigPatch({}).ok).toBe(true);
  });

  it('names every list the SQL mirrors', () => {
    expect(HOUSE_MODES).toEqual(['off', 'rehearsal', 'calibration', 'daily']);
    expect(HOUSE_PAYERS).toEqual(['openai_credit', 'anthropic_credit', 'house_openrouter', 'platform']);
    expect(HOUSE_CAPPED_PAYERS).not.toContain('platform');
    expect(HOUSE_STAGES).toEqual(['slate', 'brief', 'create', 'plan', 'sheets', 'pages', 'cover', 'letter', 'editions', 'publish', 'done']);
    expect(HOUSE_STATUSES).toEqual(expect.arrayContaining(['queued', 'running', 'held', 'ready', 'released', 'skipped', 'discarded', 'purged']));
    for (const r of ['brief_rejected', 'topic_blocked', 'incomplete', 'overfull', 'low_quality', 'gate_blocked', 'rating_above_slate', 'payer_cap', 'timeout', 'switched_off', 'pipeline_mismatch', 'model_paused', 'error', 'gate_budget']) {
      expect(HOUSE_HELD_REASONS, r).toContain(r);
    }
  });

  it('a gate card holds the comic as gate_<reason>', () => {
    expect(heldReasonForGate('budget')).toBe('gate_budget');
    expect(heldReasonForGate('first_render')).toBe('gate_first_render');
    for (const r of ['policy', 'budget', 'first_render', 'plan_review', 'redraw', 'no_intent'] as const) expect(HOUSE_HELD_REASONS).toContain(heldReasonForGate(r));
  });
});

describe('planDailySlate', () => {
  it('keeps every slate rule across 60 simulated days', () => {
    const days = simulate(60);
    days.forEach((slates, i) => {
      expect(slates).toHaveLength(10);
      expectDayRules(slates, days.slice(0, i));
      // 5 Gemini and 5 OpenAI by default; no draft; about 6 standard and 4 pro (GPT Image 2.5 hidden: Gemini pro only)
      expect(count(slates, (s) => s.family === 'gemini')).toBe(5);
      expect(count(slates, (s) => s.family === 'openai')).toBe(5);
      expect(count(slates, (s) => s.tier === 'standard')).toBeGreaterThanOrEqual(6);
      expect(count(slates, (s) => s.tier === 'pro')).toBeLessThanOrEqual(4);
      for (const s of slates) expect(s.imagePayer, 'no BYOK: every picture is on the house key').toBe('house_openrouter');
    });
  });

  it('keeps the rules for the first daily runs of 3 and for any count up to 10', () => {
    for (const n of [1, 2, 3, 5, 7]) {
      const days = simulate(20, {}, n);
      days.forEach((slates, i) => {
        expect(slates).toHaveLength(n);
        expectDayRules(slates, days.slice(0, i));
      });
    }
  });

  it('never plans more than the daily ceiling, and nothing for a bad day or count 0', () => {
    expect(planDailySlate({ day: START, count: 25 })).toHaveLength(HOUSE_LIMITS.dailyCountMax);
    expect(planDailySlate({ day: START, count: 0 })).toEqual([]);
    expect(planDailySlate({ day: '2026-02-30', count: 3 })).toEqual([]);
    expect(planDailySlate({ day: 'tomorrow', count: 3 })).toEqual([]);
    // count defaults to the config's daily count
    expect(planDailySlate({ day: START })).toHaveLength(HOUSE_CONFIG_DEFAULTS.dailyCount);
  });

  it('is deterministic: the same day gives the same slate, another day another', () => {
    const history: HouseHistoryEntry[] = [{ day: '2026-11-30', presetId: 'noir-ink', genre: 'mystery' }];
    const a = planDailySlate({ day: START, count: 10, history14d: history });
    const b = planDailySlate({ day: START, count: 10, history14d: history.map((h) => ({ ...h })) });
    expect(b).toEqual(a);
    expect(planDailySlate({ day: '2026-12-02', count: 10, history14d: history })).not.toEqual(a);
  });

  it('never chooses a model that is not pickable', () => {
    const hidden = withPickable(['gpt-image-2.6-flare'], false);
    for (const slates of simulate(30, { registry: hidden })) {
      for (const s of slates) {
        expect(s.model).not.toBe('gpt-image-2.6-flare');
        expect(['gpt-image-2.5', 'gpt-image-2.5-flare']).not.toContain(s.model);
      }
    }
    // Every image model the default registry hides stays out across 60 days.
    const hiddenIds = IMAGE_MODELS.filter((m) => !m.pickable).map((m) => m.id);
    for (const slates of simulate(60)) for (const s of slates) expect(hiddenIds).not.toContain(s.model);
  });

  it('puts GPT Image 2.5 on pro OpenAI slates once it is pickable (about 6 standard, 4 pro)', () => {
    const d2 = withPickable(['gpt-image-2.5', 'gpt-image-2.5-flare'], true);
    const days = simulate(30, { registry: d2 });
    let used25 = 0;
    days.forEach((slates, i) => {
      expectDayRules(slates, days.slice(0, i), d2);
      expect(count(slates, (s) => s.tier === 'pro')).toBe(4);
      expect(count(slates, (s) => s.tier === 'standard')).toBe(6);
      for (const s of slates) {
        if (s.model.startsWith('gpt-image-2.5')) {
          used25 += 1;
          expect(s.tier).toBe('pro');
        }
        if (s.family === 'openai' && s.tier === 'standard') expect(s.model.startsWith('gpt-image-2.6')).toBe(true);
        if (s.family === 'gemini') expect(s.model).toBe(s.tier === 'pro' ? 'nano-banana-pro' : 'nano-banana-2.1');
      }
    });
    expect(used25).toBeGreaterThan(0);
  });

  it('GPT aspects always come from the GPT list (5:4 → 4:3, 4:5 → 3:4)', () => {
    const all = simulate(60).flat();
    const gpt = all.filter((s) => s.family === 'openai');
    expect(gpt.length).toBeGreaterThan(0);
    for (const s of gpt) expect(GPT_ASPECTS).toContain(s.aspect);
    for (const s of gpt.filter((x) => x.shape === 'short')) expect(s.aspect).toBe('4:3');
    for (const s of gpt.filter((x) => x.shape === 'storybook')) expect(s.aspect).toBe('3:4');
    // Gemini keeps the shape's own aspect when it lists it.
    for (const s of all.filter((x) => x.family === 'gemini' && x.shape === 'short')) expect(s.aspect).toBe('5:4');
    for (const s of all.filter((x) => x.shape === 'webtoon')) expect(s.aspect).toBe('9:16');
  });

  it('never plans draft, and 4K only when allowed (pro Gemini pages)', () => {
    const plain = simulate(20).flat();
    expect(plain.some((s) => (s.tier as string) === 'draft')).toBe(false);
    expect(plain.some((s) => s.resolution === '4K')).toBe(false);
    const allowed = simulate(20, { config: { ...HOUSE_CONFIG_DEFAULTS, allow4k: true } }).flat();
    const fourK = allowed.filter((s) => s.resolution === '4K');
    expect(fourK.length).toBeGreaterThan(0);
    for (const s of fourK) {
      expect(s.tier).toBe('pro');
      expect(getImageModel(s.model)!.resolutions).toContain('4K');
    }
    for (const s of allowed.filter((x) => x.family === 'openai')) expect(s.resolution).toBe('1K');
  });

  it('swaps a paused model within its family and records the swap', () => {
    const health = { 'nano-banana-2.1': 'down' } as const;
    const slates = planDailySlate({ day: START, count: 10, health });
    const gemini = slates.filter((s) => s.family === 'gemini');
    expect(gemini.length).toBe(5);
    for (const s of gemini) {
      expect(s.model).toBe('nano-banana-pro');
      expect(s.blocked).toBeUndefined();
    }
    const swapped = gemini.filter((s) => s.swap);
    expect(swapped.length).toBeGreaterThan(0);
    for (const s of swapped) {
      expect(s.swap).toEqual({ from: 'nano-banana-2.1', reason: 'paused' });
      expect(s.tier).toBe('standard'); // the slate keeps its tier; the model is an override, as recorded
    }
    // A paused GPT Image 2.6 Sunburst moves to Flare, never to Gemini.
    const gpt = planDailySlate({ day: START, count: 10, health: { 'gpt-image-2.6-sunburst': 'down' } }).filter((s) => s.family === 'openai');
    for (const s of gpt) expect(s.model).toBe('gpt-image-2.6-flare');
    // 'degraded' is not paused.
    expect(planDailySlate({ day: START, count: 10, health: { 'nano-banana-2.1': 'degraded' } }).some((s) => s.swap)).toBe(false);
  });

  it('holds a slot whose whole family is paused instead of moving it to the other payer', () => {
    const health = { 'gpt-image-2.6-sunburst': 'down', 'gpt-image-2.6-flare': 'down' } as const;
    const slates = planDailySlate({ day: START, count: 10, health });
    const gpt = slates.filter((s) => s.family === 'openai');
    expect(gpt).toHaveLength(5);
    for (const s of gpt) expect(s.blocked).toBe('model_paused');
    for (const s of slates.filter((x) => x.family === 'gemini')) expect(s.blocked).toBeUndefined();
  });

  it('re-weights the mix by each payer\'s remaining day budget', () => {
    const byokVendors = ['openai', 'anthropic'] as const;
    const base = planDailySlate({ day: START, count: 10, byokVendors });
    expect(count(base, (s) => s.family === 'openai')).toBe(5);
    for (const s of base) expect(s.imagePayer).toBe(s.family === 'openai' ? 'openai_credit' : 'house_openrouter');
    // A payer with no day budget left gets no slots; the other half takes them.
    const none = planDailySlate({ day: START, count: 10, byokVendors, budgets: { openai_credit: 0 } });
    expect(none).toHaveLength(10);
    expect(count(none, (s) => s.family === 'openai')).toBe(0);
    // A quarter of the OpenAI day budget left: fewer OpenAI slots.
    const quarter = planDailySlate({ day: START, count: 10, byokVendors, budgets: { openai_credit: HOUSE_CONFIG_DEFAULTS.payers.openai_credit.dayCapUsd / 4, house_openrouter: 10 } });
    expect(count(quarter, (s) => s.family === 'openai')).toBe(2);
    // Without BYOK both halves are on the house key, so an OpenAI-credit budget changes nothing.
    expect(count(planDailySlate({ day: START, count: 10, budgets: { openai_credit: 0 } }), (s) => s.family === 'openai')).toBe(5);
    // Gemini on zero: all OpenAI.
    expect(count(planDailySlate({ day: START, count: 10, byokVendors, budgets: { house_openrouter: 0 } }), (s) => s.family === 'openai')).toBe(10);
  });

  it('a credit at its stop stops that half (owner question 5); its slots are not moved', () => {
    const byokVendors = ['openai'] as const;
    const slates = planDailySlate({ day: START, count: 10, byokVendors, stopped: ['openai_credit'], budgets: { openai_credit: 0 } });
    expect(slates).toHaveLength(5);
    expect(slates.every((s) => s.family === 'gemini')).toBe(true);
    expectDayRules(slates, []);
  });

  it('works out a credit\'s stop from lifetime spend: a budget from dayBudgetUsd at the stop stops that half', () => {
    const byokVendors = ['openai'] as const;
    const openai = HOUSE_CONFIG_DEFAULTS.payers.openai_credit;
    const atStop = dayBudgetUsd(openai, { day: START, lifetimeUsd: 180 });
    expect(atStop).toBe(0);
    // The natural call: the budget from dayBudgetUsd and the lifetime spend, no `stopped` list.
    const slates = planDailySlate({ day: START, count: 10, byokVendors, budgets: { openai_credit: atStop }, lifetimeUsd: { openai_credit: 180 } });
    expect(slates).toHaveLength(5);
    expect(slates.every((s) => s.family === 'gemini')).toBe(true);
    expectDayRules(slates, []);
    // Lifetime spend alone gives the same (the planner works out the budget too).
    expect(planDailySlate({ day: START, count: 10, byokVendors, lifetimeUsd: { openai_credit: 250 } })).toEqual(slates);
    // Below the stop the budget only leans the mix: 5 of 12 left.
    const near = planDailySlate({ day: START, count: 10, byokVendors, lifetimeUsd: { openai_credit: 175 } });
    expect(near).toHaveLength(10);
    expect(count(near, (s) => s.family === 'openai')).toBe(2);
    // The house OpenRouter key has no credit stop: any lifetime spend leaves its day cap.
    const house = planDailySlate({ day: START, count: 10, byokVendors, lifetimeUsd: { house_openrouter: 1e6 } });
    expect(house).toHaveLength(10);
    expect(count(house, (s) => s.family === 'gemini')).toBe(5);
    // A runway spreads the room: the planner reads the payer's own config.
    const runway = { ...HOUSE_CONFIG_DEFAULTS, payers: { ...HOUSE_CONFIG_DEFAULTS.payers, openai_credit: { ...openai, runwayUntil: '2026-12-30' } } };
    const spread = planDailySlate({ day: START, count: 10, byokVendors, config: runway, lifetimeUsd: { openai_credit: 0 } });
    expect(count(spread, (s) => s.family === 'openai')).toBe(3); // 180 over 30 days = 6 of 12 left: weights 1 and 0.5
  });

  it('never uses a look whose prompt asks for deities or devotional imagery (house content rules)', () => {
    expect(HOUSE_EXCLUDED_PRESETS).toEqual(['mythic-icon', 'indian-miniature']);
    for (const id of HOUSE_EXCLUDED_PRESETS) {
      expect(getStylePreset(id), id).toBeDefined();
      expect(presetText(id), id).toMatch(DEVOTIONAL_RE);
    }
    // Every look a house slate may use is clear of it, so a new preset with such text fails here.
    expect(HOUSE_STYLE_PRESETS.length).toBe(STYLE_PRESETS.length - HOUSE_EXCLUDED_PRESETS.length);
    for (const p of HOUSE_STYLE_PRESETS) expect(presetText(p.id), p.id).not.toMatch(DEVOTIONAL_RE);
    const looks = new Set<string>();
    for (const n of [10, 7, 3]) for (const s of simulate(60, {}, n).flat()) looks.add(s.presetId);
    for (const id of HOUSE_EXCLUDED_PRESETS) expect(looks.has(id), id).toBe(false);
  });

  it('ignores history rows dated on the run day or later, so a re-plan after a restart gives the same slate', () => {
    const days = simulate(5);
    const history = days.flat().map((s) => ({ day: s.day, presetId: s.presetId, genre: s.genre, kind: s.kind, model: s.model }));
    const day = addHouseDays(START, 5);
    const first = planDailySlate({ day, count: 10, history14d: history });
    // The run day's own rows (written before the restart) and a stray later row are in the history now.
    const own = first.map((s) => ({ day, presetId: s.presetId, genre: s.genre, kind: s.kind, model: s.model }));
    const later = [{ day: addHouseDays(day, 1), presetId: first[0].presetId, genre: first[0].genre }];
    expect(planDailySlate({ day, count: 10, history14d: [...history, ...own, ...later] })).toEqual(first);
  });

  it('follows the owner\'s model weights', () => {
    const noOpenAi = { ...HOUSE_CONFIG_DEFAULTS, modelWeights: { 'gpt-image-2.6-sunburst': 0, 'gpt-image-2.6-flare': 0 } };
    const slates = planDailySlate({ day: START, count: 10, config: noOpenAi });
    expect(slates).toHaveLength(10);
    expect(slates.every((s) => s.family === 'gemini')).toBe(true);
    const flareOnly = { ...HOUSE_CONFIG_DEFAULTS, modelWeights: { 'gpt-image-2.6-sunburst': 0 } };
    for (const s of simulate(10, { config: flareOnly }).flat()) expect(s.model).not.toBe('gpt-image-2.6-sunburst');
    // No pro Gemini wanted: Gemini slots are standard.
    const noPro = { ...HOUSE_CONFIG_DEFAULTS, modelWeights: { 'nano-banana-pro': 0 } };
    for (const s of simulate(10, { config: noPro }).flat()) expect(s.model).not.toBe('nano-banana-pro');
  });

  it('prints 14 days of slates for a read-through', () => {
    const lines = simulate(14).flatMap((slates) => [slates[0].day, ...slates.map((s) => `  ${describeSlate(s)}`)]);
    expect(lines.join('\n')).toMatchSnapshot();
  });
});

describe('calibrationSlates', () => {
  const STORY_SOURCE = readFileSync(resolve(here, '../../components/comicshost/ComicSampleReader.tsx'), 'utf8');

  it('remakes The Last Tram and The Paper Boat on both image families: silent, 2 pages, English', () => {
    const slates = calibrationSlates({ day: START });
    expect(slates).toHaveLength(4);
    for (const s of slates) {
      expect(s.format).toBe('silent');
      expect(s.pages).toBe(2);
      expect(s.language).toBe('en');
      expect(s.editions).toEqual([]);
      expect(s.day).toBe(START);
      expect(s.calibration).toBeDefined();
      expect(getImageModel(s.model)!.aspects).toContain(s.aspect);
    }
    expect(slates.map((s) => [s.calibration!.story, s.model, s.aspect])).toEqual([
      ['last-tram', 'nano-banana-pro', '5:4'],
      ['last-tram', 'gpt-image-2.6-sunburst', '4:3'],
      ['paper-boat', 'nano-banana-2.1', '2:3'],
      ['paper-boat', 'gpt-image-2.6-flare', '2:3']
    ]);
    expect(slates.map((s) => s.slot)).toEqual([1, 2, 3, 4]);
  });

  it('uses GPT Image 2.5 for The Last Tram once D2 has passed', () => {
    const d2 = withPickable(['gpt-image-2.5'], true);
    const s = calibrationSlates({ day: START, registry: d2 })[1];
    expect(s.model).toBe('gpt-image-2.5');
    expect(s.tier).toBe('pro');
    expect(s.aspect).toBe('4:3');
  });

  it('swaps a paused calibration model within its family and records the swap; a hidden one moves without a record', () => {
    const paused = calibrationSlates({ day: START, health: { 'nano-banana-pro': 'down' } });
    expect(paused[0].model).toBe('nano-banana-2.1');
    expect(paused[0].swap).toEqual({ from: 'nano-banana-pro', reason: 'paused' });
    expect(paused[0].blocked).toBeUndefined();
    for (const s of paused.slice(1)) expect(s.swap, s.model).toBeUndefined();
    // A model that is only hidden is replaced without a paused record.
    const hidden = calibrationSlates({ day: START, registry: withPickable(['gpt-image-2.6-sunburst'], false) });
    expect(hidden[1].model).toBe('gpt-image-2.6-flare');
    expect(hidden[1].swap).toBeUndefined();
    // Every model of the family paused: held, not moved to the other family.
    const held = calibrationSlates({ day: START, health: { 'nano-banana-pro': 'down', 'nano-banana-2.1': 'down' } });
    expect(held[0].blocked).toBe('model_paused');
    expect(held[0].family).toBe('gemini');
  });

  it('premises are the public sample reader text', () => {
    for (const s of calibrationSlates({ day: START })) {
      expect(STORY_SOURCE).toContain(`title: '${s.calibration!.title}'`);
      for (const page of s.calibration!.pages) expect(STORY_SOURCE).toContain(`'${page}'`);
    }
  });
});

describe('checkHouseText (invented names only)', () => {
  it('passes an original premise', () => {
    expect(checkHouseText('Two otters run a night bakery on a floating market and lose their best whisk.', NO_IP)).toEqual({ ok: true, hits: [] });
    expect(checkHouseText(['Class president Mira plans the science fair.', 'A ram climbs the hill at dawn.'], NO_IP).ok).toBe(true);
  });

  it('refuses religious texts and figures, in several scripts and with tricks', () => {
    for (const t of [
      'A retelling of the Ramayana in space',
      'Scenes from the Mahabharata',
      'A Bible story for kids',
      'Verses of the Quran',
      'Lord Krishna meets a robot',
      'Rāmāyaṇa with diacritics',
      'Ram​ayana with a zero-width space',
      'रामायण की कहानी',
      'Una historia de la Biblia',
      '聖書の物語',
      'ブッダの旅', // voiced kana survive the normalisation
      'ﾌﾞｯﾀﾞの旅' // half-width forms fold to the same word
    ]) {
      const r = checkHouseText(t, NO_IP);
      expect(r.ok, t).toBe(false);
      expect(r.hits[0].topic, t).toBe('religion');
    }
  });

  it('refuses real-people framings with invented names', () => {
    for (const t of ['President Varnok Tellurin saves the city', 'Prime Minister Quessaly Dorne wins', 'Based on the life of a famous inventor', 'A biopic of a pop star']) {
      const r = checkHouseText(t, NO_IP);
      expect(r.ok, t).toBe(false);
      expect(r.hits.map((h) => h.topic), t).toContain('real_person');
    }
  });

  it('refuses real events, politics, brands and existing characters', () => {
    expect(checkHouseText('A love story during World War II', NO_IP).hits[0].topic).toBe('real_event');
    expect(checkHouseText('Two rival political parties in a town', NO_IP).hits[0].topic).toBe('politics');
    expect(checkHouseText('A kid who loves Pepsi', NO_IP).hits[0].topic).toBe('brand');
    expect(checkHouseText('Sherlock Holmes in a submarine', NO_IP).hits[0].topic).toBe('existing_character');
  });

  it('refuses LIBRARY_IP_BLOCKLIST hits and what the server\'s named-IP detector finds', () => {
    const r = checkHouseText('A robot heist in the style of Pixar', NO_IP);
    expect(r.ok).toBe(false);
    expect(r.hits[0]).toEqual({ topic: 'existing_character', term: 'Pixar' });
    const named = checkHouseText('A duck called Zibbo the Bright', { namedIp: (t) => (t.includes('Zibbo') ? ['Zibbo the Bright'] : []) });
    expect(named).toEqual({ ok: false, hits: [{ topic: 'existing_character', term: 'Zibbo the Bright' }] });
  });

  // Everyday text in the house's own source languages and genres: none of it may hold a comic.
  it.each([
    '¡Agárrate a la rama, Tomás!',
    'A rama do arvoredo balança.',
    'A parliament of owls gathers at dusk',
    'The office politics of a bakery',
    'Her crusade to save the old park',
    'A cold war between two cats',
    'A Hercules beetle climbs a leaf',
    'Kali the kitten learns to swim',
    'The ramen shop on Rama Street',
    'イエスかノーで答えて！',
    'Una guerra fría entre dos gatos',
    'La elección de Mira: ¿pan o pastel?',
    'El presidente de la clase organiza la feria',
    'O presidente do clube de xadrez chega cedo'
  ])('passes everyday text: %s', (t) => {
    expect(checkHouseText(t, NO_IP)).toEqual({ ok: true, hits: [] });
  });

  it('still refuses the religious figures and named events those words stood for', () => {
    for (const [t, topic] of [
      ['Rama and Sita cross the ocean', 'religion'],
      ['Sita waits for Rama in the forest', 'religion'],
      ['Lord Rama returns home', 'religion'],
      ['Jai Shri Ram, says the crowd', 'religion'],
      ['Goddess Kali dances on the hill', 'religion'],
      ['イエス様の話', 'religion'],
      ['イエス・キリストの物語', 'religion'],
      ['Party politics in a small town', 'politics'],
      ['A parliamentary election in the village', 'politics'],
      ['A spy story set in the Cold War', 'real_event'],
      ['Knights ride off to the Crusades', 'real_event'],
      ['Hercules wrestles the lion', 'existing_character']
    ] as const) {
      const r = checkHouseText(t, NO_IP);
      expect(r.ok, t).toBe(false);
      expect(r.hits.map((h) => h.topic), t).toContain(topic);
    }
  });

  it('refuses titles of office, real events and politics in Spanish, Portuguese, French, Hindi and Japanese (invented names)', () => {
    for (const [t, topic] of [
      ['El presidente Varnok salva la ciudad', 'real_person'],
      ['La presidenta Quessaly Dorne gana', 'real_person'],
      ['O presidente Varnok salva a cidade', 'real_person'],
      ['El primer ministro Tellurin habla', 'real_person'],
      ['O primeiro-ministro Tellurin fala', 'real_person'],
      ['Le Premier ministre Varnok parle', 'real_person'],
      ['El gobernador Varnok inaugura el puente', 'real_person'],
      ['प्रधानमंत्री वार्नोक शहर बचाते हैं', 'real_person'],
      ['राष्ट्रपति वार्नोक का दिन', 'real_person'],
      ['ヴァルノク大統領が街を救う', 'real_person'],
      ['Una historia durante la Segunda Guerra Mundial', 'real_event'],
      ['Uma história na Primeira Guerra Mundial', 'real_event'],
      ['Pendant la Seconde Guerre mondiale', 'real_event'],
      ['Espías en la Guerra Fría', 'real_event'],
      ['Uma família no Holocausto', 'real_event'],
      ['विश्व युद्ध के समय की कहानी', 'real_event'],
      ['第二次世界大戦の物語', 'real_event'],
      ['Dos partidos políticos en un pueblo', 'politics'],
      ['A campanha eleitoral de Varnok', 'politics'],
      ['Deux partis politiques dans un village', 'politics'],
      ['चुनाव प्रचार का दिन', 'politics'],
      ['二つの政党の争い', 'politics']
    ] as const) {
      const r = checkHouseText(t, NO_IP);
      expect(r.ok, t).toBe(false);
      expect(r.hits.map((h) => h.topic), t).toContain(topic);
    }
  });

  it('reads the IP list on the composed text, so its "webtoon™" form matches', () => {
    const r = checkHouseText('A Webtoon™ original', NO_IP);
    expect(r.ok).toBe(false);
    expect(r.hits).toEqual([{ topic: 'existing_character', term: 'Webtoon™' }]);
    // The plain word is a comic kind, not a brand.
    expect(checkHouseText('A webtoon about two otters', NO_IP).ok).toBe(true);
    // Accent-folded forms still match.
    expect(checkHouseText('A Pokémon-style monster', NO_IP).ok).toBe(false);
  });

  it('fails closed on input that is not text and on a missing named-IP detector', () => {
    const notText = checkHouseText({ premise: 'A retelling of the Ramayana' } as never, NO_IP);
    expect(notText).toEqual({ ok: false, hits: [], refused: 'not_text' });
    expect(checkHouseText(['An otter bakery', 7] as never, NO_IP)).toEqual({ ok: false, hits: [], refused: 'not_text' });
    expect(checkHouseText(null as never, NO_IP).refused).toBe('not_text');
    // A runner that forgets the detector is refused instead of letting trademarked names through.
    expect(checkHouseText('Shrek and Garfield open a bakery', {} as never)).toEqual({ ok: false, hits: [], refused: 'no_named_ip_check' });
    expect(checkHouseText('An otter bakery', undefined as never).refused).toBe('no_named_ip_check');
    // With the detector the same text is checked as usual.
    expect(checkHouseText('Shrek and Garfield open a bakery', { namedIp: (t) => (t.includes('Shrek') ? ['Shrek'] : []) }).hits).toEqual([{ topic: 'existing_character', term: 'Shrek' }]);
    expect(checkHouseText('An otter bakery', NO_IP)).toEqual({ ok: true, hits: [] });
  });

  it('the blocklist and the brief rules are written down', () => {
    expect(HOUSE_TOPIC_BLOCKLIST.length).toBeGreaterThan(0);
    for (const r of HOUSE_TOPIC_BLOCKLIST) expect(r.re.global).toBe(false);
    expect(HOUSE_CONTENT_RULES.join(' ')).toMatch(/religious/i);
    expect(HOUSE_CONTENT_RULES.join(' ')).toMatch(/real people/i);
  });
});

describe('payerOfModel', () => {
  it('books OpenAI and Anthropic to the owner\'s credits only when that vendor is on BYOK', () => {
    expect(payerOfModel('openai/gpt-image-2.6-sunburst')).toBe('house_openrouter');
    expect(payerOfModel('anthropic/claude-sonnet-5.5')).toBe('house_openrouter');
    const byok = parseHouseByokVendors('openai, anthropic');
    expect(byok).toEqual(['openai', 'anthropic']);
    expect(payerOfModel('openai/gpt-image-2.6-sunburst', byok)).toBe('openai_credit');
    expect(payerOfModel('gpt-image-2.5', byok)).toBe('openai_credit'); // a registry id
    expect(payerOfModel('anthropic/claude-sonnet-5.5', byok)).toBe('anthropic_credit');
    expect(payerOfModel('~Anthropic/Claude-Sonnet-5.5', byok)).toBe('anthropic_credit');
    expect(payerOfModel('anthropic/claude-sonnet-5.5', ['openai'])).toBe('house_openrouter');
    expect(payerOfModel('google/gemini-4-argon', byok)).toBe('house_openrouter');
    expect(payerOfModel('nano-banana-2.1', byok)).toBe('house_openrouter');
    expect(payerOfModel('', byok)).toBe('house_openrouter');
    expect(payerOfModel(undefined, byok)).toBe('house_openrouter');
  });

  it('parses the BYOK vendor list strictly', () => {
    expect(parseHouseByokVendors(undefined)).toEqual([]);
    expect(parseHouseByokVendors('')).toEqual([]);
    expect(parseHouseByokVendors('OpenAI,openai,google,anthropic ')).toEqual(['openai', 'anthropic']);
  });
});

describe('dayBudgetUsd (runway)', () => {
  const openai: HousePayerConfig = { dayCapUsd: 12, creditUsd: 200, stopFraction: 0.9, runwayUntil: null, expiresOn: null };

  it('without a runway date: the day cap, never past the credit stop', () => {
    expect(dayBudgetUsd(openai, { day: START, lifetimeUsd: 0 })).toBe(12);
    expect(dayBudgetUsd(openai, { day: START, lifetimeUsd: 175 })).toBe(5); // 180 − 175
    expect(dayBudgetUsd(openai, { day: START, lifetimeUsd: 180 })).toBe(0);
    expect(dayBudgetUsd(openai, { day: START, lifetimeUsd: 250 })).toBe(0);
  });

  it('with a runway date: the room left spread over the days left (today included)', () => {
    const p = { ...openai, runwayUntil: '2026-12-30' }; // 30 days from START
    expect(dayBudgetUsd(p, { day: START, lifetimeUsd: 0 })).toBe(6); // 180 / 30
    expect(dayBudgetUsd(p, { day: START, lifetimeUsd: 90 })).toBe(3); // 90 / 30
    expect(dayBudgetUsd({ ...p, runwayUntil: '2027-12-31' }, { day: START, lifetimeUsd: 0 })).toBeCloseTo(180 / 396, 3);
    // On the last day the rest of the room is usable, capped by the day cap.
    expect(dayBudgetUsd(p, { day: '2026-12-30', lifetimeUsd: 175 })).toBe(5);
    expect(dayBudgetUsd(p, { day: '2026-12-30', lifetimeUsd: 0 })).toBe(12);
    // A runway date in the past no longer spreads anything.
    expect(dayBudgetUsd(p, { day: '2027-01-15', lifetimeUsd: 0 })).toBe(12);
  });

  it('at expiry: usable on the expiry day, nothing after; a runway past expiry ends at expiry', () => {
    const p = { ...openai, expiresOn: '2026-12-10' };
    expect(dayBudgetUsd(p, { day: '2026-12-10', lifetimeUsd: 0 })).toBe(12);
    expect(dayBudgetUsd(p, { day: '2026-12-11', lifetimeUsd: 0 })).toBe(0);
    const runway = { ...p, runwayUntil: '2027-03-01' };
    expect(dayBudgetUsd(runway, { day: START, lifetimeUsd: 0 })).toBe(12); // 180 over 10 days = 18, capped at 12
    expect(dayBudgetUsd(runway, { day: '2026-12-09', lifetimeUsd: 170 })).toBe(5); // 10 over 2 days
  });

  it('the house OpenRouter payer has no credit: its day cap', () => {
    expect(dayBudgetUsd(HOUSE_CONFIG_DEFAULTS.payers.house_openrouter, { day: START, lifetimeUsd: 999 })).toBe(10);
  });

  it('fails closed on bad input', () => {
    expect(dayBudgetUsd(openai, { day: 'soon', lifetimeUsd: 0 })).toBe(0);
    expect(dayBudgetUsd(openai, { day: START, lifetimeUsd: Number.NaN })).toBe(0);
    expect(dayBudgetUsd({ ...openai, dayCapUsd: Number.NaN }, { day: START, lifetimeUsd: 0 })).toBe(0);
    expect(dayBudgetUsd({ ...openai, dayCapUsd: -3 }, { day: START, lifetimeUsd: 0 })).toBe(0);
  });

  it('never reads a day cap above the compiled day ceiling, even from a config that skipped normalizeHouseConfig', () => {
    expect(dayBudgetUsd({ ...openai, dayCapUsd: 1e6, creditUsd: null }, { day: START, lifetimeUsd: 0 })).toBe(HOUSE_LIMITS.capDayMaxUsd);
    expect(dayBudgetUsd({ ...openai, dayCapUsd: 1e6, creditUsd: 5_000 }, { day: START, lifetimeUsd: 0 })).toBe(HOUSE_LIMITS.capDayMaxUsd);
    expect(dayBudgetUsd({ ...openai, dayCapUsd: 70 }, { day: START, lifetimeUsd: 0 })).toBe(70);
  });
});

describe('houseCreditStopped', () => {
  const openai = HOUSE_CONFIG_DEFAULTS.payers.openai_credit;
  it('is true once lifetime spend reaches credit × stop share', () => {
    expect(houseCreditStopped(openai, { lifetimeUsd: 0 })).toBe(false);
    expect(houseCreditStopped(openai, { lifetimeUsd: 179.99 })).toBe(false);
    expect(houseCreditStopped(openai, { lifetimeUsd: 180 })).toBe(true);
    expect(houseCreditStopped(openai, { lifetimeUsd: 250 })).toBe(true);
    // It agrees with dayBudgetUsd at the stop.
    expect(dayBudgetUsd(openai, { day: START, lifetimeUsd: 180 })).toBe(0);
    expect(dayBudgetUsd(openai, { day: START, lifetimeUsd: 179.99 })).toBeGreaterThan(0);
  });

  it('never stops a payer without a credit, and fails closed on bad input', () => {
    expect(houseCreditStopped(HOUSE_CONFIG_DEFAULTS.payers.house_openrouter, { lifetimeUsd: 1e9 })).toBe(false);
    expect(houseCreditStopped({ ...openai, creditUsd: 0 }, { lifetimeUsd: 0 })).toBe(true);
    expect(houseCreditStopped(openai, { lifetimeUsd: Number.NaN })).toBe(true);
    expect(houseCreditStopped({ ...openai, stopFraction: Number.NaN }, { lifetimeUsd: 0 })).toBe(true);
    // The stop share is never read above its ceiling.
    expect(houseCreditStopped({ ...openai, stopFraction: 5 }, { lifetimeUsd: 190 })).toBe(true);
  });
});

describe('sanitizeHouseConfigPatch', () => {
  const refused = (patch: unknown, current?: HouseConfig) => {
    const r = sanitizeHouseConfigPatch(patch, current);
    expect(r.ok, JSON.stringify(patch)).toBe(false);
    return r.ok ? [] : r.errors.map((e) => e.field);
  };

  it('refuses values above the ceilings', () => {
    expect(refused({ capComicUsd: 7.01 })).toEqual(['capComicUsd']);
    expect(refused({ dailyCount: 11 })).toEqual(['dailyCount']);
    expect(refused({ capDayUsd: 70.01 })).toEqual(['capDayUsd']);
    expect(refused({ imageSlots: 3 })).toEqual(['imageSlots']);
    expect(refused({ releasePerDay: 11 })).toEqual(['releasePerDay']);
    expect(refused({ payers: { openai_credit: { dayCapUsd: 71 } } })).toEqual(['payers.openai_credit.dayCapUsd']);
    expect(refused({ payers: { anthropic_credit: { stopFraction: 0.99 } } })).toEqual(['payers.anthropic_credit.stopFraction']);
    expect(refused({ modelWeights: { 'nano-banana-2.1': 11 } })).toEqual(['modelWeights.nano-banana-2.1']);
  });

  it('refuses bad shapes, unknown fields and the platform payer', () => {
    expect(refused(null)).toEqual(['patch']);
    expect(refused([])).toEqual(['patch']);
    expect(refused({ capComicUsd: '5' })).toEqual(['capComicUsd']);
    expect(refused({ capComicUsd: 0 })).toEqual(['capComicUsd']);
    expect(refused({ capComicUsd: Number.NaN })).toEqual(['capComicUsd']);
    expect(refused({ dailyCount: 2.5 })).toEqual(['dailyCount']);
    expect(refused({ enabled: 'yes' })).toEqual(['enabled']);
    expect(refused({ mode: 'turbo' })).toEqual(['mode']);
    expect(refused({ budgetUsd: 3 })).toEqual(['budgetUsd']);
    expect(refused({ payers: { platform: { dayCapUsd: 1 } } })).toEqual(['payers.platform']);
    expect(refused({ payers: { openai_credit: { runwayUntil: '2026-13-01' } } })).toEqual(['payers.openai_credit.runwayUntil']);
    expect(refused({ payers: { openai_credit: { bonus: 1 } } })).toEqual(['payers.openai_credit.bonus']);
    expect(refused({ modelWeights: { 'flux-3': 1 } })).toEqual(['modelWeights.flux-3']);
    // The finishing reserve must stay below the comic cap it is carved from.
    expect(refused({ capComicUsd: 0.3 })).toEqual(['finishReserveUsd']);
    expect(refused({ finishReserveUsd: 2.5 })).toEqual(['finishReserveUsd']);
  });

  it('accepts lower values and returns the merged config', () => {
    const r = sanitizeHouseConfigPatch({
      enabled: true,
      mode: 'rehearsal',
      dailyCount: 10,
      capComicUsd: 5,
      capDayUsd: 20,
      releasePerDay: 1,
      modelWeights: { 'gpt-image-2.6-flare': 2 },
      payers: { openai_credit: { dayCapUsd: 8, runwayUntil: '2027-01-31', expiresOn: '2027-02-28' }, anthropic_credit: { creditUsd: 150 } }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.enabled).toBe(true);
    expect(r.config.mode).toBe('rehearsal');
    expect(r.config.dailyCount).toBe(10);
    expect(r.config.capComicUsd).toBe(5);
    expect(r.config.modelWeights).toEqual({ 'gpt-image-2.6-flare': 2 });
    expect(r.config.payers.openai_credit).toEqual({ dayCapUsd: 8, creditUsd: 200, stopFraction: 0.9, runwayUntil: '2027-01-31', expiresOn: '2027-02-28' });
    expect(r.config.payers.anthropic_credit.creditUsd).toBe(150);
    expect(r.config.payers.house_openrouter).toEqual(HOUSE_CONFIG_DEFAULTS.payers.house_openrouter);
    expect(r.patch).not.toHaveProperty('payers.house_openrouter');
    // The defaults themselves are never mutated.
    expect(HOUSE_CONFIG_DEFAULTS.enabled).toBe(false);
    // Clearing a date takes null.
    const cleared = sanitizeHouseConfigPatch({ payers: { openai_credit: { runwayUntil: null } } }, r.config);
    expect(cleared.ok && cleared.config.payers.openai_credit.runwayUntil).toBe(null);
  });

  it('accepts exactly the ceilings', () => {
    const r = sanitizeHouseConfigPatch({ capComicUsd: 7, dailyCount: 10, capDayUsd: 70, imageSlots: 2, releasePerDay: 10 });
    expect(r.ok).toBe(true);
  });

  it('never lets the OpenAI or Anthropic credit stop be switched off (a cleared credit is refused)', () => {
    for (const payer of ['openai_credit', 'anthropic_credit'] as const) {
      expect(houseCreditOptional(payer), payer).toBe(false);
      const r = sanitizeHouseConfigPatch({ payers: { [payer]: { creditUsd: null } } });
      expect(r.ok, payer).toBe(false);
      expect(r.errors, payer).toEqual([{ field: `payers.${payer}.creditUsd`, reason: 'a credit amount is required' }]);
      // A real amount is still accepted.
      expect(sanitizeHouseConfigPatch({ payers: { [payer]: { creditUsd: 50 } } }).ok, payer).toBe(true);
    }
    // The house OpenRouter key has its own daily limit: no credit is allowed there.
    expect(houseCreditOptional('house_openrouter')).toBe(true);
    const house = sanitizeHouseConfigPatch({ payers: { house_openrouter: { creditUsd: null } } });
    expect(house.ok && house.config.payers.house_openrouter.creditUsd).toBe(null);
  });

  // Keys that name Object.prototype members must be unknown fields, never inherited checks.
  const PROTO_KEYS = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__'];
  it.each(PROTO_KEYS)('refuses the body key %s as an unknown field and never throws', (key) => {
    const top = JSON.parse(`{"${key}": 5}`) as unknown;
    let r: ReturnType<typeof sanitizeHouseConfigPatch> | undefined;
    expect(() => (r = sanitizeHouseConfigPatch(top))).not.toThrow();
    expect(r!.ok).toBe(false);
    expect(r!.errors).toEqual([{ field: key, reason: 'unknown field' }]);
    const nested = JSON.parse(`{"payers": {"openai_credit": {"${key}": 9}}}`) as unknown;
    expect(() => (r = sanitizeHouseConfigPatch(nested))).not.toThrow();
    expect(r!.ok).toBe(false);
    expect(r!.errors).toEqual([{ field: `payers.openai_credit.${key}`, reason: 'unknown field' }]);
    // An object value under the key (the shape that made __proto__ throw) is refused the same way.
    const objectValue = JSON.parse(`{"${key}": {"enabled": true}}`) as unknown;
    expect(() => (r = sanitizeHouseConfigPatch(objectValue))).not.toThrow();
    expect(r!.ok).toBe(false);
  });
});

describe('normalizeHouseConfig (reading a stored row)', () => {
  it('clamps stored values to the ceilings and fails closed', () => {
    const c = normalizeHouseConfig({ enabled: 'true', mode: 'turbo', dailyCount: 40, capComicUsd: 9, capDayUsd: 500, imageSlots: 5, releasePerDay: 99, allow4k: 1, payers: { openai_credit: { dayCapUsd: 1e6, stopFraction: 2, creditUsd: -5 } } });
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('off');
    expect(c.dailyCount).toBe(10);
    expect(c.capComicUsd).toBe(7);
    expect(c.capDayUsd).toBe(70);
    expect(c.imageSlots).toBe(2);
    expect(c.releasePerDay).toBe(10);
    expect(c.allow4k).toBe(false);
    expect(c.payers.openai_credit.dayCapUsd).toBe(70);
    expect(c.payers.openai_credit.stopFraction).toBe(HOUSE_LIMITS.stopFractionMax);
    expect(c.payers.openai_credit.creditUsd).toBe(0);
    expect(normalizeHouseConfig(undefined)).toEqual(HOUSE_CONFIG_DEFAULTS);
    expect(normalizeHouseConfig({ enabled: true, mode: 'daily' })).toMatchObject({ enabled: true, mode: 'daily' });
  });

  it('reads a null, missing or broken credit on the OpenAI and Anthropic payers as no room, never as no stop', () => {
    for (const credit of [null, undefined, 'lots', Number.NaN]) {
      const c = normalizeHouseConfig({
        payers: { openai_credit: { creditUsd: credit, dayCapUsd: 12 }, anthropic_credit: { creditUsd: credit, dayCapUsd: 5 }, house_openrouter: { creditUsd: credit, dayCapUsd: 10 } }
      });
      expect(c.payers.openai_credit.creditUsd, String(credit)).toBe(0);
      expect(c.payers.anthropic_credit.creditUsd, String(credit)).toBe(0);
      expect(dayBudgetUsd(c.payers.anthropic_credit, { day: START, lifetimeUsd: 9999 }), String(credit)).toBe(0);
      expect(dayBudgetUsd(c.payers.openai_credit, { day: START, lifetimeUsd: 0 }), String(credit)).toBe(0);
      expect(houseCreditStopped(c.payers.openai_credit, { lifetimeUsd: 0 }), String(credit)).toBe(true);
      // The house OpenRouter key keeps no credit stop (its own daily limit).
      expect(c.payers.house_openrouter.creditUsd, String(credit)).toBeNull();
      expect(dayBudgetUsd(c.payers.house_openrouter, { day: START, lifetimeUsd: 9999 }), String(credit)).toBe(10);
    }
    // A payer object with no credit field reads the same.
    expect(normalizeHouseConfig({ payers: { anthropic_credit: { dayCapUsd: 5 } } }).payers.anthropic_credit.creditUsd).toBe(0);
    // A stored amount is kept (clamped).
    expect(normalizeHouseConfig({ payers: { openai_credit: { creditUsd: 150 } } }).payers.openai_credit.creditUsd).toBe(150);
    expect(normalizeHouseConfig({ payers: { openai_credit: { creditUsd: 1e9 } } }).payers.openai_credit.creditUsd).toBe(HOUSE_LIMITS.creditMaxUsd);
  });

  it('keeps the finishing reserve no higher than the comic cap', () => {
    const c = normalizeHouseConfig({ capComicUsd: 0.3, finishReserveUsd: 2 });
    expect(c.capComicUsd).toBe(0.3);
    expect(c.finishReserveUsd).toBeLessThanOrEqual(0.3);
    expect(normalizeHouseConfig({ capComicUsd: 5, finishReserveUsd: 1.5 }).finishReserveUsd).toBe(1.5);
  });
});

describe('silentFormatInstructions', () => {
  it('asks for wordless pages with at most one short caption per page', () => {
    const text = silentFormatInstructions({ kind: 'comic', pages: 2 });
    expect(text).toMatch(/no speech balloons/i);
    expect(text).toMatch(/no thought balloons/i);
    expect(text).toMatch(/at most one caption/i);
    expect(text).toMatch(/2 pages/);
    expect(silentFormatInstructions({ kind: 'strip', pages: 1 })).toMatch(/1 page\b/);
  });
});

describe('day helpers', () => {
  it('validates and counts UTC calendar days', () => {
    expect(isHouseDay('2026-12-01')).toBe(true);
    expect(isHouseDay('2026-02-29')).toBe(false);
    expect(isHouseDay('2028-02-29')).toBe(true);
    expect(isHouseDay('2026-1-1')).toBe(false);
    expect(addHouseDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addHouseDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(houseDaysBetween('2026-12-01', '2026-12-30')).toBe(29);
  });

  it('every preset id the planner knows is a real look', () => {
    expect(STYLE_PRESETS).toHaveLength(24);
  });
});
