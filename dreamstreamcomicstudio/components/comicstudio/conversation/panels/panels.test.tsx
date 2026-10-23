import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { pageSpecHash, type ComicDoc } from '../../../../shared/comic/doc';
import { STYLE_PRESETS } from '../../../../shared/comic/stylePresets';
import { FormatPanel, drawnCurrentPages, isStalingChange, redrawQuoteUsd } from './FormatPanel';
import { StylePanel, presetOps } from './StylePanel';
import { QualityPanel } from './QualityPanel';
import { makeSampleDoc } from '../testing/fixtures';

/** Sample doc where page 1 is drawn and current (its specHash matches). */
const drawnDoc = (): ComicDoc => {
  const doc = makeSampleDoc();
  doc.pages[0] = { ...doc.pages[0], render: { ...doc.pages[0].render, specHash: pageSpecHash(doc, doc.pages[0]) } };
  return doc;
};

describe('FormatPanel — tell before staling', () => {
  it('says up front what a new shape would put out of date, with the redraw quote', () => {
    const doc = drawnDoc();
    expect(drawnCurrentPages(doc).map((p) => p.id)).toEqual(['pg_1']);
    render(<FormatPanel doc={doc} patch={vi.fn()} />);
    expect(screen.getByText(/1 page is already drawn/)).toHaveTextContent(
      `marks it out of date (redraw ≈ $${redrawQuoteUsd(doc, 1, false).toFixed(2)}) — nothing is redrawn until you ask`
    );
  });

  it('after a staling change it counts what went out of date and offers a free Switch back', () => {
    const doc = drawnDoc();
    const patch = vi.fn();
    const { rerender } = render(<FormatPanel doc={doc} patch={patch} />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Page shape' })).getByRole('radio', { name: /1:1/ }));
    expect(patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { pageAspect: '1:1' } }]);
    // the server applied it: page 1 is now stale
    const after: ComicDoc = { ...doc, format: { ...doc.format, pageAspect: '1:1' } };
    rerender(<FormatPanel doc={after} patch={patch} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 drawn page is now out of date');
    fireEvent.click(screen.getByRole('button', { name: /Switch back/ }));
    expect(patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { pageAspect: '2:3' } }]);
  });

  it('page count and direction are not staling; nothing drawn ⇒ no warning', () => {
    expect(isStalingChange(makeSampleDoc().format, { pageCount: 9, readingDirection: 'rtl' })).toBe(false);
    expect(isStalingChange(makeSampleDoc().format, { lettering: 'in_art' })).toBe(true);
    const doc = makeSampleDoc({ pages: [] });
    render(<FormatPanel doc={doc} patch={vi.fn()} />);
    expect(screen.queryByText(/out of date/)).toBeNull();
  });
});

describe('FormatPanel — fits narrow containers (recap card)', () => {
  it('the kind choice is a wrapping tile grid sized by the container, never a fixed 5-way bar', () => {
    const doc = makeSampleDoc();
    const patch = vi.fn();
    render(<FormatPanel doc={doc} patch={patch} />);
    const group = screen.getByRole('radiogroup', { name: 'Comic kind' });
    expect(group.className).toMatch(/grid-cols-\[repeat\(auto-fill,minmax\(/);
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(5);
    for (const r of radios) expect(r.querySelector('span.truncate')).not.toBeNull();
    expect(within(group).getByRole('radio', { name: 'Comic' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Manga' }));
    expect(patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { kind: 'manga', readingDirection: 'rtl' } }]);
  });
});

describe('StylePanel — library tiles', () => {
  it('the long "Explore" label wraps inside its button instead of spilling out of a fixed height', () => {
    const doc = makeSampleDoc();
    doc.style = { ...doc.style, options: [] };
    render(<StylePanel doc={doc} patch={vi.fn()} act={vi.fn()} onDescribeOwn={vi.fn()} onDone={vi.fn()} />);
    const explore = screen.getByRole('button', { name: /Explore 3 directions/ });
    expect(explore.className).toMatch(/!h-auto/);
    expect(explore.parentElement!.className).toMatch(/\bflex-wrap\b/);
  });

  it('every preset tile shows preview art (library image or procedural fallback) and picks instantly', () => {
    const doc = makeSampleDoc();
    const patch = vi.fn();
    render(<StylePanel doc={doc} patch={patch} act={vi.fn()} onDescribeOwn={vi.fn()} onDone={vi.fn()} />);
    const radios = within(screen.getByRole('radiogroup', { name: 'Style presets' })).getAllByRole('radio');
    expect(radios).toHaveLength(STYLE_PRESETS.length);
    for (const r of radios) expect(r.querySelector('[data-preset-art]')?.childElementCount).toBeGreaterThan(0);
    const target = STYLE_PRESETS.find((p) => p.id !== doc.style.presetId)!;
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(target.name) }));
    expect(patch).toHaveBeenCalledWith(presetOps(doc, target));
  });
});

describe('QualityPanel', () => {
  it('lists the three tiers and switches with a free settings patch', () => {
    const patch = vi.fn();
    render(<QualityPanel doc={makeSampleDoc()} patch={patch} />);
    const radios = within(screen.getByRole('radiogroup', { name: 'Quality' })).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    fireEvent.click(radios[2]);
    expect(patch).toHaveBeenCalledWith([{ op: 'settings', patch: { quality: 'pro' } }]);
  });
});
