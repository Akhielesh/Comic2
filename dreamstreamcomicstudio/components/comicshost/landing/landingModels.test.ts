// @vitest-environment node
// The landing's names and numbers are the registries' own: the default image model (the Draft and Standard tiers'
// model, the one every account can use), the other models the picker offers, the two quality levels, the page cap,
// the looks and the languages. Only names members see leave the module: never a registry id or a price.
import { describe, expect, it } from 'vitest';
import { DOC_LIMITS } from '../../../shared/comic/limits';
import { LANGUAGES } from '../../../shared/comic/languages';
import { FREE_PLAN_IMAGE_MODEL } from '../../../shared/comic/modelLock';
import { IMAGE_MODELS, TIER_PRESETS, getImageModel, pickableImageModels } from '../../../shared/comic/models';
import { STYLE_PRESETS } from '../../../shared/comic/stylePresets';
import { DEFAULT_MODEL, LANDING_VALUES, LANGS, LOOKS, OTHER_MODELS, PAGES_MAX, QUALITY, listOf, statusNote } from './landingModels';

describe('landingModels', () => {
  it('the default model is the one Draft, Standard and every account draw with, named as members see it', () => {
    expect(TIER_PRESETS.draft.model).toBe(TIER_PRESETS.standard.model);
    expect(FREE_PLAN_IMAGE_MODEL).toBe(TIER_PRESETS.standard.model);
    const spec = getImageModel(TIER_PRESETS.standard.model)!;
    expect(DEFAULT_MODEL).toEqual({ name: spec.nickname, characters: spec.refs.characters });
    expect(spec.pickable).toBe(true);
  });

  it('the other models are exactly the picker’s other pickable models, by nickname', () => {
    const others = pickableImageModels().filter((m) => m.id !== TIER_PRESETS.standard.model);
    expect(OTHER_MODELS).toEqual(others.map((m) => m.nickname));
    expect(OTHER_MODELS.length).toBeGreaterThan(0);
    // Hidden and retired models are never named.
    for (const hidden of IMAGE_MODELS.filter((m) => !m.pickable)) expect(OTHER_MODELS).not.toContain(hidden.nickname);
  });

  it('the default model needs no status word (generally available); every other model that is not carries its status', () => {
    // "New comics are drawn with …" names it bare, so it must be GA; if this changes, the copy must say so too.
    expect(getImageModel(TIER_PRESETS.standard.model)!.lifecycle).toBe('ga');
    const others = pickableImageModels().filter((m) => m.id !== TIER_PRESETS.standard.model);
    const note = String(LANDING_VALUES.OTHER_MODELS_STATUS);
    for (const [lifecycle, words] of [['experimental', 'experimental'], ['preview', 'in preview']] as const) {
      const names = others.filter((m) => m.lifecycle === lifecycle).map((m) => m.nickname);
      if (names.length) expect(note).toContain(`${listOf(names)} ${names.length === 1 ? 'is' : 'are'} ${words}.`);
    }
    for (const m of others.filter((o) => o.lifecycle === 'ga')) expect(note).not.toContain(m.nickname);
    // Today: the two GPT Image 2.6 models are experimental, and the page says so.
    expect(others.some((m) => m.lifecycle === 'experimental')).toBe(true);
    expect(statusNote([])).toBe('');
    expect(statusNote([{ nickname: 'A', lifecycle: 'ga' }])).toBe('');
    expect(statusNote([{ nickname: 'A', lifecycle: 'experimental' }])).toBe(' A is experimental.');
    expect(statusNote([{ nickname: 'A', lifecycle: 'experimental' }, { nickname: 'B', lifecycle: 'experimental' }, { nickname: 'C', lifecycle: 'preview' }])).toBe(
      ' A and B are experimental. C is in preview.'
    );
  });

  it('Draft draws at a lower resolution than Standard (the page says so in plain words)', () => {
    const order = ['512', '1K', '2K', '4K'];
    const [draft, standard] = QUALITY.map((q) => order.indexOf(q.pageSize));
    expect(draft).toBeGreaterThanOrEqual(0);
    expect(standard).toBeGreaterThan(draft);
  });

  it('the quality levels, page cap, looks and languages are the registries’ numbers', () => {
    expect(QUALITY).toEqual([
      { name: TIER_PRESETS.draft.label, pageSize: TIER_PRESETS.draft.pageRes },
      { name: TIER_PRESETS.standard.label, pageSize: TIER_PRESETS.standard.pageRes }
    ]);
    expect(PAGES_MAX).toBe(DOC_LIMITS.pages);
    expect(LOOKS).toBe(STYLE_PRESETS.length);
    expect(LANGUAGES[0].code).toBe('en');
    expect(LANGS).toBe(LANGUAGES.length - 1);
  });

  it('nothing that leaves the module is a registry id, a route or a price', () => {
    const shown = Object.values(LANDING_VALUES).map(String).join(' | ');
    for (const m of IMAGE_MODELS) {
      expect(shown).not.toContain(m.id);
      for (const route of Object.values(m.routes)) if (route) expect(shown).not.toContain(route);
    }
    expect(shown).not.toMatch(/[$¢€£]|usd|\d+\.\d{2,}/i);
  });

  it('lists read as a sentence', () => {
    expect(listOf([])).toBe('');
    expect(listOf(['A'])).toBe('A');
    expect(listOf(['A', 'B'])).toBe('A and B');
    expect(listOf(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
