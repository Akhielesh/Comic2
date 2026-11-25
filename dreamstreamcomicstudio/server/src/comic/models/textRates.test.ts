// @vitest-environment node
// What planning, style directions and translation really cost (docs/features/pricing.md § Text rates): operations
// from tagged ledger rows, the own-then-everyone median, the constants as the floor and the fallback, outliers, and
// the in-memory cache that keeps a quote from ever being a hot database query. Synthetic rows only.
import { describe, expect, it, vi } from 'vitest';
import { PLAN_USD_PER_PAGE, STYLE_DIRECTIONS_USD } from '../../../../shared/comic/models.js';
import { FLOOR_TEXT_RATES, priceBookFromSources, planUsd, styleDirectionsQuoteUsd } from '../../../../shared/comic/priceBook.js';
import {
  FAILURE_BACKOFF_MS,
  MAX_OP_FACTOR,
  TEXT_RATES_TTL_MS,
  createTextRateSource,
  operationsFromCalls,
  parseTextOpTag,
  textOpCallFromDb,
  textOpTag,
  textRatesFrom,
  type TextOpCallRow,
  type TextOpKind
} from './textRates.js';

const T0 = Date.parse('2026-11-20T12:00:00Z');
let seq = 0;

/** One finished operation of `pages` pages by `user`, billed `factor` × its constant estimate, split over `calls` calls. */
const op = (o: { user?: string; kind?: TextOpKind; factor: number; units?: number; calls?: number; at?: number; reported?: boolean[] }): TextOpCallRow[] => {
  const kind = o.kind ?? 'plan';
  const units = o.units ?? 6;
  const base = kind === 'plan' ? PLAN_USD_PER_PAGE * units : kind === 'style_directions' ? STYLE_DIRECTIONS_USD : 0.01;
  const tag = { id: `op_${++seq}`, kind, units, baseUsd: base };
  const calls = o.calls ?? 2;
  return Array.from({ length: calls }, (_, i) => ({
    userId: o.user ?? 'user-a',
    providerCostUsd: (base * o.factor) / calls,
    reported: o.reported?.[i] ?? true,
    op: tag,
    createdAt: new Date((o.at ?? T0) + i * 1000).toISOString()
  }));
};

const ops = (factors: number[], extra: Partial<Parameters<typeof op>[0]> = {}) => factors.flatMap((factor, i) => op({ factor, at: T0 - i * 60_000, ...extra }));

describe('the tag', () => {
  it('a plan tag is priced at the constant per page; a translation brings its token estimate; nothing without a base', () => {
    expect(textOpTag('plan', 6)).toMatchObject({ kind: 'plan', units: 6, baseUsd: Math.round(PLAN_USD_PER_PAGE * 6 * 1e6) / 1e6 });
    expect(textOpTag('style_directions', 1)).toMatchObject({ units: 1, baseUsd: STYLE_DIRECTIONS_USD });
    expect(textOpTag('translate', 1, 0.0123)).toMatchObject({ units: 1, baseUsd: 0.0123 });
    expect(textOpTag('translate', 1)).toBeUndefined();
    expect(textOpTag('translate', 1, 0)).toBeUndefined();
    expect(textOpTag('plan', 0)?.units).toBe(1);
  });

  it('reads back defensively from the ledger metadata', () => {
    expect(parseTextOpTag({ id: 'op_1', kind: 'plan', units: 3, baseUsd: 0.036 })).toEqual({ id: 'op_1', kind: 'plan', units: 3, baseUsd: 0.036 });
    for (const bad of [null, 'x', { id: '', kind: 'plan', units: 1, baseUsd: 1 }, { id: 'a', kind: 'chat', units: 1, baseUsd: 1 }, { id: 'a', kind: 'plan', units: 0, baseUsd: 1 }, { id: 'a', kind: 'plan', units: 1, baseUsd: -1 }])
      expect(parseTextOpTag(bad)).toBeUndefined();
    const row = textOpCallFromDb({ user_id: 'u', provider_cost_usd: '0.0102', created_at: '2026-11-20T00:00:00Z', metadata: { stage: 'plan', providerCostReported: true, textOp: { id: 'op_9', kind: 'plan', units: 2, baseUsd: 0.024 } } });
    expect(row).toMatchObject({ userId: 'u', providerCostUsd: 0.0102, reported: true, op: { id: 'op_9', units: 2 } });
    expect(textOpCallFromDb({ user_id: 'u', provider_cost_usd: 1, created_at: '2026-11-20T00:00:00Z', metadata: { stage: 'plan' } })).toBeNull();
  });
});

describe('operations from calls', () => {
  it('sums every call of an operation against its estimate', () => {
    const [o] = operationsFromCalls(op({ factor: 1.5, calls: 3 }));
    expect(o.factor).toBeCloseTo(1.5, 6);
    expect(o.kind).toBe('plan');
  });

  it('leaves out an operation with a call whose cost the provider did not report (our own guess for a cancelled call included)', () => {
    expect(operationsFromCalls(op({ factor: 2, calls: 2, reported: [true, false] }))).toEqual([]);
  });

  it('leaves out an operation billed under half its estimate (stopped or cut short) and clips a runaway one', () => {
    expect(operationsFromCalls(op({ factor: 0.3 }))).toEqual([]);
    expect(operationsFromCalls(op({ factor: 80 }))[0].factor).toBe(MAX_OP_FACTOR);
  });
});

describe('rates (own first, then everyone, never under the constants)', () => {
  it('too few observations: the constants', () => {
    const rates = textRatesFrom(operationsFromCalls(ops([1.6, 1.7, 1.8, 1.9])), 'user-a');
    expect(rates.planPerPageUsd).toBe(PLAN_USD_PER_PAGE);
    expect(rates.basis?.plan).toEqual({ source: 'floor' });
    expect(textRatesFrom([], 'user-a')).toMatchObject({ planPerPageUsd: PLAN_USD_PER_PAGE, styleDirectionsUsd: STYLE_DIRECTIONS_USD, translateFactor: 1 });
  });

  it('enough of the person’s own: the median of their newest twenty', () => {
    const rates = textRatesFrom(operationsFromCalls(ops([1.2, 1.4, 1.5, 1.6, 1.9])), 'user-a');
    expect(rates.planPerPageUsd).toBeCloseTo(PLAN_USD_PER_PAGE * 1.5, 4);
    expect(rates.basis?.plan).toEqual({ source: 'observed', n: 5, scope: 'you' });
    // Many: only the newest twenty count (the older, dearer ones have aged out).
    const many = operationsFromCalls([...ops(Array(20).fill(1.25)), ...ops(Array(30).fill(3), { at: T0 - 86_400_000 })]);
    expect(textRatesFrom(many, 'user-a').planPerPageUsd).toBeCloseTo(PLAN_USD_PER_PAGE * 1.25, 4);
  });

  it('outliers do not move the median: two runaway plans among eight ordinary ones', () => {
    const rates = textRatesFrom(operationsFromCalls(ops([1.3, 1.3, 1.3, 1.3, 1.3, 1.3, 9, 40, 1.3, 1.3])), 'user-a');
    expect(rates.planPerPageUsd).toBeCloseTo(PLAN_USD_PER_PAGE * 1.3, 4);
  });

  it('cheaper than the constant: the constant (an observation only ever raises a quote)', () => {
    const rates = textRatesFrom(operationsFromCalls(ops([0.6, 0.7, 0.7, 0.8, 0.9])), 'user-a');
    expect(rates.planPerPageUsd).toBe(PLAN_USD_PER_PAGE);
    expect(rates.basis?.plan).toEqual({ source: 'floor', n: 5, scope: 'you' });
  });

  it('a newcomer reads everyone’s median, but only from five or more people', () => {
    const fromFour = operationsFromCalls(['a', 'b', 'c', 'd', 'a', 'b'].flatMap((user, i) => op({ user, factor: 2, at: T0 - i * 1000 })));
    expect(textRatesFrom(fromFour, 'newcomer').planPerPageUsd).toBe(PLAN_USD_PER_PAGE);
    const fromFive = operationsFromCalls(['a', 'b', 'c', 'd', 'e'].flatMap((user, i) => op({ user, factor: 2, at: T0 - i * 1000 })));
    const rates = textRatesFrom(fromFive, 'newcomer');
    expect(rates.planPerPageUsd).toBeCloseTo(PLAN_USD_PER_PAGE * 2, 4);
    expect(rates.basis?.plan).toEqual({ source: 'observed', n: 5, scope: 'platform' });
  });

  it('each kind keeps its own rate: style directions and translation', () => {
    const rows = [...ops([1.4, 1.4, 1.4, 1.4, 1.4], { kind: 'style_directions', units: 1 }), ...ops([1.1, 1.2, 1.2, 1.3, 1.2], { kind: 'translate', units: 1 })];
    const rates = textRatesFrom(operationsFromCalls(rows), 'user-a');
    expect(rates.planPerPageUsd).toBe(PLAN_USD_PER_PAGE);
    expect(rates.styleDirectionsUsd).toBeCloseTo(STYLE_DIRECTIONS_USD * 1.4, 4);
    expect(rates.translateFactor).toBeCloseTo(1.2, 3);
  });

  it('the book quotes with them: planning and style directions, markup unless own key', () => {
    const rates = textRatesFrom(operationsFromCalls([...ops([1.5, 1.5, 1.5, 1.5, 1.5]), ...ops([2, 2, 2, 2, 2], { kind: 'style_directions', units: 1 })]), 'user-a');
    const book = priceBookFromSources({ rows: [], text: rates });
    expect(planUsd(6, true, book)).toBeCloseTo(6 * PLAN_USD_PER_PAGE * 1.5, 4);
    expect(planUsd(6, false, book)).toBeCloseTo(6 * PLAN_USD_PER_PAGE * 1.5 * 1.3, 4);
    expect(styleDirectionsQuoteUsd(true, book)).toBeCloseTo(STYLE_DIRECTIONS_USD * 2, 4);
    // No book, or a book without rates: the constants, exactly as before.
    expect(planUsd(6, false)).toBe(Math.round(PLAN_USD_PER_PAGE * 6 * 1.3 * 10000) / 10000);
    expect(planUsd(6, false, priceBookFromSources({ rows: [] }))).toBe(planUsd(6, false));
  });
});

describe('the in-memory cache', () => {
  const rows = ops([1.5, 1.5, 1.5, 1.5, 1.5]);

  it('one read serves every quote until the TTL; then one read again', async () => {
    let now = T0;
    const db = { recentTaggedCalls: vi.fn(async () => rows) };
    const source = createTextRateSource({ db, now: () => now });
    const [a, b] = await Promise.all([source.forUser('user-a'), source.forUser('user-a')]);
    expect(a.planPerPageUsd).toBeCloseTo(PLAN_USD_PER_PAGE * 1.5, 4);
    expect(b).toEqual(a);
    await source.forUser('user-b');
    expect(db.recentTaggedCalls).toHaveBeenCalledTimes(1);
    now += TEXT_RATES_TTL_MS - 1;
    await source.forUser('user-a');
    expect(db.recentTaggedCalls).toHaveBeenCalledTimes(1);
    now += 2;
    await source.forUser('user-a');
    expect(db.recentTaggedCalls).toHaveBeenCalledTimes(2);
  });

  it('a failed read keeps the last batch (else the constants) and waits before trying again', async () => {
    let now = T0;
    let fail = false;
    const db = { recentTaggedCalls: vi.fn(async () => (fail ? Promise.reject(new Error('db down')) : rows)) };
    const source = createTextRateSource({ db, now: () => now });
    const good = await source.forUser('user-a');
    fail = true;
    now += TEXT_RATES_TTL_MS + 1;
    expect(await source.forUser('user-a')).toEqual(good);
    now += FAILURE_BACKOFF_MS - 1;
    await source.forUser('user-a');
    expect(db.recentTaggedCalls).toHaveBeenCalledTimes(2);
    const cold = createTextRateSource({ db: { recentTaggedCalls: async () => Promise.reject(new Error('down')) }, now: () => now });
    expect(await cold.forUser('user-a')).toEqual(FLOOR_TEXT_RATES);
    expect(await createTextRateSource({ db: null }).forUser('user-a')).toEqual(FLOOR_TEXT_RATES);
  });

  it('a slow read never holds a quote longer than its wait', async () => {
    let release: (v: TextOpCallRow[]) => void = () => {};
    const db = { recentTaggedCalls: () => new Promise<TextOpCallRow[]>((resolve) => (release = resolve)) };
    const source = createTextRateSource({ db });
    expect(await source.forUser('user-a', { maxWaitMs: 5 })).toEqual(FLOOR_TEXT_RATES);
    release(rows);
    await new Promise((r) => setTimeout(r, 0));
    expect((await source.forUser('user-a', { maxWaitMs: 5 })).planPerPageUsd).toBeCloseTo(PLAN_USD_PER_PAGE * 1.5, 4);
  });
});
