import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../languages';
import { createEmptyDoc, normalizeDoc } from '../doc';
import {
  FONT_REGISTRY,
  LETTERING_FONT_LICENSES,
  fontByFamily,
  fontCoversLanguage,
  fontFamilyStack,
  fontString,
  fontsForDoc,
  googleFontsHref,
  resolveLetteringFont
} from './fonts';
import { FONT_IDS, LETTERING_PRESETS } from './style';

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

  it('the 12 self-hosted faces are pinned in package.json and match the installed metadata exactly', () => {
    const selfHosted = Object.values(FONT_REGISTRY).filter((m) => m.source === 'fontsource');
    expect(selfHosted).toHaveLength(12);
    for (const meta of selfHosted) {
      expect(meta.family.startsWith('DSL ')).toBe(true);
      expect(meta.pkg).toBeTruthy();
      expect(deps[meta.pkg!]).toMatch(/^\d+\.\d+\.\d+$/); // exact pin
      const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules', meta.pkg!, 'metadata.json'), 'utf8')) as {
        license: { type: string };
        weights: number[];
        styles: string[];
        subsets: string[];
        family: string;
      };
      expect(installed.license.type).toBe(meta.license);
      expect([...installed.weights].sort((a, b) => a - b)).toEqual(meta.weights);
      expect(installed.styles.includes('italic')).toBe(meta.italic);
      expect([...installed.subsets].sort()).toEqual([...(meta.subsets || [])].sort());
      expect(meta.family).toBe(`DSL ${installed.family}`);
      const npmLicense = (JSON.parse(readFileSync(join(ROOT, 'node_modules', meta.pkg!, 'package.json'), 'utf8')) as { license: string }).license;
      expect(npmLicense).toBe(meta.license);
    }
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
  it('Google CSS2 href only for lazily loaded script faces', () => {
    expect(googleFontsHref(['comic-neue', 'bangers'])).toBeUndefined();
    const href = googleFontsHref(['noto-sans-telugu', 'comic-neue', 'noto-sans-devanagari'], [700, 900])!;
    expect(href).toBe('https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@700;900&family=Noto+Sans+Telugu:wght@700;900&display=swap');
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
