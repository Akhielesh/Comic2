// Inside a comic (SH-C2), in the studio shell: the side panel's parts tree going where each part is edited (a
// character's card and the cover's come into view with focus, a page opens in the page editor), in the docked panel and
// the phone drawer. Nothing here spends: act and send are never called. The board is a small stand-in with the real
// card ids.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComicStudioController } from './useStudio';
import { makeFakeStudio, resetUsageStatus, showDollarPrices, type FakeStudio } from './conversation/testing/fixtures';

vi.mock('./board/BoardPane', () => ({
  // The real pane's scrolling panel (#board-panel) with the cards the tree and the breadcrumb point at.
  BoardPane: ({ studio }: { studio: ComicStudioController }) => (
    <div data-testid="board">
      <div id="board-panel" role="tabpanel" tabIndex={-1} aria-label={`${studio.tab} workspace`}>
        {studio.tab === 'cast' &&
          studio.doc!.cast.map((c) => (
            <article key={c.id} id={`cast-character-${c.id}`} aria-label={c.name}>
              <input aria-label={`${c.name} name`} defaultValue={c.name} />
            </article>
          ))}
        {studio.tab === 'pages' && (
          <>
            <article id="board-cover-card" aria-label="Cover" />
            {studio.doc!.pages.map((p) => (
              <article key={p.id} id={`board-page-card-${p.id}`} aria-label={`Page ${p.n}`}>
                <button type="button">Open page {p.n}</button>
              </article>
            ))}
          </>
        )}
        <button type="button">Board tools</button>
      </div>
    </div>
  )
}));
vi.mock('./features', async (importOriginal) => ({ ...(await importOriginal<typeof import('./features')>()), registeredCard: () => undefined }));

import { ComicStudioShell } from './ComicStudio';
import { FormFactorProvider, formFactorFor } from './mobile/useFormFactor';
import { resetBackStack } from './mobile/backStack';
import type { FormFactor } from './mobile/formFactor';
import { resetPanelPreferenceForTests } from './panel/panelPreference';

const DESK = formFactorFor({ w: 1280, h: 800 });
const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });

const mountAt = (ff: FormFactor, studio: FakeStudio, onBack = vi.fn()) => {
  const ui = (s: FakeStudio) => (
    <FormFactorProvider value={ff}>
      <ComicStudioShell studio={s} onBack={onBack} />
    </FormFactorProvider>
  );
  const utils = render(ui(studio));
  return { ...utils, onBack, rerenderWith: (s: FakeStudio) => utils.rerender(ui(s)) };
};
const tree = () => within(screen.getByRole('navigation', { name: 'Project navigation' })).getByRole('tree', { name: 'Board' });

beforeEach(() => {
  window.localStorage.clear();
  resetBackStack();
  resetPanelPreferenceForTests();
  showDollarPrices();
});
afterEach(() => resetUsageStatus());

describe('the parts tree in the studio', () => {
  it('a character opens Cast and brings its card into view with focus; the page opens in the editor', async () => {
    const studio = makeFakeStudio({ tab: 'cast' });
    mountAt(DESK, studio);
    const card = document.getElementById('cast-character-c_maya')!;
    card.scrollIntoView = vi.fn();
    fireEvent.click(within(tree()).getByRole('treeitem', { name: 'Maya' }));
    expect(studio.setTab).toHaveBeenCalledWith('cast');
    await waitFor(() => expect(card).toHaveFocus());
    expect(card.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
    // Focus put there for this visit only: the card is not left in the tab order.
    expect(card).toHaveAttribute('tabindex', '-1');
    fireEvent.blur(card);
    expect(card).not.toHaveAttribute('tabindex');
    fireEvent.keyDown(within(tree()).getByRole('treeitem', { name: 'Pages' }), { key: 'ArrowRight' });
    fireEvent.click(within(tree()).getByRole('treeitem', { name: 'Page 3, Failed' }));
    expect(studio.openPage).toHaveBeenCalledWith('pg_3');
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('the cover opens Pages with focus on the cover’s card', async () => {
    const studio = makeFakeStudio({ tab: 'pages' });
    mountAt(DESK, studio);
    fireEvent.click(within(tree()).getByRole('treeitem', { name: /^Cover/ }));
    expect(studio.setTab).toHaveBeenCalledWith('pages');
    await waitFor(() => expect(document.getElementById('board-cover-card')).toHaveFocus());
  });

  it('in the phone drawer a part closes the drawer first, then its card takes focus', async () => {
    const studio = makeFakeStudio({ tab: 'cast' });
    mountAt(PHONE, studio);
    fireEvent.click(screen.getByRole('button', { name: 'Open project navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Project navigation' });
    fireEvent.click(within(within(drawer).getByRole('tree', { name: 'Board' })).getByRole('treeitem', { name: 'Arjun' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Project navigation' })).toBeNull());
    await waitFor(() => expect(document.getElementById('cast-character-c_arjun')).toHaveFocus());
    expect(document.querySelector('[data-pane="board"]')).not.toHaveAttribute('inert');
  });
});
