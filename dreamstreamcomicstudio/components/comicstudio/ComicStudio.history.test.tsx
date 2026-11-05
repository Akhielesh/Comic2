// Comic History in the studio shell (H5 FIX wave note 12; versions plan §8 "Entry points"). Phone headers narrower than
// HISTORY_HEADER_ICON_MIN_WIDTH have no room for one more 44 px icon, so History becomes a row in the ⋯ menu — exactly
// when the header icon is hidden, and only while Comic History is on. With caps.history false nothing changes: no row,
// no icon, nobody answers the open request.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS, type StudioCaps } from '../../shared/comic/capabilities';
import type { ComicStudioController } from './useStudio';

vi.mock('./board/BoardPane', () => ({ BoardPane: ({ studio }: { studio: ComicStudioController }) => <div data-testid="board">Board · {studio.tab}</div> }));

import { ComicStudioShell } from './ComicStudio';
import { HISTORY_HEADER_ICON_MIN_WIDTH, requestOpenHistory } from './history/index';
import { HISTORY_ON, historySetup, overflowProblems, settle, type Mounted } from './history/history.testkit';
import { resetBackStack } from './mobile/backStack';
import { resetUsageStatus, showDollarPrices, showUsagePrices } from './conversation/testing/fixtures';

const HINT = 'Look back and restore — free';

const mountShell = (opts: { width: number; height?: number; caps: StudioCaps; coarse?: boolean }): Mounted & ReturnType<typeof render> => {
  const m = historySetup({ width: opts.width, height: opts.height ?? 740, caps: opts.caps, coarse: opts.coarse });
  const utils = render(m.wrap(<ComicStudioShell studio={m.studio as unknown as ComicStudioController} onBack={vi.fn()} />));
  return { ...m, ...utils };
};

/** The studio header (conversation cards have <header>s of their own). */
const studioHeader = (): HTMLElement => document.querySelector('header[data-header]') as HTMLElement;

const openMenu = () => {
  fireEvent.click(within(studioHeader()).getByRole('button', { name: 'More' }));
  return screen.getByRole('menu', { name: 'More' });
};

/** Every control the header row shows (what a 320 px header has to hold). */
const headerControls = () =>
  within(studioHeader())
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label') || b.textContent || '')
    .sort();

beforeEach(() => {
  window.localStorage.clear();
  resetBackStack();
  showDollarPrices();
});
afterEach(() => {
  cleanup();
  resetUsageStatus();
  resetBackStack();
});

describe('the ⋯ menu carries History on narrow phone headers', () => {
  it('the cut-off is the History slot\'s own: 480 px', () => {
    expect(HISTORY_HEADER_ICON_MIN_WIDTH).toBe(480);
  });

  it.each([320, 360, 390, 479])('at %i px with History on: no header icon, a "History" row that opens the panel at the list', async (width) => {
    const m = mountShell({ width, caps: HISTORY_ON });
    expect(document.querySelector('[data-history-entry="header"]')).toBeNull();
    const menu = openMenu();
    const row = within(menu).getByRole('menuitem', { name: /History/ });
    expect(row).toHaveTextContent('History');
    expect(row).toHaveTextContent(HINT);
    // Placed after Read the comic, before Settings.
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((r) => r.textContent || '');
    const at = names.findIndex((n) => n.startsWith('History'));
    expect(names[at - 1]).toMatch(/^Read the comic/);
    expect(names[at + 1]).toMatch(/^Settings/);
    fireEvent.click(row);
    await act(async () => {
      await settle(6);
    });
    // The menu closed and the History panel (hosted by the header slot) opened.
    expect(screen.queryByRole('menu', { name: 'More' })).toBeNull();
    expect(document.querySelector('[data-history-sheet="History"]')).not.toBeNull();
    expect(m.api.calls.some((c) => c.method === 'list')).toBe(true);
  });

  it.each([320, 360])('at %i px the header gains nothing and the menu fits (no fixed width over the phone)', (width) => {
    const off = mountShell({ width, caps: { ...DEFAULT_CAPS } });
    const without = headerControls();
    off.unmount();
    mountShell({ width, caps: HISTORY_ON });
    expect(headerControls()).toEqual(without);
    const menu = openMenu();
    expect(overflowProblems(menu, width)).toEqual([]);
    expect(overflowProblems(studioHeader(), width)).toEqual([]);
    // The row is one 44 px target (48 on touch) whose label and hint truncate rather than push the sheet wider.
    const row = within(menu).getByRole('menuitem', { name: /History/ });
    expect(row.className).toMatch(/min-h-\[44px\]/);
    for (const line of Array.from(row.querySelectorAll('span.block'))) expect(line.className).toMatch(/\btruncate\b/);
  });

  it('governed users read the same row — no dollar sign anywhere in it', () => {
    showUsagePrices();
    mountShell({ width: 360, caps: HISTORY_ON });
    const row = within(openMenu()).getByRole('menuitem', { name: /History/ });
    expect(row.textContent).not.toContain('$');
  });

  it.each([
    ['a wide phone (540 px)', 540, 900],
    ['phone landscape (852 px)', 852, 393],
    ['a tablet (820 px)', 820, 1180],
    ['a desktop (1440 px)', 1440, 900]
  ])('on %s the header shows the History icon, so the menu has no History row', (_name, width, height) => {
    mountShell({ width, height, caps: HISTORY_ON, coarse: width < 1024 });
    expect(document.querySelector('[data-history-entry="header"]')).not.toBeNull();
    expect(within(openMenu()).queryByRole('menuitem', { name: /History/ })).toBeNull();
  });
});

describe('with Comic History off nothing changes', () => {
  it.each([320, 360, 479, 1440])('at %i px: no History row, no icon, and nobody answers the open request', (width) => {
    const m = mountShell({ width, caps: { ...DEFAULT_CAPS }, coarse: width < 1024 });
    expect(document.querySelector('[data-history-entry]')).toBeNull();
    const menu = openMenu();
    expect(within(menu).queryByRole('menuitem', { name: /History/ })).toBeNull();
    expect(menu.textContent).not.toContain(HINT);
    expect(requestOpenHistory({ view: 'list' })).toBe(false);
    expect(m.api.calls).toEqual([]);
  });
});
