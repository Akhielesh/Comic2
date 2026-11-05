import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StudioMark } from './StudioMark';
import { STUDIO_MARKS, STUDIOS, isStudio, type Studio } from './studios';

const svgOf = (container: HTMLElement) => container.querySelector('svg') as SVGSVGElement;
const ID_SAFE = /^[A-Za-z][A-Za-z0-9_-]*$/;

describe('StudioMark', () => {
  it.each(STUDIOS)('%s: one currentColor tile drawn through its own mask (cut weight 7, point r 3.6)', (studio) => {
    const { container } = render(<StudioMark studio={studio} />);
    const svg = svgOf(container);
    expect(svg.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(svg).toHaveClass('ds-logo-mark', `ds-logo-mark--${studio}`);
    expect(svg).not.toHaveClass('ds-logo-mark--loading');

    const mask = svg.querySelector('mask')!;
    expect(mask.getAttribute('maskUnits')).toBe('userSpaceOnUse');
    const cut = mask.querySelector('path.ds-logo-cut')!;
    expect(cut.getAttribute('d')).toBe(STUDIO_MARKS[studio].cut);
    expect(cut.getAttribute('stroke')).toBe('#000');
    expect(cut.getAttribute('stroke-width')).toBe('7');
    expect(cut.getAttribute('stroke-linejoin')).toBe('miter');
    expect(cut.getAttribute('fill')).toBe('none');
    const point = mask.querySelector('circle.ds-logo-point')!;
    expect([Number(point.getAttribute('cx')), Number(point.getAttribute('cy'))]).toEqual([...STUDIO_MARKS[studio].point]);
    expect(point.getAttribute('r')).toBe('3.6');

    // The only painted shape: the tile in currentColor through the mask (no second fill colour).
    const painted = [...svg.children].filter((el) => el.tagName.toLowerCase() !== 'defs');
    expect(painted).toHaveLength(1);
    expect(painted[0].getAttribute('fill')).toBe('currentColor');
    expect(painted[0].getAttribute('rx')).toBe('16');
    expect(painted[0].getAttribute('mask')).toBe(`url(#${mask.id})`);
  });

  it('gives every instance its own id-safe mask id, and each tile points at its own mask', () => {
    const { container } = render(
      <div>
        {STUDIOS.map((s) => (
          <React.Fragment key={s}>
            <StudioMark studio={s} />
            <StudioMark studio={s} loading />
          </React.Fragment>
        ))}
      </div>,
    );
    const svgs = [...container.querySelectorAll('svg')];
    expect(svgs).toHaveLength(STUDIOS.length * 2);
    const ids = svgs.map((svg) => svg.querySelector('mask')!.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [i, svg] of svgs.entries()) {
      expect(ids[i]).toMatch(ID_SAFE);
      expect(ids[i]).toContain(svg.getAttribute('data-studio')!);
      expect(svg.querySelector('rect[fill="currentColor"]')!.getAttribute('mask')).toBe(`url(#${ids[i]})`);
      // The id resolves inside the document (url(#…) would silently draw nothing otherwise).
      expect(container.ownerDocument.getElementById(ids[i])).toBe(svg.querySelector('mask'));
    }
  });

  it('is decorative without a label (a wordmark beside it names it)', () => {
    const { container } = render(<StudioMark studio="comic" />);
    const svg = svgOf(container);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.hasAttribute('role')).toBe(false);
    expect(svg.hasAttribute('aria-label')).toBe(false);
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('is an image named by its label when it stands alone', () => {
    render(<StudioMark studio="stream" label="Stream Studio" />);
    const img = screen.getByRole('img', { name: 'Stream Studio' });
    expect(img.hasAttribute('aria-hidden')).toBe(false);
  });

  it('treats a blank label as no label (never an unnamed image)', () => {
    const { container } = render(<StudioMark studio="dreamstream" label="   " />);
    expect(svgOf(container).getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('marks a loading mark for the CSS loop', () => {
    const { container } = render(<StudioMark studio="stream" loading className="extra" />);
    expect(svgOf(container)).toHaveClass('ds-logo-mark', 'ds-logo-mark--stream', 'ds-logo-mark--loading', 'extra');
  });

  it('sizes itself from `size` (number = px, or any CSS length), keeping a caller style', () => {
    const { container, rerender } = render(<StudioMark studio="atlas" size={40} style={{ color: 'red' }} />);
    expect(svgOf(container).style.width).toBe('40px');
    expect(svgOf(container).style.height).toBe('40px');
    expect(svgOf(container).style.color).toBe('red');
    rerender(<StudioMark studio="atlas" size="2rem" />);
    expect(svgOf(container).style.width).toBe('2rem');
    const bare = render(<StudioMark studio="atlas" />);
    expect(svgOf(bare.container).hasAttribute('style')).toBe(false); // 1em from the CSS, or a class
  });

  it('draws the Atlas mark with exactly the geometry of AtlasLogo.tsx', () => {
    // Atlas components/AtlasLogo.tsx: the open A (no crossbar), miter joins, the point under the apex.
    expect(STUDIO_MARKS.atlas.cut).toBe('M16 50 L32 14 L48 50');
    expect(STUDIO_MARKS.atlas.point).toEqual([32, 40]);
    expect(STUDIO_MARKS.atlas.name).toBe('Atlas Studio');
  });

  it('knows its studios', () => {
    expect(STUDIOS).toEqual(['dreamstream', 'comic', 'stream', 'atlas']);
    for (const s of STUDIOS) expect(isStudio(s)).toBe(true);
    for (const v of ['', 'Comic', 'comics', 'toString', 'constructor', null, 7]) expect(isStudio(v as unknown as Studio)).toBe(false);
  });
});
