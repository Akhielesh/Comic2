// @vitest-environment node
// Library manifest (assets.md §3, §13, §15): ids, coverage of every preset, model/aspect support,
// the no-text clause, the IP lint (no artist/brand names anywhere), hash stability, and the quote.
import { describe, expect, it } from 'vitest';
import { LIBRARY_ID_RE, LIBRARY_IP_BLOCKLIST, styleAnchorId, stylePreviewId } from '../../../../shared/comic/library.js';
import { getImageModel, libraryAssetCostUsd } from '../../../../shared/comic/models.js';
import { STYLE_PRESETS } from '../../../../shared/comic/stylePresets.js';
import { LIBRARY_CORE_COUNT, LIBRARY_MANIFEST, NO_TEXT, promptHash, selectEntries } from './manifest.js';
import { planQuote } from './runner.js';
import { testLibrary } from './testkit.js';

describe('library manifest', () => {
  it('has 38 core entries + 12 optional anchors with unique, URL-safe ids', () => {
    expect(LIBRARY_CORE_COUNT).toBe(38);
    expect(LIBRARY_MANIFEST.filter((e) => e.optional)).toHaveLength(12);
    const ids = LIBRARY_MANIFEST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(LIBRARY_ID_RE);
  });

  it('every preset has a style preview and an optional anchor', () => {
    for (const p of STYLE_PRESETS) {
      expect(LIBRARY_MANIFEST.find((e) => e.id === stylePreviewId(p.id))?.kind).toBe('style_preview');
      expect(LIBRARY_MANIFEST.find((e) => e.id === styleAnchorId(p.id))?.optional).toBe(true);
    }
  });

  it('uses only GA models that support the entry’s aspect and resolution', () => {
    for (const e of LIBRARY_MANIFEST) {
      const spec = getImageModel(e.model);
      expect(spec, e.id).toBeDefined();
      expect(spec!.lifecycle, e.id).not.toBe('deprecated');
      expect(spec!.aspects, e.id).toContain(e.aspect);
      if (spec!.resolutions.length) expect(spec!.resolutions, e.id).toContain(e.resolution);
    }
  });

  it('text-free prompts carry the NO_TEXT clause; covers spell their title in the prompt', () => {
    for (const e of LIBRARY_MANIFEST) {
      if (e.expectedText?.length) for (const t of e.expectedText) expect(e.prompt, e.id).toContain(t);
      else expect(e.prompt, e.id).toContain(NO_TEXT);
    }
  });

  it('lint: no artist, studio or brand names in prompts, alt text or preset copy', () => {
    for (const e of LIBRARY_MANIFEST) {
      expect(LIBRARY_IP_BLOCKLIST.test(e.prompt), `${e.id} prompt`).toBe(false);
      expect(LIBRARY_IP_BLOCKLIST.test(e.alt), `${e.id} alt`).toBe(false);
    }
    for (const p of STYLE_PRESETS) {
      for (const text of [p.name, p.tagline, p.spec, p.linework, ...p.avoid, ...p.bestFor]) {
        expect(LIBRARY_IP_BLOCKLIST.test(text), `${p.id}: ${text}`).toBe(false);
      }
    }
    // The lint really catches names (and doesn't flag ordinary words that contain them).
    expect(LIBRARY_IP_BLOCKLIST.test('Ghibli-esque warmth')).toBe(true);
    expect(LIBRARY_IP_BLOCKLIST.test('Clean lines (Tintin-like)')).toBe(true);
    expect(LIBRARY_IP_BLOCKLIST.test('in the style of Hergé')).toBe(true);
    expect(LIBRARY_IP_BLOCKLIST.test('an allegory of the legend')).toBe(false);
  });

  it('style previews are compiled from the preset spec (an edit changes the hash)', () => {
    const e = LIBRARY_MANIFEST.find((x) => x.id === 'style.noir-ink')!;
    expect(e.prompt).toContain(STYLE_PRESETS.find((p) => p.id === 'noir-ink')!.spec);
    expect(e.prompt).toMatch(/black and white/i);
    const h = promptHash(e);
    expect(promptHash({ ...e })).toBe(h);
    expect(promptHash({ ...e, prompt: `${e.prompt} ` })).not.toBe(h);
    expect(promptHash({ ...e, aspect: '1:1' })).not.toBe(h);
  });

  it('selection: core by default, optional only when asked, kinds and ids narrow it', () => {
    expect(selectEntries({}).entries).toHaveLength(38);
    expect(selectEntries({ includeOptional: true }).entries).toHaveLength(50);
    expect(selectEntries({ kinds: ['style_anchor'] }).entries).toHaveLength(12);
    expect(selectEntries({ kinds: ['cover_example'] }).entries.map((e) => e.id)).toEqual(['cover.kids-storybook', 'cover.superhero']);
    const sel = selectEntries({ ids: ['style.noir-ink', 'style.nope', '../x'] });
    expect(sel.entries.map((e) => e.id)).toEqual(['style.noir-ink']);
    expect(sel.unknown).toEqual(['style.nope', '../x']);
  });

  it('quote(all core) ≈ $2.28 at registry prices, with no spend', async () => {
    const t = testLibrary({ manifest: [...LIBRARY_MANIFEST] });
    const { quote } = await planQuote(t.deps, {});
    const expected = LIBRARY_MANIFEST.filter((e) => !e.optional).reduce((n, e) => n + libraryAssetCostUsd(e.model, e.resolution), 0);
    expect(quote.images).toBe(38);
    expect(quote.usd).toBeCloseTo(expected, 3);
    expect(quote.usd).toBeGreaterThan(2.27);
    expect(quote.usd).toBeLessThan(2.29);
    expect(quote.lines.map((l) => l.kind).sort()).toEqual(['cover_example', 'empty_state', 'genre_example', 'onboarding', 'style_preview', 'texture_seed']);
    expect(quote.worstCaseUsd).toBeLessThan(25);
    expect(t.images.calls).toHaveLength(0);
  });
});
