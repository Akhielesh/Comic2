import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../languages';
import { createEmptyDoc, normalizeDoc } from '../doc';
import {
  FONT_REGISTRY,
  LETTERING_FONT_LICENSES,
  PRO_FONT_REGISTRY,
  fontByFamily,
  fontCoversLanguage,
  fontFaceMeta,
  fontFamilyStack,
  fontString,
  fontsForDoc,
  googleFontsHref,
  resolveLetteringFont,
  type AnyFontFaceMeta
} from './fonts';
import { FONT_IDS, LETTERING_PRESETS, type FontId } from './style';
import { PRO_FONT_IDS } from './proFonts';
import { measureMetrics } from '../../../scripts/build-font-specimens.mjs';

const ROOT = join(__dirname, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

describe('font registry: licence gate and coverage', () => {
  it('has an entry for every FontId and only OFL-1.1 / Apache-2.0 licences', () => {
    expect(Object.keys(FONT_REGISTRY).sort()).toEqual([...FONT_IDS].sort());
    for (const meta of Object.values(FONT_REGISTRY)) {
      expect(LETTERING_FONT_LICENSES).toContain(meta.license);
      expect(['OFL-1.1', 'Apache-2.0']).toContain(meta.license);
    }
  });

  it('every face (12 base, 14 Noto, 28 Pro) is a pinned @fontsource package whose metadata matches the registry', () => {
    const all: AnyFontFaceMeta[] = [...FONT_IDS.map((id) => FONT_REGISTRY[id]), ...PRO_FONT_IDS.map((id) => PRO_FONT_REGISTRY[id])];
    expect(all).toHaveLength(54);
    for (const meta of all) {
      expect(meta.source, meta.id).toBe('fontsource');
      expect(meta.pkg, meta.id).toMatch(/^@fontsource\/[a-z0-9-]+$/);
      expect(deps[meta.pkg!], meta.id).toMatch(/^\d+\.\d+\.\d+$/); // exact pin
      const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules', meta.pkg!, 'metadata.json'), 'utf8')) as {
        license: { type: string };
        weights: number[];
        styles: string[];
        subsets: string[];
        family: string;
      };
      const script = meta.id.startsWith('noto-');
      if (script) {
        // The Noto families ship 100–900; the registry keeps the lettering range Google served before (no faux bold).
        for (const w of meta.weights) expect(installed.weights, meta.id).toContain(w);
        expect(meta.family).toBe(installed.family);
      } else {
        expect([...installed.weights].sort((a, b) => a - b), meta.id).toEqual(meta.weights);
        expect(installed.styles.includes('italic'), meta.id).toBe(meta.italic);
        expect(meta.family).toBe(`DSL ${installed.family}`);
      }
      expect([...installed.subsets].sort(), meta.id).toEqual([...(meta.subsets || [])].sort());
    }
  });

  it("each face's licence equals its npm metadata (package.json and metadata.json) and is OFL-1.1 or Apache-2.0", () => {
    const all: AnyFontFaceMeta[] = [...FONT_IDS.map((id) => FONT_REGISTRY[id]), ...PRO_FONT_IDS.map((id) => PRO_FONT_REGISTRY[id])];
    for (const meta of all) {
      const npm = JSON.parse(readFileSync(join(ROOT, 'node_modules', meta.pkg!, 'package.json'), 'utf8')) as { license: string; version: string };
      const metadata = JSON.parse(readFileSync(join(ROOT, 'node_modules', meta.pkg!, 'metadata.json'), 'utf8')) as { license: { type: string } };
      expect(npm.license, meta.id).toBe(meta.license);
      expect(metadata.license.type, meta.id).toBe(meta.license);
      expect(npm.version, meta.id).toBe(deps[meta.pkg!]);
      expect(LETTERING_FONT_LICENSES).toContain(meta.license);
    }
  });

  it('no face is served by Google any more: every script face is self-hosted and no CSS2 href is ever built', () => {
    for (const id of FONT_IDS) expect(FONT_REGISTRY[id].source, id).toBe('fontsource');
    expect(googleFontsHref(FONT_IDS, [400, 500, 600, 700, 800, 900])).toBeUndefined();
    // Same family names as before, so CSS stacks and the server's own Noto TTFs keep matching.
    expect(FONT_REGISTRY['noto-sans-telugu']).toMatchObject({ family: 'Noto Sans Telugu', pkg: '@fontsource/noto-sans-telugu', weights: [400, 500, 600, 700, 800, 900] });
    expect(FONT_REGISTRY['noto-naskh-arabic'].weights).toEqual([400, 500, 600, 700]);
  });

  it('never ships Blambot / Comicraft faces or a "Comic Sans" file', () => {
    for (const meta of Object.values(FONT_REGISTRY)) {
      expect(meta.family).not.toMatch(/anime ace|wild words|comicraft|blambot|^dsl comic sans|^comic sans/i);
      expect(meta.pkg ?? '').not.toMatch(/comic-sans|blambot|comicraft/i);
    }
  });

  it('script coverage: kalam covers Devanagari; every language has dialogue/sfx faces that cover its script', () => {
    expect(fontCoversLanguage('kalam', 'hi')).toBe(true);
    expect(fontCoversLanguage('comic-neue', 'hi')).toBe(false);
    expect(fontCoversLanguage('dela-gothic-one', 'ja')).toBe(true);
    for (const lang of LANGUAGES) {
      expect(fontCoversLanguage(lang.fonts.dialogue, lang.code)).toBe(true);
      expect(fontCoversLanguage(lang.fonts.sfx, lang.code)).toBe(true);
    }
  });

  it('no weight is offered that a face does not ship (no faux bold)', () => {
    for (const preset of Object.values(LETTERING_PRESETS)) {
      const styles = [preset.base, ...Object.values(preset.kinds).map((k) => ({ ...preset.base, ...k }))];
      for (const s of styles) {
        const r = resolveLetteringFont(s.font, 'speech', 'en', { weight: s.weight });
        expect(FONT_REGISTRY[r.fontId].weights).toContain(r.weight);
      }
    }
  });

  it('metrics: comic-neue is the historical calibration; other faces are measured ratios', () => {
    expect(FONT_REGISTRY['comic-neue'].avgAdvanceEm).toBe(0.0105 / 0.017);
    expect(FONT_REGISTRY.bangers.avgAdvanceEm).toBeLessThan(FONT_REGISTRY['comic-neue'].avgAdvanceEm); // condensed
    expect(FONT_REGISTRY.ultra.avgAdvanceEm).toBeGreaterThan(FONT_REGISTRY['comic-neue'].avgAdvanceEm); // wide
    for (const meta of Object.values(FONT_REGISTRY)) {
      expect(meta.avgAdvanceEm).toBeGreaterThan(0.3);
      expect(meta.avgAdvanceEm).toBeLessThan(1.2);
    }
  });
});

describe('font resolution', () => {
  it('keeps the style font when it covers the script, else the language role font', () => {
    expect(resolveLetteringFont('comic-neue', 'speech', 'en')).toMatchObject({ fontId: 'comic-neue', family: 'DSL Comic Neue', weight: 700 });
    expect(resolveLetteringFont('comic-neue', 'speech', 'te')).toMatchObject({ fontId: 'noto-sans-telugu', family: 'Noto Sans Telugu', weight: 700 });
    expect(resolveLetteringFont('bangers', 'sfx', 'hi').fontId).toBe('noto-sans-devanagari');
    expect(resolveLetteringFont('kalam', 'speech', 'hi').fontId).toBe('kalam');
    expect(resolveLetteringFont('comic-neue', 'speech', 'ur').fontId).toBe('noto-nastaliq-urdu');
  });
  it('snaps weights and only honours italics where the script and face allow them', () => {
    expect(resolveLetteringFont('bangers', 'sfx', 'en', { weight: 900 }).weight).toBe(400);
    expect(resolveLetteringFont('comic-neue', 'whisper', 'en', { italic: true }).italic).toBe(true);
    expect(resolveLetteringFont('bangers', 'whisper', 'en', { italic: true }).italic).toBe(false); // no italic file
    expect(resolveLetteringFont('comic-neue', 'whisper', 'hi', { italic: true }).italic).toBe(false); // never for Devanagari
  });
  it('builds font shorthands, family stacks and family lookups', () => {
    expect(fontString('comic-neue', 17, 650, false)).toMatch(/^700 17px "DSL Comic Neue", /);
    expect(fontString('comic-neue', 17.456, 700, true)).toMatch(/^italic 700 17.46px /);
    expect(fontFamilyStack('noto-sans-telugu')).toMatch(/^"Noto Sans Telugu", /);
    expect(fontByFamily('DSL Bangers')?.id).toBe('bangers');
    expect(fontByFamily('nope')).toBeUndefined();
  });
  it('no Google CSS2 href for any face (script faces load from our own origin)', () => {
    expect(googleFontsHref(['comic-neue', 'bangers'])).toBeUndefined();
    expect(googleFontsHref(['noto-sans-telugu', 'comic-neue', 'noto-sans-devanagari'], [700, 900])).toBeUndefined();
  });
  it('fontsForDoc maps every line through each language (edition fallbacks included)', () => {
    const doc = normalizeDoc(createEmptyDoc('p', 'P', 1));
    doc.pages = [
      {
        id: 'pg', n: 1, summary: '', layout: '', balloons: [], render: { status: 'none' },
        panels: [{ id: 'p1', n: 1, size: 'medium', shot: 'wide', action: '', castIds: [], lines: [
          { id: 'l1', kind: 'speech', text: 'Hi' },
          { id: 'l2', kind: 'sfx', text: 'BOOM' },
          { id: 'l3', kind: 'caption', text: 'Later', lang: 'te' }
        ] }]
      } as never
    ];
    expect(fontsForDoc(doc)).toEqual(['comic-neue', 'bangers', 'noto-sans-telugu']);
    expect(fontsForDoc(doc, ['ja'])).toEqual(['comic-neue', 'bangers', 'noto-sans-telugu', 'noto-sans-jp']);
  });
});

describe('Pro faces (PE-FONTS)', () => {
  it('28 ids, disjoint from the base faces, each a storable id with its own private family', () => {
    expect(PRO_FONT_IDS).toHaveLength(28);
    expect(new Set(PRO_FONT_IDS).size).toBe(28);
    expect(PRO_FONT_IDS.filter((id) => (FONT_IDS as readonly string[]).includes(id))).toEqual([]);
    expect(Object.keys(PRO_FONT_REGISTRY)).toEqual([...PRO_FONT_IDS]);
    const families = new Set([...FONT_IDS.map((id) => FONT_REGISTRY[id].family), ...PRO_FONT_IDS.map((id) => PRO_FONT_REGISTRY[id].family)]);
    expect(families.size).toBe(54);
    for (const id of PRO_FONT_IDS) {
      const meta = PRO_FONT_REGISTRY[id];
      expect(id).toMatch(/^[a-z][a-z0-9-]{1,47}$/); // style.ts STORED_FONT_ID_RE: a stored Pro id survives any load
      expect(meta.id).toBe(id);
      expect(meta.family).toBe(`DSL ${meta.label}`);
      expect(meta.scripts).toEqual(['Latn']);
      expect(meta.avgAdvanceEm).toBeGreaterThan(0.3);
      expect(meta.avgAdvanceEm).toBeLessThan(1.2);
    }
  });

  it('metrics are the measured ones (regular weight, the calibration sample)', () => {
    for (const id of PRO_FONT_IDS) {
      const meta = PRO_FONT_REGISTRY[id];
      const m = measureMetrics(meta);
      expect(meta.avgAdvanceEm, id).toBeCloseTo(m.avg, 4);
      expect(meta.mixedCaseEm, id).toBeCloseTo(m.mixed, 4);
    }
    // The same method reproduces the base faces' stored values (calibrated before PE-FONTS) within 5 %.
    for (const id of ['bangers', 'patrick-hand', 'luckiest-guy', 'permanent-marker', 'special-elite', 'ultra', 'dela-gothic-one'] as FontId[]) {
      const m = measureMetrics(FONT_REGISTRY[id]);
      expect(Math.abs(m.avg - FONT_REGISTRY[id].avgAdvanceEm) / FONT_REGISTRY[id].avgAdvanceEm, id).toBeLessThan(0.05);
    }
  });

  it('resolve, stack and look up like the base faces; FONT_REGISTRY answers a Pro id without listing it', () => {
    expect(resolveLetteringFont('bungee', 'speech', 'en')).toEqual({ fontId: 'bungee', family: 'DSL Bungee', weight: 400, italic: false });
    expect(resolveLetteringFont('cinzel', 'sfx', 'en').weight).toBe(900);
    expect(resolveLetteringFont('grandstander', 'whisper', 'en', { weight: 650, italic: true })).toMatchObject({ weight: 600, italic: true });
    expect(resolveLetteringFont('bungee', 'speech', 'te').fontId).toBe('noto-sans-telugu'); // Latin only: the script's face
    expect(fontFamilyStack('creepster')).toMatch(/^"DSL Creepster", Impact/);
    expect(fontString('fredoka', 20, 900, false)).toMatch(/^700 20px "DSL Fredoka", /);
    expect(fontCoversLanguage('bungee', 'en')).toBe(true);
    expect(fontCoversLanguage('bungee', 'hi')).toBe(false);
    expect(fontByFamily('DSL Press Start 2P')?.id).toBe('press-start-2p');
    expect(fontFaceMeta('vt323')).toBe(PRO_FONT_REGISTRY.vt323);
    expect(fontFaceMeta('comic-neue')).toBe(FONT_REGISTRY['comic-neue']);
    expect(fontFaceMeta('nope')).toBeUndefined();
    expect(fontFaceMeta('__proto__')).toBeUndefined();
    // Consumers that index FONT_REGISTRY with a resolved id (layout metrics, labels) never read undefined for a Pro id…
    expect(FONT_REGISTRY['bungee' as FontId]).toBe(PRO_FONT_REGISTRY.bungee);
    // …while enumerating it still lists the 26 base faces only.
    expect(Object.keys(FONT_REGISTRY)).toHaveLength(26);
    expect(JSON.stringify(FONT_REGISTRY)).not.toContain('Bungee');
  });
});
