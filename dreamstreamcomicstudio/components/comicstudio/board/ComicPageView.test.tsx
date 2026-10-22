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
});
