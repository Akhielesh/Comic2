// @vitest-environment node
// Keeps the golden scripts valid (shape, tiers, presets, formats) and checks that every
// one compiles into a coherent page prompt — without calling any provider.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { DEFAULT_FORMAT, createEmptyDoc, emptyRender, type ComicDoc, type Format, type Page } from '../../../../shared/comic/doc.js';
import { getStylePreset } from '../../../../shared/comic/stylePresets.js';
import { compilePage, synthesizeLayout } from '../prompts.js';
import { estimatePageCount } from '../writer.js';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const goldens = files.map((f) => ({ file: f, golden: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));

const KINDS = ['comic', 'manga', 'webtoon', 'strip', 'storybook'];
const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'];

describe('golden scripts', () => {
  it('cover the required cases (3–5 scripts)', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.length).toBeLessThanOrEqual(5);
    const formats = goldens.map((g) => g.golden.format as Format);
    expect(formats.some((f) => f.kind === 'manga' && f.readingDirection === 'rtl')).toBe(true);
    expect(formats.some((f) => f.kind === 'storybook')).toBe(true);
    expect(files).toEqual(expect.arrayContaining(['single-lead.json', 'dialogue-trio.json', 'action-chase.json']));
  });

  for (const { file, golden } of goldens) {
    it(`${file} is a valid golden script and compiles to a page prompt`, () => {
      expect(typeof golden.title).toBe('string');
      expect(golden.title.trim()).not.toBe('');
      expect(golden.script.trim().length).toBeGreaterThan(300);
      expect(['draft', 'standard', 'pro']).toContain(golden.quality);
      if (golden.style) expect(getStylePreset(golden.style)).toBeTruthy();
      const format = { ...DEFAULT_FORMAT, ...golden.format } as Format;
      expect(KINDS).toContain(format.kind);
      expect(ASPECTS).toContain(format.pageAspect);
      expect(format.pageCount).toBeGreaterThanOrEqual(1);
      expect(format.pageCount).toBeLessThanOrEqual(40);
      expect(['overlay', 'in_art']).toContain(format.lettering);
      expect(Array.isArray(golden.checks) && golden.checks.length > 0).toBe(true);
      expect(estimatePageCount(golden.script)).toBeGreaterThanOrEqual(1);

      // A synthetic page in this format must compile cleanly (no network).
      const doc: ComicDoc = createEmptyDoc('golden_test', golden.title, 1);
      doc.format = format;
      doc.settings.quality = golden.quality;
      const preset = getStylePreset(golden.style);
      if (preset) doc.style = { ...doc.style, status: 'locked', spec: preset.spec, palette: preset.palette, linework: preset.linework, avoid: preset.avoid };
      doc.cast = [{ id: 'c1', name: 'Hero', tier: 'lead', look: { summary: 'A hero' }, refs: [], sheet: emptyRender() }];
      const panels = [1, 2, 3, 4].map((n) => ({
        id: `p${n}`,
        n,
        size: 'medium' as const,
        shot: 'medium' as const,
        action: `Beat ${n}.`,
        castIds: ['c1'],
        lines: [{ id: `l${n}`, kind: 'speech' as const, speakerId: 'c1', text: `Line ${n}` }]
      }));
      const page: Page = { id: 'pg', n: 1, summary: '', layout: synthesizeLayout(panels, format), panels, render: emptyRender(), balloons: [] };
      const job = compilePage(doc, page);
      expect(job.prompt).toContain('PANELS:');
      expect(job.prompt.includes('Spell every line exactly as written')).toBe(format.lettering === 'in_art');
      if (format.readingDirection === 'rtl') expect(job.prompt).toContain('right-to-left');
      if (format.colorMode === 'bw') expect(job.prompt).toContain('black and white with grey tones only');
    });
  }
});
