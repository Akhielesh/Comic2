import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComicPageView } from './ComicPageView';
import { makeSampleDoc } from './__fixtures__/sampleDoc';

const pageBox = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-testid="comic-page"]')!;

describe('ComicPageView', () => {
  it('uses the render’s real aspect, never cropping (object-contain)', () => {
    const doc = makeSampleDoc();
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" />);
    expect(parseFloat(pageBox(container).style.aspectRatio)).toBeCloseTo(1000 / 1500, 4);
    const img = screen.getByRole('img', { name: /Page 1/ });
    expect(img).toHaveClass('object-contain');
    expect(img).toHaveAttribute('src', 'https://cdn.test/p1.png');
  });

  it('falls back to the format aspect for an undrawn page', () => {
    const doc = makeSampleDoc((d) => (d.format.pageAspect = '3:4'));
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[1]} />);
    expect(parseFloat(pageBox(container).style.aspectRatio)).toBeCloseTo(0.75, 4);
  });

  it('adopts the loaded image’s natural ratio', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = { path: 'u/p.png', source: 'generated', at: 0 };
    });
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p.png" />);
    const img = container.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 900 });
    Object.defineProperty(img, 'naturalHeight', { value: 1600 });
    fireEvent.load(img);
    expect(parseFloat(pageBox(container).style.aspectRatio)).toBeCloseTo(900 / 1600, 4);
  });

  it('letters overlay comics with balloons', () => {
    const doc = makeSampleDoc();
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" />);
    expect(container.querySelectorAll('[data-testid="balloon"]').length).toBe(5);
  });

  it('draws no balloons when the art is lettered in-art, or when lettering is hidden', () => {
    const doc = makeSampleDoc((d) => (d.format.lettering = 'in_art'));
    const { container, rerender } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" />);
    expect(container.querySelectorAll('[data-testid="balloon"]').length).toBe(0);
    const overlay = makeSampleDoc();
    rerender(<ComicPageView doc={overlay} page={overlay.pages[0]} imageUrl="https://cdn.test/p1.png" hideLettering />);
    expect(container.querySelectorAll('[data-testid="balloon"]').length).toBe(0);
  });

  it('shows the plan sketch (panel numbers + action) when nothing is drawn', () => {
    const doc = makeSampleDoc();
    render(<ComicPageView doc={doc} page={doc.pages[1]} />);
    const sketch = screen.getByRole('img', { name: 'Page 2 plan sketch' });
    expect(sketch).toHaveTextContent('1');
    expect(sketch).toHaveTextContent('Maya slips a saffron tin into her satchel.');
    expect(sketch).toHaveTextContent('Establishing');
    expect(document.querySelectorAll('[data-testid="balloon"]').length).toBe(0);
  });

  it('shimmers while a drawn page’s link is being signed', () => {
    const doc = makeSampleDoc();
    render(<ComicPageView doc={doc} page={doc.pages[0]} />);
    expect(screen.getByRole('img', { name: 'Loading page image' })).toHaveClass('studio-shimmer');
  });

  it('reports a broken image and falls back to the sketch', () => {
    const doc = makeSampleDoc();
    const onImageError = vi.fn();
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/bad.png" onImageError={onImageError} />);
    fireEvent.error(container.querySelector('img')!);
    expect(onImageError).toHaveBeenCalled();
    expect(screen.getByText(/Couldn’t load this image/)).toBeInTheDocument();
  });

  it('renders overlays and extra layers inside the page box', () => {
    const doc = makeSampleDoc();
    const { container } = render(
      <ComicPageView doc={doc} page={doc.pages[1]} overlay={<span data-testid="ov" />}>
        <span data-testid="layer" />
      </ComicPageView>
    );
    expect(pageBox(container).querySelector('[data-testid="ov"]')).toBeTruthy();
    expect(pageBox(container).querySelector('[data-testid="layer"]')).toBeTruthy();
  });

  it('reader props: hides lettering from assistive tech, fades unrevealed balloons, adds the paper layer', () => {
    const doc = makeSampleDoc();
    const { container } = render(
      <ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" letteringAriaHidden paper visibleLineIds={new Set(['pg_1_l1'])} />
    );
    expect(container.querySelector('[data-testid="lettering-svg"]')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[data-testid="reader-paper"]')).toHaveClass('ds-reader-paper');
    expect(container.querySelector('[data-line-id="pg_1_l2"]')!.getAttribute('opacity')).toBe('0');
    expect(container.querySelector('[data-line-id="pg_1_l1"]')!.getAttribute('opacity')).toBeNull();
  });

  it('picks an image variant for its measured width (srcWidth)', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 480, height: 720, right: 480, bottom: 720, x: 0, y: 0, toJSON: () => ({}) });
    try {
      const doc = makeSampleDoc();
      const srcWidth = vi.fn((w: number) => `https://cdn.test/p1-${w}w.webp`);
      const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" srcWidth={srcWidth} />);
      expect(srcWidth).toHaveBeenCalledWith(480);
      expect(container.querySelector('img')!.getAttribute('src')).toBe('https://cdn.test/p1-480w.webp');
    } finally {
      spy.mockRestore();
    }
  });

  it('a variant that fails to load falls back to the original image (not the sketch); both failing is reported', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 480, height: 720, right: 480, bottom: 720, x: 0, y: 0, toJSON: () => ({}) });
    try {
      const doc = makeSampleDoc();
      const onImageError = vi.fn();
      const { container } = render(
        <ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" srcWidth={(w) => `https://cdn.test/p1-${w}w.webp`} onImageError={onImageError} />
      );
      expect(container.querySelector('img')!.getAttribute('src')).toBe('https://cdn.test/p1-480w.webp');
      fireEvent.error(container.querySelector('img')!);
      expect(container.querySelector('img')!.getAttribute('src')).toBe('https://cdn.test/p1.png');
      expect(onImageError).not.toHaveBeenCalled();
      expect(screen.queryByText(/Couldn’t load this image/)).toBeNull();
      fireEvent.error(container.querySelector('img')!);
      expect(onImageError).toHaveBeenCalledTimes(1);
      expect(container.querySelector('img')).toBeNull();
      expect(screen.getByText(/Couldn’t load this image/)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('passes edition edits through with { lang }', () => {
    const doc = makeSampleDoc();
    const onBalloonChange = vi.fn();
    const { container } = render(
      <ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" editable editionLang="hi" onBalloonChange={onBalloonChange} />
    );
    fireEvent.keyDown(container.querySelector('[data-testid="balloon-hit"][data-line-id="pg_1_l2"]')!, { key: 'ArrowRight' });
    expect(onBalloonChange).toHaveBeenCalledWith('pg_1_l2', expect.objectContaining({ pinned: true }), { lang: 'hi' });
  });
});
