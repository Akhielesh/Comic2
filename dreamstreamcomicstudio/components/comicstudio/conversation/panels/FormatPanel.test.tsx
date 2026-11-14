// FormatPanel — panels per page (plan §4.1, §5.1; decision PD-2): Auto · Scene-driven panels, then 2–6.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createEmptyDoc } from '../../../../shared/comic/doc';
import { applyOps } from '../../../../shared/comic/ops';
import { PANEL_LIMITS, panelCountNote, panelCountRule } from '../../../../shared/comic/panelRules';
import { makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';
import { FormatPanel, PANEL_OPTIONS, autoPanelsLabel, panelChoiceHint } from './FormatPanel';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const group = () => screen.getByRole('radiogroup', { name: 'Panels per page' });

const openStartingFormats = () => {
  fireEvent.click(screen.getByText('Browse starting formats', { selector: 'summary' }));
  return within(screen.getByRole('group', { name: 'Starting formats' }));
};

describe('FormatPanel — starting formats', () => {
  it('applies a single free patch with visible settings and keeps unrelated creative choices', () => {
    const doc = createEmptyDoc('new-comic');
    doc.format = { ...doc.format, language: 'ja', colorMode: 'bw', lettering: 'in_art' };
    const patch = vi.fn();
    const { rerender } = render(<FormatPanel doc={doc} patch={patch} />);
    expect(patch).not.toHaveBeenCalled();
    const options = openStartingFormats();
    const manga = options.getByRole('button', { name: 'Right-to-left manga' });
    expect(manga).toHaveAccessibleDescription(/2:3 · Story-driven length · Auto panels · RTL/);
    fireEvent.click(manga);
    expect(patch).toHaveBeenCalledExactlyOnceWith([{ op: 'format', patch: { kind: 'manga', readingDirection: 'rtl' } }]);
    const after = applyOps(doc, patch.mock.calls[0][0]);
    expect(after.format).toMatchObject({ language: 'ja', colorMode: 'bw', lettering: 'in_art', kind: 'manga' });
    rerender(<FormatPanel doc={after} patch={patch} />);
    expect(manga).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(manga);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('shows the supported strip shape on Pro and prevents a long-scroll choice without the required aspect', () => {
    const doc = createEmptyDoc('new-comic');
    doc.settings = { ...doc.settings, quality: 'pro' };
    const patch = vi.fn();
    render(<FormatPanel doc={doc} patch={patch} />);
    const options = openStartingFormats();
    const long = options.getByRole('button', { name: 'Long-scroll webtoon' });
    expect(long).toHaveAttribute('aria-disabled', 'true');
    expect(long).toHaveAccessibleDescription(/supports 1:4/);
    fireEvent.click(long);
    expect(patch).not.toHaveBeenCalled();
    const strip = options.getByRole('button', { name: 'Daily comic strip' });
    expect(strip).toHaveAccessibleDescription(/21:9 · Story-driven length · Prefer 4 panels/);
    fireEvent.click(strip);
    expect(patch).toHaveBeenCalledExactlyOnceWith([{ op: 'format', patch: { kind: 'strip', pageAspect: '21:9', panelsPerPage: 4 } }]);
  });

  it('keeps the manual settings available for an existing comic and does not offer structural presets', () => {
    const doc = makeSampleDoc();
    render(<FormatPanel doc={doc} patch={vi.fn()} />);
    expect(screen.queryByText('Browse starting formats')).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Comic kind' })).toBeInTheDocument();
  });
});

describe('FormatPanel — panels per page', () => {
  it('offers Auto (labelled "Scene-driven panels") and 2, 3, 4, 5, 6 — 2 included', () => {
    render(<FormatPanel doc={makeSampleDoc()} patch={vi.fn()} />);
    const radios = within(group()).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Auto · Scene-driven panels', '2 panels', '3 panels', '4 panels', '5 panels', '6 panels']);
    expect(radios.map((r) => r.textContent)).toEqual(['AutoScene-driven panels', '2', '3', '4', '5', '6']);
    expect(radios[0]).toHaveAccessibleName('Auto · Scene-driven panels');
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(within(group()).getByRole('radio', { name: '2 panels' })).toBeInTheDocument();
    expect(PANEL_OPTIONS).toEqual(['auto', ...PANEL_LIMITS.uiChoices]);
    // What Auto plans, in words, under the choice.
    expect(screen.getByText(/^Auto: the Director chooses/)).toBeInTheDocument();
  });

  it('offers scene-driven pacing for all comic kinds', () => {
    for (const kind of ['comic', 'manga', 'webtoon', 'strip', 'storybook'] as const) {
      expect(autoPanelsLabel(kind)).toBe('Scene-driven panels');
      expect(panelChoiceHint({ kind, panelsPerPage: 'auto' })).toContain('each page’s panels and layout');
    }
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
    expect(screen.getByText(/^Prefer around 2 panels;/)).toBeInTheDocument();
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expect(patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { panelsPerPage: 3 } }]);
    fireEvent.keyDown(group(), { key: 'ArrowLeft' });
    expect(patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { panelsPerPage: 'auto' } }]);
  });

  it('a storybook set above 3 says new pages are planned with 3 (PD-2); an old count outside 2–6 stays visible', () => {
    const doc = makeSampleDoc();
    const story = { ...doc, format: { ...doc.format, kind: 'storybook' as const, pageAspect: '4:3' as const, panelsPerPage: 5 } };
    const { unmount } = render(<FormatPanel doc={story} patch={vi.fn()} />);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByText(panelChoiceHint(story.format))).toHaveTextContent('Prefer around 5 panels');
    unmount();
    const old = { ...doc, format: { ...doc.format, panelsPerPage: 9 } };
    render(<FormatPanel doc={old} patch={vi.fn()} />);
    expect(screen.queryByRole('note')).toBeNull();
    expect(within(group()).getByRole('radio', { name: '9 panels (current)' })).toHaveAttribute('aria-checked', 'true');
  });

  it('treats numeric density as a preference and never shows a storybook clamp', () => {
    const doc = makeSampleDoc();
    doc.format = { ...doc.format, kind: 'storybook', panelsPerPage: 5 };
    render(<FormatPanel doc={doc} patch={vi.fn()} />);
    expect(screen.getByText(panelChoiceHint(doc.format))).toHaveTextContent('Prefer around 5 panels');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('starts new books with Director-chosen length and lets the author request a count', () => {
    const doc = createEmptyDoc('adaptive');
    const patch = vi.fn();
    const { rerender } = render(<FormatPanel doc={doc} patch={patch} />);
    expect(screen.getByRole('button', { name: 'Director chooses' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'More pages' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Set page count' }));
    const fixed = applyOps(doc, patch.mock.calls.at(-1)![0]);
    expect(fixed.format.pageCountMode).toBe('fixed');
    rerender(<FormatPanel doc={fixed} patch={patch} />);
    fireEvent.click(screen.getByRole('button', { name: 'More pages' }));
    expect(applyOps(fixed, patch.mock.calls.at(-1)![0]).format).toMatchObject({ pageCount: 7, pageCountMode: 'fixed' });
    fireEvent.click(screen.getByRole('button', { name: 'Director chooses' }));
    expect(applyOps(fixed, patch.mock.calls.at(-1)![0]).format.pageCountMode).toBe('auto');
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
