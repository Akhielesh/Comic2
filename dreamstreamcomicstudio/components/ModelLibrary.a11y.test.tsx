// Model Library, current-page fixes (Models Phase 0, C1): the compare cap is announced, both modals
// are real dialogs (named, Escape closes, focus goes back to the opener even when a click did not focus
// it, as in Safari and Firefox on macOS), and the admin bench is neither rendered nor downloaded unless
// the server has confirmed an admin.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_CATALOG } from './models/__fixtures__/catalog';

const PAGE_MS = 30_000;

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  benchImported: false,
  adminAccess: (() => Promise.resolve({ isAdmin: false })) as () => Promise<{ isAdmin: boolean }>
}));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('../services/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billing')>()),
  getAdminAccess: vi.fn(() => state.adminAccess())
}));
vi.mock('./models/ModelBenchPanel', () => {
  state.benchImported = true;
  return { ModelBenchPanel: () => <div>Admin bench panel</div> };
});
vi.mock('../services/modelCatalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelCatalog')>()),
  loadCachedCatalog: () => null,
  fetchModelCatalog: vi.fn(async () => ({ models: FIXTURE_CATALOG, count: FIXTURE_CATALOG.length, total: FIXTURE_CATALOG.length, fetchedAt: Date.now(), degraded: false })),
  fetchModelVerification: vi.fn(async () => { throw new Error('stubbed: /verify is owned by the hotfix branch'); })
}));
vi.mock('../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/apiClient')>()),
  get: vi.fn(async (path: string) => { throw new Error(`offline in tests: ${path}`); })
}));

const { ModelLibrary } = await import('./ModelLibrary');

let userSeq = 0;
const signIn = () => {
  // useIsAdmin caches its answer per user id: a fresh id per test keeps each probe independent.
  state.user = { id: `user-${++userSeq}`, email: 'reader@dreamstream.test' };
};

const renderPage = async () => {
  render(<ModelLibrary onBack={() => undefined} />);
  await screen.findByText('Anthropic: Claude Sonnet 4.5', {}, { timeout: 4000 });
};

const cardOf = (name: string) => screen.getAllByRole('button', { name })[0].closest('div.cursor-pointer') as HTMLElement;
const compareButtonOf = (name: string) => within(cardOf(name)).getByRole('button', { name: /Compare/ });

beforeEach(() => {
  window.localStorage.clear();
  state.adminAccess = () => Promise.resolve({ isAdmin: false });
});
afterEach(() => {
  cleanup();
  state.user = null;
});

describe('compare cap', () => {
  it('announces a 6th add in a polite live region, re-announces a repeat, and withdraws it on removal', async () => {
    await renderPage();
    const names = FIXTURE_CATALOG.slice(0, 6).map((m) => m.name);
    for (const name of names.slice(0, 5)) fireEvent.click(compareButtonOf(name));
    const live = screen.getByRole('status', { name: '' });
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live.textContent).toBe('');

    fireEvent.click(compareButtonOf(names[5]));
    expect(live).toHaveTextContent('You can compare up to 5 models. Remove one to add another.');
    expect(compareButtonOf(names[5])).toHaveAttribute('aria-pressed', 'false');
    const first = live.firstElementChild;
    fireEvent.click(compareButtonOf(names[5]));
    // A new node (keyed by the attempt), so assistive tech announces the repeat.
    expect(live.firstElementChild).not.toBe(first);
    expect(live).toHaveTextContent('You can compare up to 5 models.');

    fireEvent.click(screen.getByRole('button', { name: `Remove ${names[0]} from comparison` }));
    expect(live.textContent).toBe('');
    expect(screen.getByText('4/5')).toBeInTheDocument();
  }, PAGE_MS);
});

describe('model detail dialog', () => {
  it('is a named modal dialog; Escape closes it and focus returns to the card that opened it', async () => {
    await renderPage();
    const opener = screen.getAllByRole('button', { name: 'OpenAI: GPT-4o' })[0];
    fireEvent.click(opener); // a click that does not move focus (Safari, Firefox on macOS)
    const dialog = await screen.findByRole('dialog', { name: 'OpenAI: GPT-4o' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
  }, PAGE_MS);

  it('returns focus to a top-pick opener too, and keeps Tab inside the dialog', async () => {
    await renderPage();
    const pick = screen.getAllByRole('button').find((b) => /#1 value/.test(b.textContent ?? ''))!;
    expect(pick).toBeTruthy();
    fireEvent.click(pick);
    const dialog = await screen.findByRole('dialog');
    const close = within(dialog).getByRole('button', { name: 'Close' });

    // Shift+Tab from the dialog itself wraps to its last control; Tab from the last wraps to the first.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    const last = document.activeElement as HTMLElement;
    expect(dialog.contains(last)).toBe(true);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(pick);
  }, PAGE_MS);
});

describe('compare dialog', () => {
  it('is a named modal dialog; Escape closes it and focus returns to the tray button', async () => {
    await renderPage();
    fireEvent.click(compareButtonOf('OpenAI: GPT-4o'));
    fireEvent.click(compareButtonOf('Anthropic: Claude Sonnet 4.5'));
    const open = screen.getByRole('button', { name: /^Compare 2$/ });
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: /Comparing 2 models/ });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(open);
  }, PAGE_MS);
});

describe('narrow screens (390 px)', () => {
  // jsdom has no layout, so this pins the structure that keeps the page from scrolling sideways:
  // every wide table sits in its own horizontal scroller (ScrollX), never directly in the page flow.
  const tablesOutsideAScroller = () =>
    Array.from(document.querySelectorAll('table')).filter((t) => !t.closest('[role="region"].overflow-x-auto'));

  it('every table in every view scrolls inside its own container', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Image model ranking/ }));
    expect(document.querySelectorAll('table').length).toBeGreaterThan(0);
    expect(tablesOutsideAScroller()).toEqual([]);
    for (const name of [/Providers table/, /Leaderboards/]) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(document.querySelectorAll('table').length).toBeGreaterThan(0);
      expect(tablesOutsideAScroller()).toEqual([]);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    fireEvent.click(compareButtonOf('OpenAI: GPT-4o'));
    fireEvent.click(compareButtonOf('Anthropic: Claude Sonnet 4.5'));
    fireEvent.click(screen.getByRole('button', { name: /^Compare 2$/ }));
    await screen.findByRole('dialog', { name: /Comparing 2 models/ });
    expect(tablesOutsideAScroller()).toEqual([]);
  }, PAGE_MS);
});

describe('admin bench', () => {
  const benchTab = () => screen.queryByRole('button', { name: /^Bench$/ });

  it('signed out: no Bench view and its chunk is never imported', async () => {
    await renderPage();
    expect(benchTab()).toBeNull();
    expect(state.benchImported).toBe(false);
  }, PAGE_MS);

  it('signed in while the admin check is pending, or answered no, or failed: no Bench view', async () => {
    for (const probe of [() => new Promise<never>(() => undefined), () => Promise.resolve({ isAdmin: false }), () => Promise.reject(new Error('403'))]) {
      signIn();
      state.adminAccess = probe;
      await renderPage();
      await act(async () => { await Promise.resolve(); });
      expect(benchTab()).toBeNull();
      cleanup();
    }
    expect(state.benchImported).toBe(false);
  }, PAGE_MS);

  it('a server-confirmed admin gets the Bench view, loaded on demand', async () => {
    signIn();
    state.adminAccess = () => Promise.resolve({ isAdmin: true });
    await renderPage();
    const tab = await screen.findByRole('button', { name: /^Bench$/ });
    expect(state.benchImported).toBe(false);
    fireEvent.click(tab);
    expect(await screen.findByText('Admin bench panel')).toBeInTheDocument();
    expect(state.benchImported).toBe(true);
  }, PAGE_MS);
});
