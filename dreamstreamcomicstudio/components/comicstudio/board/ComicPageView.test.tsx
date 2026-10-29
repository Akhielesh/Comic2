import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComicCoverView, ComicPageView } from './ComicPageView';
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

  it('safety: a blocked page never becomes an <img>; Redraw safer / Check again are offered', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, safety: { assessed: 'X', at: 1 } };
    });
    const onRedrawSafer = vi.fn();
    const onCheckAgain = vi.fn();
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" safety={{ rating: 'PG-13', onRedrawSafer, onCheckAgain }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('[data-testid="balloon"]').length).toBe(0);
    expect(screen.getByRole('img', { name: 'Image withheld' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Redraw safer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRedrawSafer).toHaveBeenCalled();
    expect(onCheckAgain).toHaveBeenCalled();
  });

  it('safety: Redraw safer carries the host’s price for this user (usage terms for governed users)', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, safety: { assessed: 'X', at: 1 } };
    });
    const onRedrawSafer = vi.fn();
    render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" safety={{ rating: 'PG-13', onRedrawSafer, redrawPrice: '≈2% of your usage' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Redraw safer · ≈2% of your usage' }));
    expect(onRedrawSafer).toHaveBeenCalled();
  });

  it('safety: over the comic’s rating, the art AND its lettering are blurred together until Show', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, safety: { assessed: 'PG-13', at: 1 } };
    });
    const onChangeRating = vi.fn();
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" safety={{ rating: 'PG', onChangeRating }} />);
    const veiled = container.querySelector('[data-safety="over_rating"]')!;
    expect(veiled).toBeTruthy();
    const blurred = veiled.querySelector('[aria-hidden="true"]')!;
    expect(blurred.querySelector('img')).toBeTruthy();
    expect(blurred.querySelector('[data-testid="balloon"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change rating' }));
    expect(onChangeRating).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(container.querySelector('[data-safety="over_rating"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="balloon"]').length).toBe(5);
  });

  it('a blocked image without a veil shows the withheld tile, never an endless shimmer for a URL that is never signed', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, safety: { quarantined: true, at: 1 } };
    });
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} />);
    expect(pageBox(container)).toHaveAttribute('data-withheld', 'blocked');
    expect(container.querySelector('.studio-shimmer')).toBeNull();
    expect(screen.getByRole('img', { name: 'Image withheld' })).toBeInTheDocument();
  });

  it('a page withheld from readers (public snapshot) shows "Page N isn’t available right now"', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render = { status: 'ready', history: [], withheld: 'safety' };
    });
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} overlay={<span data-testid="ov" />} />);
    expect(screen.getByRole('img', { name: 'Page 1 isn’t available right now' })).toBeInTheDocument();
    expect(pageBox(container)).toHaveAttribute('data-withheld', 'safety');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('ov')).toBeInTheDocument();
  });

  it('classic rendering is unchanged without a veil (no extra wrapper around the art)', () => {
    const doc = makeSampleDoc();
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" />);
    expect(container.querySelector('[data-testid="page-veil"]')).toBeNull();
    expect(pageBox(container).firstElementChild?.className).toBe('absolute inset-0');
    expect(pageBox(container).querySelector(':scope > [data-testid="balloon-layer"]')).toBeTruthy();
  });

  it('forwards the balloon menu and edition text edits to the balloon layer', () => {
    const doc = makeSampleDoc();
    const onBalloonMenu = vi.fn();
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" editable onBalloonChange={vi.fn()} onBalloonMenu={onBalloonMenu} />);
    fireEvent.contextMenu(container.querySelector('[data-testid="balloon-hit"][data-line-id="pg_1_l2"]')!, { clientX: 10, clientY: 20 });
    expect(onBalloonMenu).toHaveBeenCalledWith('pg_1_l2', { x: 10, y: 20 });
  });

  it('passes edition edits through with { lang }', () => {
    const doc = makeSampleDoc();
    const onBalloonChange = vi.fn();
    const { container } = render(
      <ComicPageView doc={doc} page={doc.pages[0]} imageUrl="https://cdn.test/p1.png" editable editionLang="hi" onBalloonChange={onBalloonChange} />
    );
    fireEvent.keyDown(container.querySelector('[data-testid="balloon-hit"][data-line-id="pg_1_l2"]')!, { key: 'ArrowRight' });
    // The edition language rides along with the undo label and gesture (BalloonChangeOptions, LE-8).
    expect(onBalloonChange).toHaveBeenCalledWith('pg_1_l2', expect.objectContaining({ pinned: true }), { lang: 'hi', label: 'Move balloon', gesture: 'move' });
  });
});

describe('ComicCoverView', () => {
  it('draws the overlay title (CoverTitleLayer) on a textless cover, nothing extra on a painted one', () => {
    const doc = makeSampleDoc((d) => {
      d.brief.title = 'The Heist';
      d.cover = { ...d.cover, lettering: 'overlay', render: { status: 'ready', history: [], asset: { path: 'u/proj/cover.png', source: 'generated', at: 1, w: 1000, h: 1500 } } };
    });
    const { container, rerender } = render(<ComicCoverView doc={doc} imageUrl="https://cdn.test/cover.png" />);
    expect(screen.getByRole('img', { name: 'Cover of The Heist' })).toHaveClass('object-contain');
    expect(container.querySelector('[data-testid="cover-title"]')).toBeTruthy();
    expect(parseFloat(container.querySelector<HTMLElement>('[data-testid="comic-cover"]')!.style.aspectRatio)).toBeCloseTo(1000 / 1500, 4);
    const painted = { ...doc, cover: { ...doc.cover, lettering: 'in_art' as const } };
    rerender(<ComicCoverView doc={painted} imageUrl="https://cdn.test/cover.png" />);
    expect(container.querySelector('[data-testid="cover-title"]')).toBeNull();
  });

  it('withheld and blocked covers show the placeholder', () => {
    const doc = makeSampleDoc((d) => {
      d.cover = { ...d.cover, render: { status: 'ready', history: [], withheld: 'safety' } };
    });
    render(<ComicCoverView doc={doc} />);
    expect(screen.getByRole('img', { name: 'The cover isn’t available right now' })).toBeInTheDocument();
  });
});
