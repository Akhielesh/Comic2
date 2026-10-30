// The page script shows each panel's words against what it holds (A4 wave note 4, the rest of FX2): the same numbers
// as the director's line-edit budget and the breakdown card (pagePlanCheck on the boxes the words are lettered
// into), with "too full" said in words on an overfull panel and nothing on a silent one.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { drawnPanelBoxes } from '../../../shared/comic/pageGeometry';
import { checkPagePlan } from '../../../shared/comic/pagePlanCheck';
import { p2ShapedDoc } from '../../../shared/comic/lettering/__fixtures__/letterFit';
import { PageScript, panelWordFits } from './PageScript';

describe('PageScript: words / fits about N per panel', () => {
  it('panelWordFits states every lettered panel’s words and budget, measured on the drawn panels', () => {
    const { doc, page } = p2ShapedDoc();
    const check = checkPagePlan(doc, page, { fixLayout: false, boxes: drawnPanelBoxes(doc, page) });
    const fits = panelWordFits(doc, page);
    expect(fits).toHaveLength(6);
    check.panels.forEach((p, i) => {
      if (p.words === 0) expect(fits[i]).toBeUndefined();
      else expect(fits[i]).toEqual({ text: `${p.words} word${p.words === 1 ? '' : 's'} / fits about ${p.budget}`, state: p.state });
    });
    // Panel 3 is silent; panel 6 carries the page's two long lines and is too full for its size.
    expect(fits[2]).toBeUndefined();
    expect(check.panels[5].state).toBe('overfull');
  });

  it('renders the line in each panel’s meta row; an overfull panel says "too full" in words, in the danger text tone', () => {
    const { doc, page } = p2ShapedDoc();
    const fits = panelWordFits(doc, page);
    render(<PageScript doc={doc} page={page} />);
    const six = screen.getByText(fits[5]!.text, { exact: false });
    expect(six).toHaveTextContent(`${fits[5]!.text} — too full`);
    expect(six).toHaveAttribute('data-fit', 'overfull');
    expect(six.className).toMatch(/text-\[var\(--ds-danger-text\)\]/);
    const one = screen.getByText(fits[0]!.text);
    expect(one).toHaveAttribute('data-fit', fits[0]!.state);
    expect(one.className).not.toMatch(/danger/);
    expect(screen.queryAllByText(/fits about/)).toHaveLength(fits.filter(Boolean).length);
  });
});
