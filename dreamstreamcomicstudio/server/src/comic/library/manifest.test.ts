// @vitest-environment node
// Library manifest (assets.md §3, §13, §15; styles.md §5–§6.2, Program 3 ST-4): ids, three core
// samples for every preset (scene, cast bust, swatch), model/aspect support, the no-text clause, the
// spot-colour clause, the IP lint (no artist/brand names anywhere), hash stability, and the quote.
import { describe, expect, it } from 'vitest';
import { LIBRARY_ID_RE, LIBRARY_IP_BLOCKLIST, styleAnchorId, stylePreviewId } from '../../../../shared/comic/library.js';
import { getImageModel, libraryAssetCostUsd } from '../../../../shared/comic/models.js';
import { STYLE_PRESETS, spotAccentOf } from '../../../../shared/comic/stylePresets.js';
import { CAST_SUBJECT, LIBRARY_CORE_COUNT, LIBRARY_MANIFEST, NO_TEXT, SAMPLE_SCENE, hueName, promptHash, selectEntries, styleCastId } from './manifest.js';
import { planQuote } from './runner.js';
import { testLibrary } from './testkit.js';

describe('library manifest', () => {
  it('has 98 core entries (anchors are core now) with unique, URL-safe ids', () => {
    expect(STYLE_PRESETS).toHaveLength(24);
    expect(LIBRARY_CORE_COUNT).toBe(98);
    expect(LIBRARY_MANIFEST).toHaveLength(98);
    expect(LIBRARY_MANIFEST.filter((e) => e.optional)).toHaveLength(0);
    const ids = LIBRARY_MANIFEST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(LIBRARY_ID_RE);
  });

  it('every preset has a scene preview, a cast bust and a core anchor, all 1K 4:5 on the default page model', () => {
    for (const p of STYLE_PRESETS) {
      const scene = LIBRARY_MANIFEST.find((e) => e.id === stylePreviewId(p.id));
      const cast = LIBRARY_MANIFEST.find((e) => e.id === styleCastId(p.id));
      const anchor = LIBRARY_MANIFEST.find((e) => e.id === styleAnchorId(p.id));
      expect(scene?.kind, p.id).toBe('style_preview');
      expect(cast?.kind, p.id).toBe('style_preview');
      expect(anchor?.kind, p.id).toBe('style_anchor');
      for (const e of [scene!, cast!, anchor!]) {
        expect(e.optional, e.id).toBeFalsy();
        expect(e.presetId, e.id).toBe(p.id);
        expect([e.model, e.resolution, e.aspect], e.id).toEqual(['nano-banana-2.1', '1K', '4:5']);
        expect(e.prompt, e.id).toContain(p.spec);
        expect(e.tags, e.id).toEqual(expect.arrayContaining([p.id, p.tags.colour, p.tags.medium]));
      }
    }
    // The cast id never shadows the exact preview id the client asks for (useComicLibrary.preview).
    expect(styleCastId('noir-ink')).toBe('style.noir-ink.cast');
    expect(LIBRARY_MANIFEST.filter((e) => e.kind === 'style_preview')).toHaveLength(48);
    expect(LIBRARY_MANIFEST.filter((e) => e.kind === 'style_anchor')).toHaveLength(24);
  });

  it('cast busts draw the same original character in every style; scenes keep the shared scene', () => {
    const casts = STYLE_PRESETS.map((p) => LIBRARY_MANIFEST.find((e) => e.id === styleCastId(p.id))!);
    for (const c of casts) {
      expect(c.prompt, c.id).toContain(CAST_SUBJECT);
      expect(c.prompt, c.id).not.toContain(SAMPLE_SCENE);
      expect(c.subject, c.id).toBe(CAST_SUBJECT);
      expect(c.alt, c.id).toMatch(/portrait of a girl/);
    }
    for (const p of STYLE_PRESETS) expect(LIBRARY_MANIFEST.find((e) => e.id === stylePreviewId(p.id))!.prompt).toContain(SAMPLE_SCENE);
    // An original, platform-written character: no user content, no named or existing character.
    expect(CAST_SUBJECT).not.toMatch(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/);
    expect(LIBRARY_IP_BLOCKLIST.test(CAST_SUBJECT)).toBe(false);
  });

  it('spot-colour looks say where their one accent goes; b/w looks stay black and white', () => {
    const spot = STYLE_PRESETS.filter((p) => p.tags.colour === 'spot');
    expect(spot.map((p) => p.id)).toEqual(['ink-one-colour', 'mono-wash']);
    for (const p of spot) {
      const accent = spotAccentOf(p.palette)!;
      const at = (id: string) => LIBRARY_MANIFEST.find((e) => e.id === id)!.prompt;
      expect(at(stylePreviewId(p.id))).toContain(`a single spot colour, ${hueName(accent)} (${accent}), used only on the girl's raincoat and the paper boat`);
      expect(at(styleCastId(p.id))).toContain(`(${accent}), used only on the raincoat`);
      expect(at(styleAnchorId(p.id))).toContain(`(${accent}), used only on the teacup`);
      expect(at(stylePreviewId(p.id))).not.toContain('Use only the listed inks.');
    }
    expect(hueName('#d62839')).toBe('red');
    expect(hueName('#2b59c3')).toBe('blue');
    expect(hueName('#777777')).toBe('grey');
    for (const p of STYLE_PRESETS.filter((x) => x.colorMode === 'bw')) {
      for (const id of [stylePreviewId(p.id), styleCastId(p.id), styleAnchorId(p.id)]) {
        expect(LIBRARY_MANIFEST.find((e) => e.id === id)!.prompt, id).toMatch(/Strictly black and white with grey tones only/);
      }
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

  it('selection: everything is core by default, kinds and ids narrow it', () => {
    expect(selectEntries({}).entries).toHaveLength(98);
    expect(selectEntries({ includeOptional: true }).entries).toHaveLength(98);
    expect(selectEntries({ kinds: ['style_anchor'] }).entries).toHaveLength(24);
    expect(selectEntries({ kinds: ['style_preview', 'style_anchor'] }).entries).toHaveLength(72);
    // An optional entry (none ship today) still waits to be asked for.
    const withOptional = [...LIBRARY_MANIFEST, { ...LIBRARY_MANIFEST[0], id: 'style.extra', optional: true }];
    expect(selectEntries({}, withOptional).entries).toHaveLength(98);
    expect(selectEntries({ includeOptional: true }, withOptional).entries).toHaveLength(99);
    expect(selectEntries({ kinds: ['cover_example'] }).entries.map((e) => e.id)).toEqual(['cover.kids-storybook', 'cover.superhero']);
    const sel = selectEntries({ ids: ['style.noir-ink', 'style.nope', '../x'] });
    expect(sel.entries.map((e) => e.id)).toEqual(['style.noir-ink']);
    expect(sel.unknown).toEqual(['style.nope', '../x']);
  });

  it('quote(all core) ≈ $4.48 at registry prices (≈ +$2.20 for the 60 new style samples), with no spend', async () => {
    const t = testLibrary({ manifest: [...LIBRARY_MANIFEST] });
    const { quote } = await planQuote(t.deps, {});
    const expected = LIBRARY_MANIFEST.filter((e) => !e.optional).reduce((n, e) => n + libraryAssetCostUsd(e.model, e.resolution), 0);
    expect(quote.images).toBe(98);
    expect(quote.usd).toBeCloseTo(expected, 3);
    expect(quote.usd).toBeGreaterThan(4.46);
    expect(quote.usd).toBeLessThan(4.5);
    const styleLines = quote.lines.filter((l) => l.kind === 'style_preview' || l.kind === 'style_anchor');
    expect(styleLines.reduce((n, l) => n + l.count, 0)).toBe(72);
    expect(styleLines.reduce((n, l) => n + l.usd, 0)).toBeCloseTo(72 * libraryAssetCostUsd('nano-banana-2.1', '1K'), 3);
    expect(quote.lines.map((l) => l.kind).sort()).toEqual(['cover_example', 'empty_state', 'genre_example', 'onboarding', 'style_anchor', 'style_preview', 'texture_seed']);
    expect(quote.worstCaseUsd).toBeLessThan(25);
    expect(t.images.calls).toHaveLength(0);
  });
});
