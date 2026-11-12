// PE-FONTS generator: the committed face tables are exactly what the generator makes from the pinned packages, every
// compact table expands to the planned files, and the WOFF reader draws real outlines.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_IDS } from '../shared/comic/lettering/style';
import { FONT_REGISTRY, PRO_FONT_REGISTRY } from '../shared/comic/lettering/fonts';
import { PRO_FONT_IDS } from '../shared/comic/lettering/proFonts';
import { APP_ROOT, facePlan, openFont, readSfntTables, renderFontTables, textAdvanceEm, textPath } from './build-font-specimens.mjs';

const SCRIPT_IDS = FONT_IDS.filter((id) => id.startsWith('noto-'));
const woff = (pkg: string, file: string) => readFileSync(join(APP_ROOT, 'node_modules', '@fontsource', pkg, 'files', file));

describe('build-font-specimens: tables', () => {
  it('the committed fontFiles.ts and fontTables/* are what the generator makes (no hand edits, no drift)', async () => {
    const files = await renderFontTables();
    expect(Object.keys(files).sort()).toEqual(
      [
        'components/comicstudio/lettering/fontFiles.ts',
        'components/comicstudio/lettering/fontTables/pro.ts',
        ...SCRIPT_IDS.map((id) => `components/comicstudio/lettering/fontTables/${id}.ts`)
      ].sort()
    );
    for (const [rel, text] of Object.entries(files)) expect(readFileSync(join(APP_ROOT, rel), 'utf8'), rel).toBe(text);
  });

  it('every script table expands to exactly its planned slices, each with a self-hosted URL', async () => {
    for (const id of SCRIPT_IDS) {
      const { FILES } = (await import(`../components/comicstudio/lettering/fontTables/${id}.ts`)) as { FILES: { url: string; weight: number; subset: string; unicodeRange: string }[] };
      const plan = facePlan(FONT_REGISTRY[id], 'script') as { file: string; weight: number; subset: string; range: string }[];
      expect(FILES.length, id).toBe(plan.length);
      FILES.forEach((f, i) => {
        expect(f.url, id).toContain(plan[i].file.replace(/\.woff2$/, ''));
        expect(f.url, id).not.toMatch(/googleapis|gstatic|^https?:/);
        expect([f.weight, f.subset, f.unicodeRange]).toEqual([plan[i].weight, plan[i].subset, plan[i].range]);
      });
      expect(new Set(FILES.map((f) => f.weight))).toEqual(new Set(FONT_REGISTRY[id].weights));
    }
  }, 60_000);

  it('the Pro table holds latin + latin-ext of every weight and style each Pro face ships', async () => {
    const { PRO_FONT_FILES } = await import('../components/comicstudio/lettering/fontTables/pro');
    expect(Object.keys(PRO_FONT_FILES)).toEqual([...PRO_FONT_IDS]);
    for (const id of PRO_FONT_IDS) {
      const meta = PRO_FONT_REGISTRY[id];
      const files = PRO_FONT_FILES[id];
      const plan = facePlan(meta, 'pro') as { file: string }[];
      expect(files.map((f) => f.url.replace(/^.*\/files\//, '').replace(/\.woff2.*$/, '.woff2')), id).toEqual(plan.map((p) => p.file));
      expect(files.some((f) => f.subset === 'latin'), id).toBe(true);
      expect(files.every((f) => f.subset === 'latin' || f.subset === 'latin-ext'), id).toBe(true);
      expect(new Set(files.map((f) => f.weight))).toEqual(new Set(meta.weights));
      expect(files.some((f) => f.style === 'italic'), id).toBe(meta.italic);
    }
  });
});

describe('build-font-specimens: WOFF reader', () => {
  it('reads tables, metrics and TrueType outlines (simple and composite glyphs)', () => {
    const font = openFont(woff('comic-neue', 'comic-neue-latin-700-normal.woff'));
    expect(font.unitsPerEm).toBeGreaterThan(0);
    const a = font.glyphOf('A'.codePointAt(0)!);
    expect(a).toBeGreaterThan(0);
    expect(font.contours(a).length).toBeGreaterThan(0);
    expect(font.contours(font.glyphOf('é'.codePointAt(0)!)).length).toBeGreaterThanOrEqual(2); // e + acute
    expect(font.glyphOf(0x4e00)).toBe(0); // not in a Latin slice
    expect(textAdvanceEm(font, 'AA')).toBeCloseTo(2 * textAdvanceEm(font, 'A'), 6);
    const d = textPath(font, 'Hi', 0, 16, 15);
    expect(d).toMatch(/^M[\d.-]+ [\d.-]+/);
    expect(d.match(/Z/g)!.length).toBeGreaterThanOrEqual(3); // H, i stem, i dot
    expect(() => readSfntTables(Buffer.from('not a font at all'))).toThrow(/WOFF/);
  });
});
