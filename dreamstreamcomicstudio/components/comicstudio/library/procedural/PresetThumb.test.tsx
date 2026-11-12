// Procedural thumbnails for the 12 styles added in Program 3 ST-4 (styles.md §9 P3-ST4): before the
// library is seeded every Styles tile is this drawing, so each new id must draw its OWN look (never
// the generic fallback), stay NaN-free with self-contained defs, and be snapshotted per id. The two
// spot-colour looks must really be ink plus one hue, and follow the accent a user picks.
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { hashString } from '../../../../shared/comic/doc';
import { STYLE_PRESETS, getStylePreset, isNeutralHex, spotAccentOf, spotColourPalette, type StylePreset } from '../../../../shared/comic/stylePresets';
import { PresetThumb } from './PresetThumb';

const NEW_IDS = [
  'ink-one-colour',
  'mono-wash',
  'ink-wash',
  'indian-miniature',
  'woodcut',
  'dieselpunk',
  'brutalist',
  'surreal-dream',
  'chalk-pastel',
  'retrofuturism',
  'mythic-icon',
  'cyberpunk'
];

const presetOf = (id: string): StylePreset => {
  const p = getStylePreset(id);
  if (!p) throw new Error(`no preset ${id}`);
  return p;
};

/** Render one tile and return its markup with the preset id and React's per-render ids normalised. */
const draw = (preset: StylePreset): { html: string; svg: SVGSVGElement } => {
  const { container, unmount } = render(<PresetThumb preset={preset} />);
  const root = container.firstChild as HTMLElement;
  const svg = root.querySelector('svg')!.cloneNode(true) as SVGSVGElement;
  const html = root.outerHTML.split(preset.id).join('PRESET').replace(/pt-PRESET-[A-Za-z0-9_]+/g, 'pt-PRESET-ID');
  unmount();
  return { html, svg };
};

/** Every #rrggbb painted outside <defs>, plus the sky gradient's stops (the only defs every tile uses). */
const paintedColours = (svg: SVGSVGElement): string[] => {
  const sky = [...svg.querySelectorAll('linearGradient[id$="-sky"] stop')].map((s) => s.getAttribute('stop-color') || '');
  const art = svg.cloneNode(true) as SVGSVGElement;
  art.querySelectorAll('defs').forEach((d) => d.remove());
  return [...new Set([...(art.outerHTML.match(/#[0-9a-f]{6}\b/gi) || []), ...sky].map((c) => c.toLowerCase()))];
};

describe('PresetThumb: the 12 ST-4 looks', () => {
  it('covers every new id in the catalogue', () => {
    for (const id of NEW_IDS) expect(STYLE_PRESETS.some((p) => p.id === id), id).toBe(true);
    expect(STYLE_PRESETS).toHaveLength(24);
  });

  it.each(NEW_IDS)('%s draws its own look, not the generic fallback', (id) => {
    const preset = presetOf(id);
    const own = draw(preset).html;
    const generic = draw({ ...preset, id: 'zz-generic-fallback' }).html.split('zz-generic-fallback').join('PRESET');
    expect(own).not.toBe(generic);
  });

  it.each(NEW_IDS)('%s renders clean, self-contained SVG (procedural snapshot)', (id) => {
    const preset = presetOf(id);
    const { container, unmount } = render(<PresetThumb preset={preset} />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('aria-hidden');
    expect(root).toHaveAttribute('data-preset-thumb', id);
    expect(root.style.background).not.toBe('');
    expect(root.outerHTML).not.toMatch(/NaN|undefined|Infinity|null/);
    expect(container.querySelectorAll('path').length).toBeGreaterThan(15);
    const ids = new Set([...container.querySelectorAll('[id]')].map((n) => n.id));
    for (const ref of root.outerHTML.matchAll(/url\(#([^)]+)\)/g)) expect(ids.has(ref[1]), ref[1]).toBe(true);
    unmount();
    expect(hashString(draw(preset).html)).toMatchSnapshot();
  });

  it('all 24 tiles are distinct from each other', () => {
    const digests = STYLE_PRESETS.map((p) => hashString(draw(p).html));
    expect(new Set(digests).size).toBe(24);
  });

  it('Ink + one colour paints only black, white and grey plus its one accent, and follows a picked accent', () => {
    const ink = presetOf('ink-one-colour');
    const accent = spotAccentOf(ink.palette)!;
    const colours = paintedColours(draw(ink).svg);
    expect(colours).toContain(accent);
    expect(colours.filter((c) => !isNeutralHex(c))).toEqual([accent]);

    const green = { ...ink, palette: spotColourPalette('#1e8449') };
    const picked = paintedColours(draw(green).svg);
    expect(picked.filter((c) => !isNeutralHex(c))).toEqual(['#1e8449']);
  });

  it('Modern mono wash keeps its cool accent to one hue on the boat', () => {
    const mono = presetOf('mono-wash');
    const colours = paintedColours(draw(mono).svg);
    expect(colours.filter((c) => !isNeutralHex(c))).toEqual([spotAccentOf(mono.palette)]);
  });
});
