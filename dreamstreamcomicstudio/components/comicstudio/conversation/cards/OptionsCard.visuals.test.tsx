// Pictures in questions (agent-editor plan §3 A3.3): a "Which line?" option shows a crop of that balloon from its page,
// a "Where?" option a page thumbnail with one cell highlighted. Synthetic fixtures only.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Card, ComicDoc } from '../../../../shared/comic/doc';
import { makeFakeStudio, makeSampleDoc } from '../testing/fixtures';
import { BalloonVisual, OptionsCard, SpotVisual, cellOf } from './OptionsCard';

type Options = Extract<Card, { type: 'options' }>;

/** pg_1 is drawn (its balloon placed at the top left); pg_2 is not drawn. */
const docWithBalloons = (): ComicDoc => {
  const doc = makeSampleDoc();
  doc.pages[0].balloons = [{ lineId: 'pg_1_l1', x: 0.1, y: 0.05, w: 0.25 }];
  return doc;
};

const whichLine = (pageId: string, lineId: string): Options => ({
  type: 'options',
  id: 'card_which',
  question: 'Which line?',
  choices: [
    { id: 'c1', label: '“Stop right there!”', reply: 'The first one', visual: { kind: 'balloon', pageId, lineId } },
    { id: 'c2', label: 'Another line', visual: { kind: 'spot', pageId: 'pg_1', cell: 'top-left', frame: 'page' } }
  ]
});

describe('OptionsCard visuals: balloon and spot', () => {
  it('a balloon on a drawn page is a crop of that page, centred on the balloon and outlined', () => {
    const studio = makeFakeStudio({ doc: docWithBalloons() });
    const { container } = render(<OptionsCard card={whichLine('pg_1', 'pg_1_l1')} studio={studio} />);
    const crop = container.querySelector('[data-visual="balloon"] img') as HTMLImageElement;
    expect(crop).toBeTruthy();
    expect(crop.getAttribute('src')).toBe('https://cdn.test/u/x/p/pg_1.webp');
    // A window 2.2× the balloon's width, centred on it: x 0.1 + 0.25/2 = 22.5 % across the page.
    expect(crop.style.width).toBe('181.82%');
    expect(crop.style.transform).toMatch(/^translate\(-22\.50%, -\d+(\.\d+)?%\)$/);
    // The second choice's spot is drawn in its tile too.
    expect(container.querySelector('[data-visual="spot"] [data-cell="top-left"]')).toBeTruthy();
    // The tile still answers with the choice's reply.
    fireEvent.click(screen.getByRole('button', { name: /Stop right there!/ }));
    expect(studio.send).toHaveBeenCalledWith('The first one', { card: { id: 'card_which', choiceIds: ['c1'] } });
  });

  it('a balloon on a page not drawn yet shows the line’s words in a bubble; a line that is gone shows nothing', () => {
    const doc = docWithBalloons();
    const { container } = render(<BalloonVisual pageId="pg_2" lineId="pg_2_l1" doc={doc} urlFor={makeFakeStudio().urlFor} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('“Stop right there!”');
    const gone = render(<BalloonVisual pageId="pg_2" lineId="ln_gone" doc={doc} urlFor={makeFakeStudio().urlFor} />);
    expect(gone.container.textContent).toBe('');
  });

  it('a page spot highlights one of the nine cells of the page over the drawn page', () => {
    const doc = docWithBalloons();
    const { container } = render(<SpotVisual visual={{ kind: 'spot', pageId: 'pg_1', cell: 'top-left', frame: 'page' }} doc={doc} urlFor={makeFakeStudio().urlFor} />);
    expect(container.querySelector('image')?.getAttribute('href')).toBe('https://cdn.test/u/x/p/pg_1.webp');
    const cell = container.querySelector('[data-cell="top-left"]')!;
    // A 2:3 page is 66.67 × 100 in the picture: the top-left third.
    expect(Number(cell.getAttribute('x'))).toBe(0);
    expect(Number(cell.getAttribute('width'))).toBeCloseTo(66.67 / 3, 1);
    expect(Number(cell.getAttribute('height'))).toBeCloseTo(100 / 3, 1);
    expect(container.querySelector('[data-frame="panel"]')).toBeNull();
  });

  it("a panel spot outlines that panel and highlights the cell inside it (undrawn: the panel outlines)", () => {
    const doc = docWithBalloons();
    const { container } = render(<SpotVisual visual={{ kind: 'spot', pageId: 'pg_2', panelN: 2, cell: 'bottom-right', frame: 'panel' }} doc={doc} urlFor={makeFakeStudio().urlFor} />);
    expect(container.querySelector('image')).toBeNull();
    const frame = container.querySelector('[data-frame="panel"]')!;
    const cell = container.querySelector('[data-cell="bottom-right"]')!;
    const fx = Number(frame.getAttribute('x'));
    const fw = Number(frame.getAttribute('width'));
    expect(Number(cell.getAttribute('x'))).toBeCloseTo(fx + (2 * fw) / 3, 3);
    expect(Number(cell.getAttribute('width'))).toBeCloseTo(fw / 3, 3);
  });

  it('cellOf splits a frame into nine cells, row by row', () => {
    expect(cellOf({ x: 0, y: 0, w: 0.9, h: 0.6 }, 'center')).toEqual({ x: expect.closeTo(0.3), y: expect.closeTo(0.2), w: expect.closeTo(0.3), h: expect.closeTo(0.2) });
    expect(cellOf({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 'bottom-left')).toEqual({ x: 0.1, y: expect.closeTo(0.3), w: expect.closeTo(0.1), h: expect.closeTo(0.1) });
  });
});
