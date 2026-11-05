// The Model Library cost rule (components/models/costView.ts): the render matrix across every viewer,
// the usage bands, the tolerant allowance reader and its parity with DreamStream's contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel } from '../../services/modelCatalog';
import { catalogModel } from './__fixtures__/catalog';
import { normalizeAllowanceStatus, type AllowanceStatus } from '../../services/usageAllowance';
import { TEXT_PROVIDER_IDS } from '../../shared/providers';
import {
  ALLOWANCE_WAIT_MS,
  COST_VIEWERS,
  COST_VIEW_MODES,
  PAYERS,
  PAYER_PROVIDERS,
  allRowsInDollars,
  buildBandIndex,
  costAudience,
  costSafeText,
  curatedCostText,
  dollarAxes,
  modelBandIndex,
  modelCostKey,
  modelCostText,
  perImageYardstick,
  readAllowanceCostFields,
  rowCostMode,
  type AllowanceCostFields,
  type CostAudience
} from './costView';

const DOLLAR = /\$\s?\d/;

const perM = (usd: number) => usd / 1_000_000;
const text = (id: string, outUsdPerM: number, source: CatalogModel['source'] = 'openrouter') =>
  catalogModel({ id, source, pricing: { promptPerToken: perM(outUsdPerM / 5), completionPerToken: perM(outUsdPerM), imagePerImage: 0, requestFlat: 0 } });
const image = (id: string, usd: number) =>
  catalogModel({ id, supportsImageOutput: true, outputModalities: ['image'], costClass: 'per_image_only', pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: usd, requestFlat: 0 } });

// A catalog with enough rows per group to band: 6 text models on two providers, 3 image models.
const CATALOG = [
  text('cheap-a', 0.2), text('cheap-b', 0.4), text('mid-a', 2), text('mid-b', 3), text('pricey-a', 15), text('pricey-b', 60, 'nvidia'),
  image('img-low', 0.01), image('img-mid', 0.04), image('img-high', 0.13),
  catalogModel({ id: 'free-one:free', isFree: true, costClass: 'free_verified', costBand: 'free' }),
  // OpenRouter's -1 marker (a router, or a price the provider does not publish).
  catalogModel({ id: 'openrouter/auto', pricing: { promptPerToken: -1, completionPerToken: -1, imagePerImage: 0, requestFlat: 0 } })
];
const BANDS = modelBandIndex(CATALOG);
const byId = (id: string) => CATALOG.find((m) => m.id === id)!;

/** An allowance as services/usageAllowance would hold it, plus the cost fields DreamStream is adding. */
const allowance = (fields: Partial<Record<keyof AllowanceCostFields, unknown>>, base: Record<string, unknown> = {}): AllowanceStatus => {
  const status = normalizeAllowanceStatus({
    pctUsed: 20,
    pctLeft: 80,
    governed: true,
    friendlyUnits: { label: 'about 150 standard comic pages left', standardPages: 150, draftPages: 210, pctPerStandardPage: 0.5 },
    ...base
  });
  if (!status) throw new Error('fixture allowance did not parse');
  return { ...status, ...fields } as AllowanceStatus;
};
const signedIn = (status: AllowanceStatus | null, timedOut = false) => costAudience({ signedIn: true, status, timedOut });

const CONTEXTS: Record<string, CostAudience> = {
  'signed out': costAudience({ signedIn: false, status: null, timedOut: false }),
  admin: signedIn(allowance({ viewer: 'admin', costView: 'dollars', payer: {} }, { governed: false })),
  'own-key payer (OpenRouter)': signedIn(allowance({ viewer: 'governed', costView: 'bands', payer: { openrouter: 'user', nvidia: 'platform' } })),
  'governed, share known': signedIn(allowance({ viewer: 'governed', costView: 'share', payer: { openrouter: 'platform' } })),
  'governed, bands': signedIn(allowance({ viewer: 'governed', costView: 'bands' })),
  exempt: signedIn(allowance({ viewer: 'exempt', costView: 'bands' }, { governed: false })),
  metering_off: signedIn(allowance({ viewer: 'metering_off', costView: 'bands' }, { governed: false })),
  'fields absent': signedIn(allowance({}, { governed: false })),
  'allowance unreadable after 3 s': signedIn(null, true)
};

const allText = (aud: CostAudience) =>
  CATALOG.map((m) => {
    const t = modelCostText(m, aud, BANDS);
    return `${t.short} | ${t.sentence} | ${t.note}`;
  }).join('\n');

describe('costView render matrix', () => {
  it('signed out: list prices in dollars, labelled "list price"', () => {
    const aud = CONTEXTS['signed out'];
    expect(rowCostMode(aud, 'openrouter')).toEqual({ mode: 'dollars', label: 'list price', tag: 'list price' });
    const t = modelCostText(byId('pricey-a'), aud, BANDS);
    expect(t).toMatchObject({ mode: 'dollars', short: '$15.00/M out', note: 'list price', noteShort: 'list price' });
    expect(t.sentence).toMatch(/\$15\.00 \/ 1M output tokens.*List price\.$/);
    expect(modelCostText(byId('img-mid'), aud, BANDS).short).toBe('$0.040/img');
    expect(allRowsInDollars(aud)).toBe(true);
  });

  it('admin (viewer admin, costView dollars): dollars, labelled "list price"', () => {
    const aud = CONTEXTS.admin;
    expect(modelCostText(byId('mid-a'), aud, BANDS)).toMatchObject({ mode: 'dollars', short: '$2.00/M out', note: 'list price' });
    expect(allRowsInDollars(aud)).toBe(true);
    expect(dollarAxes(byId('mid-a'), rowCostMode(aud, 'openrouter'))).toEqual({ input: '$0.40/M', output: '$2.00/M', image: '—', request: '—' });
  });

  it('own-key payer: dollars only on the provider the user pays, bands elsewhere', () => {
    const aud = CONTEXTS['own-key payer (OpenRouter)'];
    expect(modelCostText(byId('pricey-a'), aud, BANDS)).toMatchObject({ mode: 'dollars', short: '$15.00/M out', note: 'on your OpenRouter key', noteShort: 'your key' });
    const nvidia = modelCostText(byId('pricey-b'), aud, BANDS);
    expect(nvidia).toMatchObject({ mode: 'bands', short: 'Higher usage' });
    expect(`${nvidia.short} ${nvidia.sentence}`).not.toMatch(DOLLAR);
    expect(dollarAxes(byId('pricey-b'), rowCostMode(aud, 'nvidia'))).toBeNull();
    expect(allRowsInDollars(aud)).toBe(false);
  });

  it('governed with a known share: a share of usage where the model states a per-call unit, bands for token prices', () => {
    const aud = CONTEXTS['governed, share known'];
    expect(aud).toMatchObject({ kind: 'signed_in' });
    const img = modelCostText(byId('img-mid'), aud, BANDS);
    expect(img.mode).toBe('share');
    expect(img.short).toMatch(/^(≈[\d.]+%|<0\.1%) per image$/);
    expect(img.sentence).toMatch(/^Each image uses (≈[\d.]+%|<0\.1%) of your usage\.$/);
    // A text row needs a workload ("one chat reply") to become a share, which is not co-signed: it stays banded.
    expect(modelCostText(byId('mid-a'), aud, BANDS)).toMatchObject({ mode: 'bands' });
  });

  it.each(['governed, bands', 'exempt', 'metering_off', 'fields absent', 'allowance unreadable after 3 s', 'governed, share known'])(
    '%s: no dollar figure anywhere, bands in words',
    (name) => {
      const aud = CONTEXTS[name];
      expect(allText(aud)).not.toMatch(DOLLAR);
      expect(allRowsInDollars(aud)).toBe(false);
      for (const m of CATALOG) expect(dollarAxes(m, rowCostMode(aud, m.source))).toBeNull();
      expect(modelCostText(byId('cheap-a'), aud, BANDS).short).toBe('Lower usage');
      expect(modelCostText(byId('pricey-a'), aud, BANDS).short).toBe('Higher usage');
    }
  );

  it('exempt and metering-off viewers never get dollars, even if the server says costView dollars', () => {
    for (const viewer of ['exempt', 'metering_off', 'governed'] as const) {
      const aud = signedIn(allowance({ viewer, costView: 'dollars' }, { governed: viewer === 'governed' }));
      expect(allText(aud)).not.toMatch(DOLLAR);
    }
    // And an admin whose default view is not dollars follows that view.
    expect(rowCostMode(signedIn(allowance({ viewer: 'admin', costView: 'bands' })), 'openrouter')).toEqual({ mode: 'bands' });
  });

  it('while the allowance loads: a skeleton (no text), then bands after the wait', () => {
    const loading = signedIn(null, false);
    expect(loading).toEqual({ kind: 'loading' });
    expect(modelCostText(byId('mid-a'), loading, BANDS)).toMatchObject({ mode: 'loading', short: '', sentence: '' });
    expect(modelCostText(byId('mid-a'), signedIn(null, true), BANDS)).toMatchObject({ mode: 'bands', short: 'Moderate usage' });
    expect(ALLOWANCE_WAIT_MS).toBeLessThanOrEqual(3_000);
  });

  it('free and unpublished rows read the same for everyone; -1 is never shown as a price or banded', () => {
    for (const aud of Object.values(CONTEXTS)) {
      expect(modelCostText(byId('free-one:free'), aud, BANDS)).toMatchObject({ mode: 'fixed', short: 'Free' });
      const auto = modelCostText(byId('openrouter/auto'), aud, BANDS);
      expect(auto).toMatchObject({ mode: 'fixed', short: 'Price not published' });
      expect(auto.sentence).not.toMatch(/-\d|\$/);
    }
    expect(BANDS.has(modelCostKey(byId('openrouter/auto')))).toBe(false);
    expect(BANDS.has(modelCostKey(byId('free-one:free')))).toBe(false);
  });

  it('a row with no price on any axis (and not marked free) reads "Price not listed" for everyone: never free, never a band', () => {
    // A live direct-provider listing: all-zero pricing, costClass 'paid' (openaiCompatible.ts).
    const unlisted = catalogModel({ id: 'gpt-live-only', source: 'openai' });
    const own = signedIn(allowance({ viewer: 'governed', costView: 'bands', payer: { openai: 'user' } }));
    for (const aud of [...Object.values(CONTEXTS), own]) {
      const t = modelCostText(unlisted, aud, BANDS);
      expect(t).toEqual({ mode: 'fixed', short: 'Price not listed', sentence: 'The provider does not list a price for this model.', note: '', noteShort: '' });
    }
    expect(curatedCostText(perImageYardstick(undefined), CONTEXTS['signed out'], undefined, '—')).toMatchObject({ short: 'Price not listed' });
  });
});

describe('costSafeText (a model\'s own words)', () => {
  const DRAWBACK = 'Labelled "$0 per image" but actually billed per token — your provider key is charged on every call.';
  const DESCRIPTION = 'A balanced model. It is priced at $3.00 per million input tokens and $15 per million output tokens! Strong at code.';
  const bands = { mode: 'bands' } as const;

  it('in dollars: unchanged', () => {
    expect(costSafeText(DRAWBACK, { mode: 'dollars', label: 'list price', tag: 'list price' })).toBe(DRAWBACK);
    expect(costSafeText(DESCRIPTION, { mode: 'dollars', label: 'list price', tag: 'list price' })).toBe(DESCRIPTION);
  });

  it('otherwise "$0" reads "free" and a sentence with any other figure is left out', () => {
    expect(costSafeText(DRAWBACK, bands)).toBe('Labelled "free per image" but actually billed per token — your provider key is charged on every call.');
    expect(costSafeText(DESCRIPTION, bands)).toBe('A balanced model. Strong at code.');
    expect(costSafeText('Costs $0.00 to run. Fast.', { mode: 'loading' })).toBe('Costs free to run. Fast.');
    expect(costSafeText('Only $0.04 per image.', bands)).toBe('');
    expect(costSafeText('From $ 2/M. Great.', { mode: 'share', pctPerUsd: 1 })).toBe('Great.');
    for (const text of [DRAWBACK, DESCRIPTION, 'It is $0.', 'Up to US$5 per call; fine.']) {
      expect(costSafeText(text, bands)).not.toMatch(DOLLAR);
    }
    expect(costSafeText(undefined, bands)).toBe('');
  });
});

describe('usage bands', () => {
  it('splits a group into tertiles, text and image banded separately', () => {
    expect(['cheap-a', 'cheap-b', 'mid-a', 'mid-b', 'pricey-a', 'pricey-b'].map((id) => BANDS.get(modelCostKey(byId(id))))).toEqual([
      'lower', 'lower', 'moderate', 'moderate', 'higher', 'higher'
    ]);
    expect(['img-low', 'img-mid', 'img-high'].map((id) => BANDS.get(modelCostKey(byId(id))))).toEqual(['lower', 'moderate', 'higher']);
  });

  it('gives equal prices the same band and leaves a group under 3 unbanded', () => {
    const ties = modelBandIndex([text('a', 1), text('b', 1), text('c', 1), text('d', 9)]);
    expect(new Set(['a', 'b', 'c'].map((id) => ties.get(`openrouter:${id}`)))).toEqual(new Set(['lower']));
    expect(ties.get('openrouter:d')).toBe('higher');
    const tiny = modelBandIndex([image('x', 0.02), image('y', 0.05)]);
    expect(tiny.size).toBe(0);
    const t = modelCostText(image('x', 0.02), CONTEXTS.exempt, tiny);
    expect(t).toMatchObject({ mode: 'bands', short: 'Uses your usage' });
  });

  it('bands curated rows (no route) and shows them in dollars only signed out or to an admin', () => {
    const rows = [0.02, 0.04, 0.13, 0].map((usd, i) => ({ id: `r${i}`, usd }));
    const bands = buildBandIndex(rows, (r) => r.id, (r) => perImageYardstick(r.usd));
    expect(bands.get('r0')).toBe('lower');
    expect(curatedCostText(perImageYardstick(0.13), CONTEXTS['signed out'], bands.get('r2'), '~$0.130/img').short).toBe('~$0.130/img');
    expect(curatedCostText(perImageYardstick(0.13), CONTEXTS['own-key payer (OpenRouter)'], bands.get('r2'), '~$0.130/img').short).toBe('Higher usage');
    expect(curatedCostText(perImageYardstick(0), CONTEXTS.exempt, undefined, 'Free').short).toBe('Free');
    expect(curatedCostText(perImageYardstick(undefined), CONTEXTS.exempt, undefined, '—').short).toBe('Price not listed');
  });
});

describe('readAllowanceCostFields', () => {
  it('reads the three fields and drops anything malformed', () => {
    expect(readAllowanceCostFields({ viewer: 'admin', costView: 'dollars', payer: { openrouter: 'user', xai: 'none' } })).toEqual({
      viewer: 'admin',
      costView: 'dollars',
      payer: { openrouter: 'user', xai: 'none' }
    });
    expect(readAllowanceCostFields(null)).toEqual({});
    expect(readAllowanceCostFields('admin')).toEqual({});
    expect(readAllowanceCostFields({ viewer: 'ADMIN', costView: 'cents', payer: ['user'] })).toEqual({});
    expect(readAllowanceCostFields({ payer: { openrouter: 'USER', 'not-a-provider': 'user', nvidia: 1 } })).toEqual({ payer: {} });
    const inherited = Object.create({ openrouter: 'user' });
    expect(readAllowanceCostFields({ payer: inherited })).toEqual({ payer: {} });
  });

  it('mirrors the contract DreamStream sent (viewer, costView, payer over ProviderId)', () => {
    expect([...COST_VIEWERS]).toEqual(['admin', 'governed', 'exempt', 'metering_off']);
    expect([...COST_VIEW_MODES]).toEqual(['dollars', 'share', 'bands']);
    expect([...PAYERS]).toEqual(['user', 'platform', 'none']);
    // ProviderId in the contract = every text provider plus Pixazo (images).
    expect(new Set(PAYER_PROVIDERS)).toEqual(new Set([...TEXT_PROVIDER_IDS, 'pixazo']));
  });

  it('stays in step with shared/billing/payer.ts once DreamStream lands it', () => {
    const shared = import.meta.glob('../../shared/billing/payer.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const source = Object.values(shared)[0];
    if (!source) return; // not on this branch yet: the local mirror above is the contract
    for (const literal of [...COST_VIEWERS, ...COST_VIEW_MODES, ...PAYERS]) expect(source).toContain(`'${literal}'`);
    expect(source).toContain('AllowanceCostFields');
  });
});

describe('useCostAudience', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../../services/usageAllowance');
  });

  const load = async (store: { last: AllowanceStatus | null; refresh: () => Promise<AllowanceStatus | null> }) => {
    const refresh = vi.fn(store.refresh);
    vi.resetModules();
    vi.doMock('../../services/usageAllowance', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../services/usageAllowance')>()),
      getLastAllowanceStatus: () => store.last,
      refreshAllowanceStatus: refresh,
      subscribeAllowanceStatus: () => () => undefined
    }));
    const { renderHook, act } = await import('@testing-library/react');
    const mod = await import('./costView');
    return { mod, refresh, renderHook, act };
  };

  it('signed out: no allowance request', async () => {
    const { mod, refresh, renderHook } = await load({ last: null, refresh: async () => null });
    const { result } = renderHook(() => mod.useCostAudience(null));
    expect(result.current).toEqual({ kind: 'signed_out' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('signed in: loading, then the status; a silent allowance settles on bands after the wait', async () => {
    const status = allowance({ viewer: 'admin', costView: 'dollars' });
    const { mod, renderHook, act } = await load({ last: null, refresh: async () => status });
    const { result } = renderHook(() => mod.useCostAudience('user-1'));
    expect(result.current).toEqual({ kind: 'loading' });
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toMatchObject({ kind: 'signed_in', fields: { viewer: 'admin', costView: 'dollars' } });

    const slow = await load({ last: null, refresh: () => new Promise(() => undefined) });
    const hook = slow.renderHook(() => slow.mod.useCostAudience('user-2'));
    expect(hook.result.current).toEqual({ kind: 'loading' });
    await slow.act(async () => { vi.advanceTimersByTime(ALLOWANCE_WAIT_MS); });
    expect(hook.result.current).toEqual({ kind: 'signed_in', fields: {}, pctPerUsd: null });
  });

  it("never shows the store's cached status first (it may be another user's): every visit forces a fresh read", async () => {
    const cached = allowance({ viewer: 'admin', costView: 'dollars' });
    const { mod, refresh, renderHook } = await load({ last: cached, refresh: () => new Promise(() => undefined) });
    const { result } = renderHook(() => mod.useCostAudience('someone-else'));
    expect(result.current).toEqual({ kind: 'loading' });
    expect(refresh).toHaveBeenCalledWith(0);
  });

  it("A, then B (an admin) elsewhere, then A again: A never sees B's dollars", async () => {
    const governedA = allowance({ viewer: 'governed', costView: 'bands' });
    const adminB = allowance({ viewer: 'admin', costView: 'dollars' });
    const store = { last: null as AllowanceStatus | null, answer: governedA as AllowanceStatus, pending: false };
    const { mod, refresh, renderHook, act } = await load({
      get last() { return store.last; },
      refresh: () => (store.pending ? new Promise(() => undefined) : Promise.resolve(store.answer))
    });
    const first = renderHook(() => mod.useCostAudience('user-a'));
    await act(async () => { await Promise.resolve(); });
    expect(first.result.current).toMatchObject({ kind: 'signed_in', fields: { viewer: 'governed' } });
    first.unmount();

    // B (an admin) signed in on another surface: the shared store now holds B's status, and A is back.
    store.last = adminB;
    store.pending = true;
    const again = renderHook(() => mod.useCostAudience('user-a'));
    expect(again.result.current).toEqual({ kind: 'loading' });
    await act(async () => { vi.advanceTimersByTime(ALLOWANCE_WAIT_MS); });
    expect(again.result.current).toEqual({ kind: 'signed_in', fields: {}, pctPerUsd: null });
    expect(rowCostMode(again.result.current, 'openrouter')).toEqual({ mode: 'bands' });
    expect(refresh.mock.calls).toEqual([[0], [0]]);
  });
});

// The allowance cost fields through the REAL store: only apiClient.get('/api/usage/allowance') is mocked,
// with the payload DreamStream will serve. services/usageAllowance.normalizeAllowanceStatus is an allow-list
// that does not carry viewer, costView or payer yet (needs DS: add them as optional, validated fields), so
// today every signed-in viewer, admins and own-key payers included, gets bands. The two `it.fails` cases
// pin that dependency: they FAIL once DS lands it (drop `.fails` then), while the first case checks the
// path itself ran.
describe('useCostAudience over the real allowance store (DreamStream dependency)', () => {
  const PAYLOAD = {
    enabled: true,
    governed: false,
    pctUsed: 0,
    pctLeft: 100,
    exhausted: false,
    crossed: [],
    resetsAt: null,
    friendlyUnits: null,
    usePlatformAllowance: true,
    byokFallbackMode: 'ask',
    byokAvailable: true
  };

  afterEach(() => {
    vi.doUnmock('../../services/apiClient');
  });

  const audienceFor = async (payload: Record<string, unknown>) => {
    vi.resetModules();
    const get = vi.fn(async (path: string) => {
      if (path === '/api/usage/allowance') return payload;
      throw new Error(`unexpected read: ${path}`);
    });
    vi.doMock('../../services/apiClient', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../services/apiClient')>()),
      get
    }));
    const { renderHook, act } = await import('@testing-library/react');
    const mod = await import('./costView');
    const { result } = renderHook(() => mod.useCostAudience('user-1'));
    // Let the store's read settle (a few macrotasks, well inside ALLOWANCE_WAIT_MS).
    for (let i = 0; i < 20 && result.current.kind === 'loading'; i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    return { audience: result.current, get };
  };

  it('the read really goes through the store: one GET, a signed-in audience (not loading, not timed out)', async () => {
    const { audience, get } = await audienceFor({ ...PAYLOAD, governed: true, viewer: 'governed', costView: 'bands', payer: {} });
    expect(get.mock.calls).toEqual([['/api/usage/allowance', undefined]]);
    expect(audience).toMatchObject({ kind: 'signed_in' });
    expect(rowCostMode(audience, 'openrouter')).toEqual({ mode: 'bands' });
  });

  it.fails('NEEDS DS (usageAllowance keeps the cost fields): viewer admin + costView dollars sees list prices', async () => {
    const { audience } = await audienceFor({ ...PAYLOAD, viewer: 'admin', costView: 'dollars', payer: {} });
    expect(rowCostMode(audience, 'openrouter')).toMatchObject({ mode: 'dollars', label: 'list price' });
  });

  it.fails("NEEDS DS (usageAllowance keeps the cost fields): payer openrouter 'user' sees dollars on OpenRouter rows", async () => {
    const { audience } = await audienceFor({ ...PAYLOAD, governed: true, viewer: 'governed', costView: 'bands', payer: { openrouter: 'user' } });
    expect(rowCostMode(audience, 'openrouter')).toMatchObject({ mode: 'dollars', label: 'on your OpenRouter key' });
  });
});
