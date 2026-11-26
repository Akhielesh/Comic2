// Inside a comic (SH-C2), in the studio shell: the header's breadcrumb (My comics › the comic › the board's area › the
// part you are on) where every crumb but the comic's own name field navigates, folding on a phone; and the side panel's
// parts tree going where each part is edited (a character's card and the cover's come into view with focus, a page
// opens in the page editor), in the docked panel and the phone drawer. Nothing here spends: act and send are never
// called. The board is a small stand-in with the real card ids.
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
const crumbs = () => within(screen.getByRole('banner')).getByRole('navigation', { name: 'Breadcrumb' });
const crumbNames = () => within(crumbs()).getAllByRole('listitem').map((li) => within(li).queryByRole('textbox') ? 'title' : li.textContent);
const tree = () => within(screen.getByRole('navigation', { name: 'Project navigation' })).getByRole('tree', { name: 'Board' });

beforeEach(() => {
  window.localStorage.clear();
  resetBackStack();
  resetPanelPreferenceForTests();
  showDollarPrices();
});
afterEach(() => resetUsageStatus());

describe('the breadcrumb', () => {
  it('reads My comics › the comic › the open area, and My comics leaves the studio', () => {
    const { onBack } = mountAt(DESK, makeFakeStudio({ tab: 'pages' }));
    expect(crumbNames()).toEqual(['My comics', 'title', 'Pages']);
    expect(within(crumbs()).getByRole('textbox', { name: 'Comic title' })).toHaveValue('Rooftop Heist');
    expect(within(crumbs()).getByRole('button', { name: 'Pages' })).toHaveAttribute('aria-current', 'page');
    expect(crumbs().querySelectorAll('[aria-current]')).toHaveLength(1);
    fireEvent.click(within(crumbs()).getByRole('button', { name: 'My comics' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('follows the card you are on, and every crumb past the name goes somewhere', async () => {
    const studio = makeFakeStudio({ tab: 'cast' });
    mountAt(DESK, studio);
    const card = document.getElementById('cast-character-c_arjun')!;
    fireEvent.focus(within(card).getByRole('textbox'));
    fireEvent.focusIn(within(card).getByRole('textbox'));
    expect(crumbNames()).toEqual(['My comics', 'title', 'Cast', 'Arjun']);
    const item = within(crumbs()).getByRole('button', { name: 'Arjun' });
    expect(item).toHaveAttribute('aria-current', 'page');
    expect(item).toHaveAttribute('title', 'Arjun');
    expect(within(crumbs()).getByRole('button', { name: 'Cast' })).not.toHaveAttribute('aria-current');
    // The tree marks the same part.
    expect(within(tree()).getByRole('treeitem', { name: 'Arjun' })).toHaveAttribute('aria-selected', 'true');
    // The part: back into view with focus on its card.
    fireEvent.click(item);
    await waitFor(() => expect(card).toHaveFocus());
    // The area: back to its top; the board takes focus, so no card is the part any more.
    fireEvent.click(within(crumbs()).getByRole('button', { name: 'Cast' }));
    await waitFor(() => expect(document.getElementById('board-panel')).toHaveFocus());
    expect(crumbNames()).toEqual(['My comics', 'title', 'Cast']);
    expect(studio.act).not.toHaveBeenCalled();
    expect(studio.send).not.toHaveBeenCalled();
  });

  it('the page in the editor is the last crumb; a card in another tab is not', () => {
    const { rerenderWith } = mountAt(DESK, makeFakeStudio({ tab: 'pages', focusedPageId: 'pg_2' }));
    expect(crumbNames()).toEqual(['My comics', 'title', 'Pages', 'Page 2']);
    rerenderWith(makeFakeStudio({ tab: 'story', focusedPageId: 'pg_2' }));
    expect(crumbNames()).toEqual(['My comics', 'title', 'Story']);
  });

  it('shows no area while the board is out of sight (the chat-only pane)', () => {
    mountAt(DESK, makeFakeStudio({ tab: 'pages' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Panes' })).getByRole('radio', { name: 'Chat only' }));
    expect(crumbNames()).toEqual(['My comics', 'title']);
    expect(within(crumbs()).getByRole('textbox', { name: 'Comic title' })).toHaveAttribute('aria-current', 'page');
  });

  it('folds on a phone: no My comics (the drawer starts with it), the area gives way to the part, the part clips', () => {
    mountAt(PHONE, makeFakeStudio({ tab: 'pages', focusedPageId: 'pg_3' }));
    // The conversation is on screen: the comic is where you are.
    expect(crumbNames()).toEqual(['title']);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Studio views' })).getByRole('button', { name: /^Board/ }));
    expect(crumbNames()).toEqual(['title', 'Page 3']);
    const part = within(crumbs()).getByRole('button', { name: 'Page 3' });
    expect(part.closest('li')!.className).toContain('max-w-[10rem]');
    expect(part.querySelector('.truncate')).not.toBeNull();
    expect(part.className).toContain('coarse:h-11');
    // The name shrinks first, down to a readable minimum, and never pushes the header sideways.
    expect(within(crumbs()).getByRole('textbox', { name: 'Comic title' }).closest('li')!.className).toContain('min-w-[2.5rem]');
    expect(crumbs()).toHaveAttribute('data-room', 'narrow');
    expect(crumbs().className).toContain('overflow-x-clip');
  });
});

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
    expect(crumbNames()).toEqual(['My comics', 'title', 'Pages', 'Cover']);
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
