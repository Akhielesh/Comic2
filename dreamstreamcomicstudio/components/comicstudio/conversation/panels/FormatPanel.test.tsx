// FormatPanel — panels per page (plan §4.1, §5.1; decision PD-2): Auto · 3–4 big panels, then 2–6.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PANEL_LIMITS, panelCountNote } from '../../../../shared/comic/panelRules';
import { makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';
import { FormatPanel, PANEL_OPTIONS } from './FormatPanel';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const group = () => screen.getByRole('radiogroup', { name: 'Panels per page' });

describe('FormatPanel — panels per page', () => {
  it('offers Auto (labelled "3–4 big panels") and 2, 3, 4, 5, 6 — 2 included', () => {
    render(<FormatPanel doc={makeSampleDoc()} patch={vi.fn()} />);
    const radios = within(group()).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Auto · 3–4 big panels', '2 panels', '3 panels', '4 panels', '5 panels', '6 panels']);
    expect(radios.map((r) => r.textContent)).toEqual(['Auto3–4 big panels', '2', '3', '4', '5', '6']);
    expect(radios[0]).toHaveAccessibleName('Auto · 3–4 big panels');
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(within(group()).getByRole('radio', { name: '2 panels' })).toBeInTheDocument();
    expect(PANEL_OPTIONS).toEqual(['auto', ...PANEL_LIMITS.uiChoices]);
    // What Auto plans, in words, under the choice.
    expect(screen.getByText(/^Auto: usually 3 big panels a page \(2–4; 5 only for a fast, nearly silent moment\)/)).toBeInTheDocument();
  });

  it('choosing 2 is an instant, free format patch; arrow keys move and choose like a radio group', () => {
    const patch = vi.fn();
    const doc = makeSampleDoc();
    const { rerender } = render(<FormatPanel doc={doc} patch={patch} />);
    fireEvent.click(within(group()).getByRole('radio', { name: '2 panels' }));
    expect(patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { panelsPerPage: 2 } }]);
    const two = { ...doc, format: { ...doc.format, panelsPerPage: 2 } };
    rerender(<FormatPanel doc={two} patch={patch} />);
    expect(within(group()).getByRole('radio', { name: '2 panels' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group()).getByRole('radio', { name: '2 panels' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText(/^2 panels on every new page\./)).toBeInTheDocument();
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expect(patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { panelsPerPage: 3 } }]);
    fireEvent.keyDown(group(), { key: 'ArrowLeft' });
    expect(patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { panelsPerPage: 'auto' } }]);
  });

  it('a storybook set above 3 says new pages are planned with 3 (PD-2); an old count outside 2–6 stays visible', () => {
    const doc = makeSampleDoc();
    const story = { ...doc, format: { ...doc.format, kind: 'storybook' as const, pageAspect: '4:3' as const, panelsPerPage: 5 } };
    const { unmount } = render(<FormatPanel doc={story} patch={vi.fn()} />);
    expect(screen.getByRole('note')).toHaveTextContent(panelCountNote(story.format)!);
    expect(screen.getByRole('note')).toHaveTextContent('new pages are planned with 3');
    unmount();
    const old = { ...doc, format: { ...doc.format, panelsPerPage: 9 } };
    render(<FormatPanel doc={old} patch={vi.fn()} />);
    expect(screen.queryByRole('note')).toBeNull();
    expect(within(group()).getByRole('radio', { name: '9 panels (current)' })).toHaveAttribute('aria-checked', 'true');
  });

  it('fits 320 px and the narrow recap card: a wrapping grid sized by the panel, Auto spans two cells, 44 px targets', () => {
    render(<FormatPanel doc={makeSampleDoc()} patch={vi.fn()} />);
    expect(group().className).toMatch(/grid-cols-\[repeat\(auto-fill,minmax\(/);
    expect(group().className).toMatch(/\bmin-w-0\b/);
    const radios = within(group()).getAllByRole('radio');
    expect(radios[0].className).toMatch(/\bcol-span-2\b/);
    for (const r of radios) {
      expect(r.className).toMatch(/coarse:min-h-\[44px\]/);
      expect(r.className).toMatch(/\bmin-w-0\b/);
    }
    // the Auto words truncate inside their tile instead of widening it
    for (const span of radios[0].querySelectorAll(':scope > span')) expect(span.className).toMatch(/\btruncate\b/);
  });
});
