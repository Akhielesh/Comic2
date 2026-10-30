// Letter fit in the page editor (plan §10 A4): the "Too much text" chip and its free fixes in the lettering panel, and
// "Fix balloon placement" — free around the art, or the existing gated page re-check (recheck_page, ≈$0.004) quoted in
// usage words for governed users (never dollars) and in dollars for admins. Synthetic docs; nothing spends: the
// studio's act() is a spy and the server gates every spend.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PageEditor } from './PageEditor';
import { SAMPLE_NOW, makeStudio } from './__fixtures__/sampleDoc';
import { p2ShapedDoc } from '../../../shared/comic/lettering/__fixtures__/letterFit';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioController } from '../types';
import { recheckQuoteUsd } from '../lettering/LetteringInspector';

const allowance = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('../../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

const GOVERNED = {
  enabled: true,
  governed: true,
  pctUsed: 10,
  pctLeft: 90,
  exhausted: false,
  crossed: [],
  resetsAt: null,
  friendlyUnits: { standardPages: 100, draftPages: 300, pctPerStandardPage: 1, label: '' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false
};

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  allowance.status = null;
});

const docP2 = (): ComicDoc => {
  const { doc } = p2ShapedDoc();
  doc.planStatus = 'approved';
  return doc;
};
const open = (doc: ComicDoc = docP2()): StudioController => {
  const studio = makeStudio(doc, { focusedPageId: 'pg_2' });
  render(<PageEditor studio={studio} doc={doc} pageId="pg_2" />);
  return studio;
};
const acts = (studio: StudioController) => (studio.act as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
const patches = (studio: StudioController) => (studio.patch as ReturnType<typeof vi.fn>).mock.calls;

describe('Fix balloon placement (FX3): the paid re-check, quoted in the user\'s terms', () => {
  it('governed users see their usage share for the re-check, never dollars; choosing it sends the gated recheck_page with its quote', () => {
    allowance.status = GOVERNED;
    const studio = open();
    fireEvent.click(screen.getByTestId('placement-fix-chip'));
    const menu = screen.getByRole('menu');
    const paid = within(menu).getByRole('menuitem', { name: /Fix balloon placement/ });
    expect(paid.textContent).toMatch(/% of your usage/);
    expect(paid.textContent).not.toMatch(/\$/);
    expect(within(menu).getByRole('menuitem', { name: /Place around the art/ }).textContent).toMatch(/Free/);
    fireEvent.click(paid);
    expect(acts(studio)).toContainEqual({ type: 'recheck_page', pageId: 'pg_2', quotedUsd: recheckQuoteUsd(false) });
    // Nothing else was spent or patched.
    expect(acts(studio)).toHaveLength(1);
    expect(patches(studio)).toHaveLength(0);
  });

  it('admins see the price; the chip never shows on a page whose check measured faces', () => {
    allowance.status = { ...GOVERNED, governed: false };
    const { unmount } = render(<PageEditor studio={makeStudio(docP2(), { focusedPageId: 'pg_2' })} doc={docP2()} pageId="pg_2" />);
    fireEvent.click(screen.getByTestId('placement-fix-chip'));
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Fix balloon placement/ }).textContent).toMatch(/\$/);
    unmount();
    const faces = docP2();
    faces.pages[0].render.qc!.keepOut = [{ panel: 6, kind: 'face', box: { x: 0.7, y: 0.75, w: 0.08, h: 0.06 } }];
    open(faces);
    expect(screen.queryByTestId('placement-fix-chip')).toBeNull();
  });

  it('the re-check quote is the server\'s: the vision price with the platform markup, the provider price on the user\'s key', () => {
    expect(recheckQuoteUsd(false)).toBe(0.0039);
    expect(recheckQuoteUsd(true)).toBe(0.003);
  });
});

describe('Too much text for this panel (FX2): the chip and its free fixes', () => {
  it('the chip names the panel, selects its balloons, and the lettering panel says how much it holds with free fixes', () => {
    allowance.status = GOVERNED;
    const studio = open();
    const chip = screen.getByTestId('too-much-text-chip');
    expect(chip.textContent).toMatch(/Too much text · panel 6/);
    fireEvent.click(chip);
    const copy = screen.getByTestId('too-much-text-copy');
    expect(copy.textContent).toMatch(/^Too much text for panel 6: \d+ words cover about \d+% of the picture — it holds about \d+\./);
    // Both of the panel's balloons are selected (the lettering panel is open on them); nothing was spent or changed.
    expect(within(screen.getByTestId('lettering-inspector')).getByText('2 balloons')).toBeTruthy();
    expect(acts(studio)).toHaveLength(0);
    expect(patches(studio)).toHaveLength(0);
  });

  it('one balloon of the panel: Make it a caption and Move to a panel with room are free patches', () => {
    allowance.status = GOVERNED;
    const studio = open();
    const hit = document.querySelector<HTMLElement>('[data-testid="balloon-hit"][data-line-id="ln_6b"]')!;
    fireEvent.pointerDown(hit, { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { clientX: 5, clientY: 5 });
    const row = screen.getByTestId('too-much-text');
    fireEvent.click(within(row).getByRole('button', { name: 'Make it a caption' }));
    const [ops, opts] = patches(studio).at(-1)!;
    expect(ops[0]).toMatchObject({ op: 'line', pageId: 'pg_2', panelId: 'pn_6', id: 'ln_6b', patch: { kind: 'caption' } });
    expect(opts).toMatchObject({ undo: true, label: 'Make it a caption' });
    // The silent wide panel 3 has the most room.
    fireEvent.click(within(screen.getByTestId('too-much-text')).getByRole('button', { name: 'Move to panel 3' }));
    const [moveOps] = patches(studio).at(-1)!;
    expect(moveOps[0]).toMatchObject({ op: 'line_move', id: 'ln_6b', toPanelId: 'pn_3' });
    expect(acts(studio)).toHaveLength(0);
  });

  it('a page whose panels all fit shows no chip', () => {
    const { doc } = p2ShapedDoc({ panel6: 'one' });
    open(doc);
    expect(screen.queryByTestId('too-much-text-chip')).toBeNull();
  });
});
