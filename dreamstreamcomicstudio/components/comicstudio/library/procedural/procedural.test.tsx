// Procedural art (assets.md §6/§15): every preset thumbnail, layout glyph, balloon swatch and
// empty-state drawing renders deterministic, NaN-free SVG at $0 — snapshotted so a visual change
// is always a reviewed change.
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STYLE_PRESETS } from '../../../../shared/comic/stylePresets';
import { hashString } from '../../../../shared/comic/doc';
import { BUBBLE_SHAPES, LINE_KINDS } from '../../../../shared/comic/lettering/style';
import { makeSampleDoc } from '../../conversation/testing/fixtures';
import { PresetThumb } from './PresetThumb';
import { LayoutGlyph, LAYOUT_GLYPH_NUMBERS_FROM } from './LayoutGlyph';
import { BubblePreview } from './BubblePreview';
import { EmptyArt, type EmptyArtVariant } from './EmptyArt';
import { benDay, bokeh, crosshatch, focusLines, halftone, paperGrain, rainPath, rasterLines, risoGrain, screentone, seamlessDirection, speedLines } from './textures';

/** Markup with React's per-render ids normalised (they depend on render order only). */
const ID_RE = new RegExp(`pt-(${STYLE_PRESETS.map((p) => p.id).sort((a, b) => b.length - a.length).join('|')})-[A-Za-z0-9_]+`, 'g');
const markup = (el: Element | null) => (el?.outerHTML || '').replace(ID_RE, 'pt-$1-ID');
const VARIANTS: EmptyArtVariant[] = ['pages', 'cast', 'style', 'reader', 'studio', 'media'];

describe('PresetThumb', () => {
  it('renders a distinct, NaN-free scene for all 12 presets over the gradient swatch', () => {
    const digests: Record<string, string> = {};
    for (const p of STYLE_PRESETS) {
      const { container, unmount } = render(<PresetThumb preset={p} />);
      const root = container.firstChild as HTMLElement;
      expect(root.style.background).not.toBe(''); // tier-3 gradient under the art
      expect(root).toHaveAttribute('aria-hidden');
      const html = markup(root);
      expect(html).not.toMatch(/NaN|undefined|Infinity/);
      expect(container.querySelectorAll('path').length).toBeGreaterThan(15);
      // Every url(#id) reference points at a def in the same SVG (no cross-instance leaks).
      const ids = new Set([...container.querySelectorAll('[id]')].map((n) => n.id));
      for (const ref of root.outerHTML.matchAll(/url\(#([^)]+)\)/g)) expect(ids.has(ref[1]), ref[1]).toBe(true);
      digests[p.id] = hashString(html);
      unmount();
    }
    expect(new Set(Object.values(digests)).size).toBe(STYLE_PRESETS.length);
    expect(digests).toMatchSnapshot();
  });

  it('keeps instance ids unique when the same preset renders twice', () => {
    const { container } = render(
      <>
        <PresetThumb preset={STYLE_PRESETS[0]} />
        <PresetThumb preset={STYLE_PRESETS[0]} />
      </>
    );
    const ids = [...container.querySelectorAll('[id]')].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('honours an explicit width; the noir scene snapshot', () => {
    const { container } = render(<PresetThumb preset={STYLE_PRESETS.find((p) => p.id === 'noir-ink')!} size={120} />);
    expect((container.firstChild as HTMLElement).style.width).toBe('120px');
    expect(markup(container.firstChild as Element)).toMatchSnapshot();
  });
});

describe('LayoutGlyph', () => {
  it('draws the page frame plus one tile per panel (from the shared page geometry)', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 9]) {
      const { container, unmount } = render(<LayoutGlyph panels={n} aspect="4:5" size={40} />);
      expect(container.querySelectorAll('rect')).toHaveLength(1 + n);
      expect(container.innerHTML).not.toMatch(/NaN/);
      unmount();
    }
    const page = makeSampleDoc().pages[0];
    const { container } = render(<LayoutGlyph page={page} aspect="2:3" />);
    expect(container.querySelectorAll('rect')).toHaveLength(1 + page.panels.length);
  });

  it('numbers the panels only when big enough to read', () => {
    const small = render(<LayoutGlyph panels={4} aspect="4:5" size={28} />);
    expect(small.container.querySelectorAll('text')).toHaveLength(0);
    const big = render(<LayoutGlyph panels={4} aspect="4:5" size={LAYOUT_GLYPH_NUMBERS_FROM + 20} />);
    expect([...big.container.querySelectorAll('text')].map((t) => t.textContent)).toEqual(['1', '2', '3', '4']);
    expect(big.container.querySelector('svg')).toHaveAttribute('height', String(Math.round((LAYOUT_GLYPH_NUMBERS_FROM + 20) / 0.8)));
    expect(markup(big.container.firstChild as Element)).toMatchSnapshot();
  });

  it('survives odd input (0 panels, NaN size, unknown aspect)', () => {
    const { container } = render(<LayoutGlyph panels={Number.NaN} aspect={'7:3' as never} size={Number.NaN} />);
    expect(container.innerHTML).not.toMatch(/NaN/);
  });
});

describe('BubblePreview', () => {
  it('renders every balloon shape and line kind with the engine geometry, NaN-free', () => {
    for (const shape of BUBBLE_SHAPES) {
      const { container, unmount } = render(<BubblePreview style={{ shape }} kind="speech" />);
      expect(container.innerHTML, shape).not.toMatch(/NaN|undefined/);
      if (shape !== 'none') expect(container.querySelector('path, rect'), shape).not.toBeNull();
      unmount();
    }
    const kinds: Record<string, string> = {};
    for (const kind of LINE_KINDS) {
      const { container, unmount } = render(<BubblePreview style={{}} kind={kind} />);
      kinds[kind] = markup(container.firstChild as Element);
      unmount();
    }
    expect(kinds.thought).toMatch(/<circle/); // the thought trail
    expect(kinds.sfx).toContain('POW');
    expect(kinds).toMatchSnapshot();
  });

  it('applies the style’s fill, border and font', () => {
    const { container } = render(<BubblePreview style={{ shape: 'rect', fill: '#fff6c8', border: '#123456' }} kind="caption" size={60} />);
    const rect = container.querySelector('rect')!;
    expect(rect).toHaveAttribute('fill', '#fff6c8');
    expect(rect).toHaveAttribute('stroke', '#123456');
    expect(container.querySelector('svg')).toHaveAttribute('width', '60');
    expect(container.querySelector('text')!.getAttribute('font-family')).toMatch(/,/);
  });
});

describe('EmptyArt', () => {
  it('draws each variant in currentColor with one accent, aria-hidden', () => {
    const all: Record<string, string> = {};
    for (const v of VARIANTS) {
      const { container, unmount } = render(<EmptyArt variant={v} />);
      const svg = container.querySelector('svg')!;
      expect(svg).toHaveAttribute('aria-hidden');
      expect(svg).toHaveAttribute('stroke', 'currentColor');
      expect(svg.innerHTML).toContain('#D97757');
      expect(svg.innerHTML).not.toMatch(/NaN/);
      all[v] = markup(svg);
      unmount();
    }
    expect(new Set(Object.values(all)).size).toBe(VARIANTS.length);
    expect(all).toMatchSnapshot();
  });
});

describe('textures', () => {
  it('produce small, deterministic SVG tiles', () => {
    const tiles = [halftone(), screentone(10), screentone(60), benDay(), rasterLines(), crosshatch(), paperGrain(3), risoGrain()];
    for (const t of tiles) {
      expect(t.url.startsWith('data:image/svg+xml,')).toBe(true);
      expect(t.css).toBe(`url("${t.url}")`);
      expect(t.svg.length).toBeLessThan(1536);
      expect(t.svg).not.toMatch(/NaN/);
    }
    expect(paperGrain('a').svg).toBe(paperGrain('a').svg);
    expect(paperGrain('a').svg).not.toBe(paperGrain('b').svg);
    expect(screentone(60).svg).not.toBe(screentone(10).svg);
    // Colour strings can't break out of their attribute.
    expect(halftone({ color: '"/><script>x</script>' }).svg).not.toMatch(/<script/);
  });

  it('dot and line screens tile seamlessly as CSS backgrounds (any angle snaps to a repeating one)', () => {
    const circles = (svg: string) => [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
    for (const t of [halftone(), halftone({ angle: 0 }), halftone({ angle: 15, cell: 12 }), halftone({ angle: -60, cell: 5 }), screentone(10), screentone(60)]) {
      expect(Number.isInteger(t.size)).toBe(true);
      const dots = circles(t.svg);
      expect(dots.length).toBeGreaterThan(0);
      const has = (x: number, y: number) => dots.some(([cx, cy]) => Math.abs(cx - x) < 0.02 && Math.abs(cy - y) < 0.02);
      // A dot cut by an edge reappears on the opposite edge, so the repeat shows no seam.
      for (const [cx, cy, r] of dots) {
        if (cx - r < 0) expect(has(cx + t.size, cy), `${t.svg} @${cx},${cy}`).toBe(true);
        if (cx + r > t.size) expect(has(cx - t.size, cy)).toBe(true);
        if (cy - r < 0) expect(has(cx, cy + t.size)).toBe(true);
        if (cy + r > t.size) expect(has(cx, cy - t.size)).toBe(true);
      }
    }
    for (const angle of [0, 20, 45, -45, 70, 90]) {
      const { a, b, k } = seamlessDirection(angle);
      const t = rasterLines({ angle, spacing: 7 });
      expect(Number.isInteger(t.size)).toBe(true);
      expect(t.svg).not.toMatch(/NaN/);
      const sp = t.size / k;
      const [nx, ny] = [-a / k, b / k];
      const segs = [...t.svg.matchAll(/M([-\d.]+) ([-\d.]+)L([-\d.]+) ([-\d.]+)/g)].map((m) => m.slice(1).map(Number));
      const offsets = segs.map(([x1, y1]) => nx * x1 + ny * y1);
      // Every line sits on the same lattice (offset ≡ sp/2 mod sp) …
      for (const d of offsets) expect(Math.abs(d / sp - 0.5 - Math.round(d / sp - 0.5))).toBeLessThan(0.01);
      // … the lattice is unchanged by a one-tile shift (n·(T,0) and n·(0,T) are whole spacings) …
      expect(Number.isInteger(Math.round((nx * t.size) / sp * 1e6) / 1e6)).toBe(true);
      expect(Number.isInteger(Math.round((ny * t.size) / sp * 1e6) / 1e6)).toBe(true);
      // … and the lines cover the whole tile.
      const corners = [0, nx * t.size, ny * t.size, (nx + ny) * t.size];
      expect(Math.min(...offsets)).toBeLessThanOrEqual(Math.min(...corners));
      expect(Math.max(...offsets)).toBeGreaterThanOrEqual(Math.max(...corners));
    }
    expect(seamlessDirection(45).deg).toBe(45);
    expect(seamlessDirection(-30).deg).toBeCloseTo(-26.57, 2);
  });

  it('motion lines and bokeh are seeded and finite', () => {
    const a = speedLines('x', 50, 50, { count: 20 });
    expect(a).toEqual(speedLines('x', 50, 50, { count: 20 }));
    expect(a).toHaveLength(20);
    expect(a.every((l) => [l.x1, l.y1, l.x2, l.y2, l.w].every(Number.isFinite))).toBe(true);
    expect(focusLines('y')).toMatch(/^M[\d.\- ]+L/);
    expect(focusLines('y')).not.toMatch(/NaN/);
    expect(bokeh('z', { count: 5 })).toHaveLength(5);
    expect(rainPath('r', { count: 3 }).match(/M/g)).toHaveLength(3);
  });
});
