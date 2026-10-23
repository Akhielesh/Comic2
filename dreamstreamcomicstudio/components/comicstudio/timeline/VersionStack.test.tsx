// VersionStack + the versions card: flip, use (free, optimistic render_use), compare, sheet confirm,
// honest staleness after a restore.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { pageSpecHash, type ComicDoc } from '../../../shared/comic/doc';
import { makeFakeStudio, resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { A, richDoc } from './__fixtures__/richDoc';
import { VersionStack } from './VersionStack';
import { VersionsCard } from './VersionsCard';

// Admin / own-key wording (dollars) unless a test publishes a governed status.
beforeEach(() => showDollarPrices());
afterEach(() => resetUsageStatus());

const P1 = { kind: 'page' as const, id: 'pg_1' };
const setup = (doc: ComicDoc = richDoc(), props: Partial<React.ComponentProps<typeof VersionStack>> = {}, extra: Parameters<typeof makeFakeStudio>[0] = {}) => {
  const studio = makeFakeStudio({ doc, ...extra });
  const utils = render(<VersionStack studio={studio} target={P1} {...props} />);
  return { studio, ...utils };
};

describe('VersionStack', () => {
  it('opens on the current version and flips through all versions (v1 = oldest)', () => {
    setup();
    expect(screen.getByText('v3 of 3 · current')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Current version' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Older version' }));
    expect(screen.getByText('v2 of 3')).toBeInTheDocument();
    expect(screen.getByText('1:1, not 4:5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^v1, archived/ }));
    expect(screen.getByText('v1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    // Recorded facts only.
    fireEvent.click(screen.getByRole('radio', { name: /^v3, current/ }));
    const facts = screen.getByRole('group', { name: /Page 1: 3 versions/ });
    expect(within(facts).getByText('Nano Banana 2.1')).toBeInTheDocument();
    expect(within(facts).getByText('$0.06')).toBeInTheDocument();
    expect(within(facts).getByText('0.82')).toBeInTheDocument();
  });

  it('"Use v2 · Free" sends one optimistic render_use and offers Undo', () => {
    const { studio } = setup();
    fireEvent.click(screen.getByRole('radio', { name: /^v2/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use v2 · Free' }));
    expect(studio.patch).toHaveBeenCalledTimes(1);
    const [ops, opts] = studio.patch.mock.calls[0];
    expect(ops).toEqual([{ op: 'render_use', target: P1, path: 'u/x/p/p1-v2.webp', at: expect.any(Number) }]);
    expect(opts).toMatchObject({ label: 'Use version' });
    expect(screen.getByText('Page 1 now uses v2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(studio.patch.mock.calls[1][0]).toEqual([{ op: 'render_use', target: P1, path: 'u/x/p/p1-v3.webp', at: expect.any(Number) }]);
  });

  it('after restoring an old version the stale badge is honest', () => {
    const doc = richDoc();
    // v2 was drawn for an older script; it is current now.
    doc.pages[0].render = { ...doc.pages[0].render, asset: A('p1-v2', 20, { w: 800, h: 1000 }), specHash: 'old-spec', history: [{ ...A('p1-v3', 30), specHash: pageSpecHash(doc, doc.pages[0]) }] };
    setup(doc);
    expect(screen.getByText('Out of date')).toBeInTheDocument();
    expect(screen.getByText(/drawn before the latest script or style changes, so it shows as out of date/)).toBeInTheDocument();
  });

  it('compare shows both versions with a diff of what was recorded', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').map((r) => r.textContent);
    expect(rows).toContain('ModelNot recordedNano Banana 2.1');
    expect(rows).toContain('CostNot recorded$0.06');
    expect(screen.getByRole('button', { name: 'Use v2 · Free' })).toBeInTheDocument();
  });

  it('a busy image cannot switch versions; a blocked version never renders as an image', () => {
    const doc = richDoc();
    doc.pages[0].render = { ...doc.pages[0].render, status: 'rendering' };
    doc.pages[0].render.history = [{ ...doc.pages[0].render.history[0], safety: { assessed: 'X', at: 1 } as never }];
    setup(doc);
    fireEvent.click(screen.getByRole('radio', { name: /^v2/ }));
    expect(screen.getByRole('button', { name: 'Use v2 · Free' })).toBeDisabled();
    expect(screen.queryByAltText('Page 1, version 2')).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Hidden by the content check' }).length).toBeGreaterThan(0);
  });

  it('a character-sheet version that would put drawn pages out of date asks first', () => {
    const { studio } = setup(richDoc(), { target: { kind: 'sheet', id: 'c_maya' } });
    fireEvent.click(screen.getByRole('radio', { name: /^v1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use v1 · Free' }));
    expect(studio.patch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/marks page 1 out of date/);
    fireEvent.click(screen.getByRole('button', { name: 'Use v1 anyway' }));
    expect(studio.patch.mock.calls[0][0]).toEqual([{ op: 'render_use', target: { kind: 'sheet', id: 'c_maya' }, path: 'u/x/p/maya-v1.webp', at: expect.any(Number) }]);
  });

  it('a current version whose shape does not match the book offers the free fit itself (no round-trip message now)', () => {
    const doc = richDoc();
    doc.pages[0].render = { ...doc.pages[0].render, asset: A('p1-sq', 31, { w: 1024, h: 1024 }) };
    const { studio } = setup(doc);
    expect(screen.getByText(/This version is 1:1; the book is 4:5/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fit to 4:5 · Free' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'fit_render', target: P1 });
  });

  it('governed users never see dollars: facts, compare, the stale note and the sheet confirm speak in usage', () => {
    showUsagePrices(1);
    const doc = richDoc();
    doc.pages[0].render = { ...doc.pages[0].render, specHash: 'old-spec' };
    const { container, unmount } = setup(doc);
    expect(container.textContent).not.toMatch(/\$/);
    expect(screen.getByText(/redraw it \((≈[\d.]+%|<0\.1%) of your usage\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(container.textContent).not.toMatch(/\$/);
    unmount();
    const sheet = setup(richDoc(), { target: { kind: 'sheet', id: 'c_maya' } });
    fireEvent.click(screen.getByRole('radio', { name: /^v1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use v1 · Free' }));
    expect(screen.getByRole('alert').textContent).toMatch(/would cost (≈[\d.]+%|<0\.1%) of your usage/);
    expect(sheet.container.textContent).not.toMatch(/\$/);
  });

  it('fails closed in readable words: before the usage status loads, the sheet confirm has no dollars and no broken phrase', () => {
    resetUsageStatus();
    setup(richDoc(), { target: { kind: 'sheet', id: 'c_maya' } });
    fireEvent.click(screen.getByRole('radio', { name: /^v1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use v1 · Free' }));
    const text = screen.getByRole('alert').textContent || '';
    expect(text).toMatch(/would cost a little of your usage\./);
    expect(text).not.toMatch(/\$|cost uses a little/);
  });

  it('an undrawn image says so instead of showing an empty stack', () => {
    setup(richDoc(), { target: { kind: 'page', id: 'pg_2' } });
    expect(screen.getByText(/isn’t drawn yet/)).toBeInTheDocument();
  });
});

describe('VersionsCard (chat)', () => {
  it('renders a live compact stack and handles a deleted target honestly', () => {
    const studio = makeFakeStudio({ doc: richDoc() });
    const msg = { id: 'm', role: 'assistant' as const, text: '', at: 1 };
    const { rerender } = render(<VersionsCard card={{ type: 'versions', id: 'c1', target: P1 }} message={msg} studio={studio} />);
    expect(screen.getByRole('region', { name: 'Page 1 versions' })).toBeInTheDocument();
    expect(screen.getByText('3 saved · switching is free')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^v2/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use v2 · Free' }));
    expect(studio.patch).toHaveBeenCalled();
    rerender(<VersionsCard card={{ type: 'versions', id: 'c1', target: { kind: 'page', id: 'pg_gone' } }} message={msg} studio={studio} />);
    expect(screen.getByText(/no longer in the comic/)).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
