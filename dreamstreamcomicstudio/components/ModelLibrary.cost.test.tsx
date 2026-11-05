// The Model Library never shows a dollar figure to a signed-in viewer who does not pay in dollars
// (Models Phase 0, finding 3). Every view of the page is rendered for each viewer context: the catalog
// with its cards, top picks and the opened image ranking, the detail modal (a model whose description
// quotes vendor prices, and a token-billed image model with the server's real "$0 per image" drawback),
// the compare modal, the providers table, the leaderboards and the benchmarks view. At each step the scan
// covers the visible text, every title and aria-label, and the bubble of every help tooltip (each
// InfoTooltip trigger is focused, which is how a keyboard user opens it).
//
// The allowance store is mocked ABOVE services/usageAllowance's normalizer here (the cost fields are put
// straight on the status), so the admin and own-key cases show what the page does with the fields once
// they reach it. Whether they reach it through the real store is pinned in costView.test.ts.
//
// /api/models/verify (VerifiedStrip) is stubbed to fail: its strip is owned by the separate /verify
// hotfix and renders only for admins / own-key users once that merges.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_CATALOG, PRICED_DESCRIPTION, TOKEN_BILLED_IMAGE_MODEL } from './models/__fixtures__/catalog';

const DOLLAR = /\$\s?\d/;
// Each case renders the whole page and walks every view: give it room on a slow CI box.
const WALK_MS = 60_000;

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  allowance: null as unknown
}));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('../hooks/useIsAdmin', () => ({ useIsAdmin: () => false }));
vi.mock('../services/modelCatalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelCatalog')>()),
  loadCachedCatalog: () => null,
  fetchModelCatalog: vi.fn(async () => ({ models: FIXTURE_CATALOG, count: FIXTURE_CATALOG.length, total: FIXTURE_CATALOG.length, fetchedAt: Date.now(), degraded: false })),
  fetchModelVerification: vi.fn(async () => { throw new Error('stubbed: /verify is owned by the hotfix branch'); })
}));
vi.mock('../services/usageAllowance', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/usageAllowance')>();
  return {
    ...real,
    getLastAllowanceStatus: () => state.allowance,
    refreshAllowanceStatus: vi.fn(async () => state.allowance),
    subscribeAllowanceStatus: () => () => undefined
  };
});
// Every other read on the page (speed, bench scores, usage trends, popularity, admin probe) answers
// "unavailable", which each one already degrades from.
vi.mock('../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/apiClient')>()),
  get: vi.fn(async (path: string) => { throw new Error(`offline in tests: ${path}`); })
}));

const { ModelLibrary } = await import('./ModelLibrary');
const { normalizeAllowanceStatus } = await import('../services/usageAllowance');

/** A status as services/usageAllowance holds it, plus the cost fields DreamStream is adding. */
const allowance = (fields: Record<string, unknown>, governed = true) => ({
  ...normalizeAllowanceStatus({
    pctUsed: 20,
    pctLeft: 80,
    governed,
    friendlyUnits: { label: 'about 150 standard comic pages left', standardPages: 150, draftPages: 210, pctPerStandardPage: 0.5 }
  }),
  ...fields
});

const CONTEXTS: Record<string, unknown> = {
  governed: allowance({ viewer: 'governed', costView: 'bands', payer: { openrouter: 'platform', nvidia: 'platform' } }),
  'governed (share)': allowance({ viewer: 'governed', costView: 'share', payer: { openrouter: 'platform' } }),
  exempt: allowance({ viewer: 'exempt', costView: 'bands', payer: {} }, false),
  metering_off: allowance({ viewer: 'metering_off', costView: 'bands', payer: {} }, false),
  'fields absent': allowance({}, false)
};

const pageText = () => document.body.textContent ?? '';
const dollarsIn = (text: string) => (text.match(new RegExp(DOLLAR.source, 'g')) ?? []).length;
/** Every title and aria-label on the page (hover text and screen-reader names). */
const attributeText = () =>
  Array.from(document.querySelectorAll('[title], [aria-label]'))
    .map((el) => `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`)
    .join('\n');
/** Open each help tooltip (focus its trigger, as a keyboard user does), read its bubble, close it. */
const tooltipText = () => {
  const out: string[] = [];
  for (const trigger of Array.from(document.querySelectorAll<HTMLElement>('span[tabindex="0"]'))) {
    fireEvent.focus(trigger);
    out.push(...Array.from(document.querySelectorAll('[role="tooltip"]')).map((bubble) => bubble.textContent ?? ''));
    fireEvent.blur(trigger);
  }
  return out.join('\n');
};
/** What a viewer can read at this step: the text, the hover and screen-reader names, and the tooltips. */
const snapshot = () => [pageText(), attributeText(), tooltipText()].join('\n');

const renderPage = async () => {
  render(<ModelLibrary onBack={() => undefined} />);
  await screen.findByText('Anthropic: Claude Sonnet 4.5', {}, { timeout: 4000 });
  // Let the allowance read (mocked, immediate) settle so no skeleton is left.
  await act(async () => { await Promise.resolve(); });
};

const view = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));

const openDetail = async (name: string) => {
  fireEvent.click(screen.getAllByRole('button', { name })[0]);
  return screen.findByRole('dialog', { name });
};

/** Walk every view and modal, collecting what a viewer can read at each step. */
const walkPage = async (): Promise<Record<string, string>> => {
  const seen: Record<string, string> = {};
  seen.catalog = snapshot();

  fireEvent.click(screen.getByRole('button', { name: /Image model ranking/ }));
  seen['image ranking (open)'] = snapshot();

  let detail = await openDetail('Anthropic: Claude Sonnet 4.5');
  seen['detail modal'] = snapshot();
  fireEvent.click(within(detail).getByRole('button', { name: 'Close' }));

  detail = await openDetail(TOKEN_BILLED_IMAGE_MODEL.name);
  seen['detail modal (token-billed image)'] = snapshot();
  fireEvent.click(within(detail).getByRole('button', { name: 'Close' }));

  for (const name of ['OpenAI: GPT Image 1', 'OpenAI: GPT-4o', 'Llama 3.1 405B Instruct', TOKEN_BILLED_IMAGE_MODEL.name]) {
    const card = screen.getAllByRole('button', { name })[0].closest('div.cursor-pointer') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /Compare/ }));
  }
  fireEvent.click(screen.getByRole('button', { name: /^Compare 4$/ }));
  await screen.findByRole('dialog', { name: /Comparing 4 models/ });
  seen['compare modal'] = snapshot();
  fireEvent.click(screen.getByRole('button', { name: 'Close comparison' }));

  view(/Providers table/);
  seen['providers table'] = snapshot();
  view(/Leaderboards/);
  await waitFor(() => expect(screen.getAllByText(/leaderboard/i).length).toBeGreaterThan(0));
  seen.leaderboards = snapshot();
  view(/^Benchmarks$/);
  seen.benchmarks = snapshot();
  return seen;
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  state.user = null;
  state.allowance = null;
});

describe('Model Library: no dollar figure for viewers who do not pay in dollars', () => {
  it.each(Object.keys(CONTEXTS))('%s: no /\\$\\s?\\d/ anywhere on the page', async (name) => {
    state.user = { id: `user-${name}`, email: 'reader@dreamstream.test' };
    state.allowance = CONTEXTS[name];
    await renderPage();
    const seen = await walkPage();
    for (const [where, text] of Object.entries(seen)) {
      expect(text.match(DOLLAR)?.[0] ?? null, `${name}: dollar figure in ${where}`).toBeNull();
    }
    // The cost is still there, in usage words.
    expect(seen.catalog).toMatch(/Lower usage|Moderate usage|Higher usage/);
    expect(seen['providers table']).toContain('Usage');
    // The model's own words stay, minus the figures: "$0" reads "free", a priced sentence is left out.
    expect(seen['detail modal (token-billed image)']).toContain('Labelled "free per image" but actually billed per token');
    expect(seen['compare modal']).toContain('Labelled "free per image" but actually billed per token');
    expect(seen['detail modal']).toContain('Strong at coding and long documents.');
    expect(seen['detail modal']).not.toContain('priced at');
    // The help tooltips were really opened (the cost-class one, in its dollar-free words).
    expect(seen['detail modal (token-billed image)']).toContain('Labelled free per image, but still charged per token');
  }, WALK_MS);
});

describe('Model Library: who does see dollars', () => {
  it('signed out: list prices in dollars, labelled as list prices', async () => {
    await renderPage();
    const seen = await walkPage();
    expect(dollarsIn(seen.catalog)).toBeGreaterThan(0);
    expect(seen.catalog).toMatch(/List price\./);
    expect(seen['detail modal']).toContain('$3.00/M');
    // In dollars the model's own words are shown as written.
    expect(seen['detail modal']).toContain(PRICED_DESCRIPTION);
    expect(seen['detail modal (token-billed image)']).toContain('Labelled "$0 per image"');
    // Every short figure says what it is.
    expect(seen.catalog).toMatch(/\/M out · list price/);
    expect(seen['compare modal']).toContain('Pricing · list price');
    expect(seen['providers table']).toContain('List prices per 1M tokens');
    expect(seen.leaderboards).toContain('$/M out');
    expect(seen['image ranking (open)']).toMatch(/~\$0\.\d{3}\/img/);
  }, WALK_MS);

  it('admin (viewer admin, costView dollars): list prices in dollars', async () => {
    state.user = { id: 'admin-1', email: 'admin@dreamstream.test' };
    state.allowance = allowance({ viewer: 'admin', costView: 'dollars', payer: {} }, false);
    await renderPage();
    expect(dollarsIn(pageText())).toBeGreaterThan(0);
    view(/Providers table/);
    expect(screen.getByRole('button', { name: /Out \$\/M/ })).toBeInTheDocument();
  }, WALK_MS);

  it('own-key payer: dollars only on the provider the user pays with their key', async () => {
    state.user = { id: 'byok-1', email: 'byok@dreamstream.test' };
    state.allowance = allowance({ viewer: 'governed', costView: 'bands', payer: { openrouter: 'user', nvidia: 'platform' } });
    await renderPage();
    view(/Providers table/);
    const table = screen.getByRole('table');
    const rowOf = (name: string) => within(table).getByText(name).closest('tr') as HTMLElement;
    expect(rowOf('Anthropic: Claude Sonnet 4.5').textContent).toContain('$15.00/M out · your key');
    expect(rowOf('Llama 3.1 405B Instruct').textContent).not.toMatch(DOLLAR);
    expect(rowOf('Llama 3.1 405B Instruct').textContent).toMatch(/usage/);
  }, WALK_MS);

  it('allowance still loading: cost cells are skeletons, the table still renders, and no dollars leak', async () => {
    state.user = { id: 'slow-1', email: 'slow@dreamstream.test' };
    const allowanceStore = await import('../services/usageAllowance');
    vi.mocked(allowanceStore.refreshAllowanceStatus).mockImplementationOnce(() => new Promise(() => undefined));
    render(<ModelLibrary onBack={() => undefined} />);
    await screen.findByText('Anthropic: Claude Sonnet 4.5', {}, { timeout: 4000 });
    expect(document.querySelectorAll('[data-cost-loading]').length).toBeGreaterThan(0);
    expect(pageText()).not.toMatch(DOLLAR);
  }, WALK_MS);
});
