// StudioTab gained 'history' (shared/comic/doc.ts; the H5 amendment). Every existing consumer stays correct: the board
// still shows exactly the old tabs while Comic History is off — whichever tab is open — and gains History (after Media,
// before Read) only while it is on; the QA harness's persisted ?tab= values still load; the history feature's tab id is
// a plain typed StudioTab.

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { StudioTab } from '../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../shared/comic/capabilities';
import { BoardPane, boardTabsFor } from './board/BoardPane';
import { makeFakeStudio, makeSampleDoc } from './conversation/testing/fixtures';
import { HISTORY_TAB_ID, HISTORY_TAB_ORDER } from './history/index';
import { parseQaParams } from './testing/qaController';
import { HISTORY_ON } from './history/history.testkit';

const OLD_TABS: readonly StudioTab[] = ['story', 'cast', 'style', 'pages', 'media', 'languages', 'read'];

const tabNames = () =>
  within(screen.getByRole('tablist', { name: 'Board' }))
    .getAllByRole('tab')
    .map((t) => t.textContent?.replace(/\d.*$/, '').trim());

afterEach(() => cleanup());

describe("StudioTab 'history'", () => {
  it('is the history feature\'s tab id, typed without a cast', () => {
    const id: StudioTab = HISTORY_TAB_ID;
    expect(id).toBe('history');
    expect(HISTORY_TAB_ORDER).toBe(510);
  });

  it('while History is off the board never lists it, whichever old tab is open', () => {
    const doc = makeSampleDoc();
    for (const tab of OLD_TABS) {
      const shown = boardTabsFor(doc, { ...DEFAULT_CAPS }, tab).map((t) => t.id);
      expect(shown, tab).not.toContain('history');
      render(<BoardPane studio={makeFakeStudio({ doc, tab, caps: { ...DEFAULT_CAPS } })} />);
      expect(tabNames(), tab).not.toContain('History');
      cleanup();
    }
  });

  it('while History is on it sits after the built-in Pages tab and before Read, and opens its panel', () => {
    const doc = makeSampleDoc();
    const shown = boardTabsFor(doc, HISTORY_ON, 'pages').map((t) => t.id);
    expect(shown.indexOf('history')).toBeGreaterThan(shown.indexOf('pages'));
    expect(shown.indexOf('history')).toBeLessThan(shown.indexOf('read'));
    render(<BoardPane studio={makeFakeStudio({ doc, tab: 'history', caps: HISTORY_ON })} />);
    expect(tabNames()).toContain('History');
    expect(screen.getByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('[data-history-tab]')).not.toBeNull();
  });

  it("the QA harness's persisted ?tab= values still load; 'history' is not one of them (falls back to Pages)", () => {
    for (const tab of OLD_TABS) expect(parseQaParams(`?surface=board&tab=${tab}`).tab, tab).toBe(tab);
    expect(parseQaParams('?surface=board&tab=history').tab).toBe('pages');
  });
});
