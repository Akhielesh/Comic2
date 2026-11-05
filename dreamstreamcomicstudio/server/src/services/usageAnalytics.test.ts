// @vitest-environment node
// S4 (finding 8): the popularity aggregate behind GET /api/models/popularity, over a stubbed
// Supabase query builder that applies the filters it is given (eq/gte/order/range), so both the
// request and the result are checked.
//   - SETTLED rows only (RESERVED holds, RELEASED and BYOK_SETTLED rows never count);
//   - a row with fewer than POPULARITY_MIN_USERS (20) distinct users is never returned, and the
//     floor runs before the top-15 cut;
//   - shares are over the rows that clear the floor, so the output is identical with or without the
//     suppressed rows (nothing lets them be inferred); no user ids, no totals;
//   - generatedAt is the build time of the cached aggregate.
// The admin per-user usage view shares the paging helper and must keep reading every state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EventRow = { model: string; provider: string; user_id: string | null; status: string; created_at: string };
type Query = { table: string; columns: string; filters: [string, string, unknown][]; ranges: [number, number][] };

const db = vi.hoisted(() => ({
  table: [] as EventRow[],
  queries: [] as Query[],
  failNext: null as string | null
}));

vi.mock('./supabase.js', () => {
  const builder = (table: string) => {
    const q: Query = { table, columns: '', filters: [], ranges: [] };
    db.queries.push(q);
    let range: [number, number] = [0, Number.MAX_SAFE_INTEGER];
    const api = {
      select(columns: string) {
        q.columns = columns;
        return api;
      },
      order() {
        return api;
      },
      range(from: number, to: number) {
        range = [from, to];
        q.ranges.push(range);
        return api;
      },
      gte(column: string, value: string) {
        q.filters.push(['gte', column, value]);
        return api;
      },
      eq(column: string, value: unknown) {
        q.filters.push(['eq', column, value]);
        return api;
      },
      then(resolve: (value: { data: unknown[] | null; error: { message: string } | null }) => unknown, reject?: (err: unknown) => unknown) {
        if (db.failNext) {
          const message = db.failNext;
          db.failNext = null;
          return Promise.resolve({ data: null, error: { message } }).then(resolve, reject);
        }
        const rows = db.table
          .filter((row) =>
            q.filters.every(([op, column, value]) => {
              const cell = (row as Record<string, unknown>)[column];
              return op === 'eq' ? cell === value : String(cell) >= String(value);
            })
          )
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .slice(range[0], range[1] + 1)
          .map((row) => Object.fromEntries(q.columns.split(',').map((c) => [c.trim(), (row as Record<string, unknown>)[c.trim()]])));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      }
    };
    return api;
  };
  return {
    getSupabaseAdmin: () => ({ from: (table: string) => builder(table) }),
    getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true })
  };
});

// A fresh module per test, so the 1 h in-process cache never leaks between cases.
const load = async () => {
  vi.resetModules();
  return import('./usageAnalytics.js');
};

let clock = Date.parse('2026-11-05T09:00:00.000Z');
const event = (model: string, userId: string | null, status = 'SETTLED', provider = 'openrouter'): EventRow => {
  clock -= 1000;
  return { model, provider, user_id: userId, status, created_at: new Date(clock).toISOString() };
};
/** `requestsEach` events for each of `users` distinct users. */
const usage = (model: string, users: number, requestsEach = 1, status = 'SETTLED', provider = 'openrouter'): EventRow[] =>
  Array.from({ length: users }, (_, u) =>
    Array.from({ length: requestsEach }, () => event(model, `${model}-user-${u}`, status, provider))
  ).flat();

beforeEach(() => {
  clock = Date.parse('2026-11-05T09:00:00.000Z');
  db.table = [];
  db.queries = [];
  db.failNext = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('getModelPopularity (GET /api/models/popularity)', () => {
  it('named constants: k = 20 distinct users, SETTLED only', async () => {
    const { POPULARITY_MIN_USERS, POPULARITY_STATUS } = await load();
    expect(POPULARITY_MIN_USERS).toBe(20);
    expect(POPULARITY_STATUS).toBe('SETTLED');
  });

  it('asks Supabase for SETTLED rows only, never cost columns', async () => {
    const { getModelPopularity } = await load();
    await getModelPopularity('week');
    expect(db.queries).toHaveLength(1);
    const [q] = db.queries;
    expect(q.table).toBe('generation_cost_events');
    expect(q.filters).toContainEqual(['eq', 'status', 'SETTLED']);
    expect(q.columns).not.toMatch(/usd|cost|_ct|byok/i);
  });

  it('RESERVED, RELEASED and BYOK_SETTLED rows never count, in a model\'s requests or its users', async () => {
    db.table = [
      ...usage('vendor/settled', 20, 2),
      ...usage('vendor/settled', 10, 5, 'RESERVED'), // in-flight holds on the same model
      ...usage('vendor/only-held', 30, 1, 'RESERVED'),
      ...usage('vendor/only-released', 30, 1, 'RELEASED'),
      ...usage('vendor/only-byok', 30, 1, 'BYOK_SETTLED')
    ];
    const { getModelPopularity } = await load();
    const { models } = await getModelPopularity('week');
    expect(models).toEqual([{ model: 'vendor/settled', provider: 'openrouter', requests: 40, users: 20, sharePct: 100 }]);
  });

  it('suppresses any row under 20 distinct users, however many requests it has', async () => {
    db.table = [
      ...usage('vendor/twenty', 20, 1),
      ...usage('vendor/nineteen', 19, 30), // 570 requests, 19 people
      ...usage('vendor/one-heavy-user', 1, 1000),
      ...Array.from({ length: 40 }, () => event('vendor/anonymous-rows', null)) // no user id: 0 users
    ];
    const { getModelPopularity } = await load();
    const { models } = await getModelPopularity('week');
    expect(models.map((m) => m.model)).toEqual(['vendor/twenty']);
    expect(models[0].users).toBe(20);
  });

  it('applies the floor BEFORE the top-15 cut: qualifying rows are not lost behind suppressed ones', async () => {
    db.table = [
      ...Array.from({ length: 16 }, (_, i) => usage(`vendor/heavy-${i}`, 3, 50)).flat(), // 150 requests each, 3 users
      ...usage('vendor/broad-a', 25, 2), // 50 requests
      ...usage('vendor/broad-b', 21, 1) // 21 requests
    ];
    const { getModelPopularity } = await load();
    const { models } = await getModelPopularity('week');
    expect(models.map((m) => [m.model, m.requests, m.users])).toEqual([
      ['vendor/broad-a', 50, 25],
      ['vendor/broad-b', 21, 21]
    ]);
  });

  it('shares are over the qualifying rows only: the output is identical with or without suppressed rows', async () => {
    const qualifying = [...usage('vendor/a', 30, 3), ...usage('vendor/b', 20, 3), ...usage('vendor/c', 24, 1, 'SETTLED', 'nvidia')];
    db.table = qualifying;
    const without = (await (await load()).getModelPopularity('month')).models;

    db.table = [
      ...qualifying,
      ...usage('vendor/secret-1', 1, 400),
      ...usage('vendor/secret-2', 19, 7),
      ...Array.from({ length: 30 }, (_, i) => usage(`vendor/tail-${i}`, 2, 1)).flat()
    ];
    const withSuppressed = (await (await load()).getModelPopularity('month')).models;

    expect(withSuppressed).toEqual(without);
    expect(without.map((m) => [m.model, m.provider, m.requests, m.users, m.sharePct])).toEqual([
      ['vendor/a', 'openrouter', 90, 30, 51.7],
      ['vendor/b', 'openrouter', 60, 20, 34.5],
      ['vendor/c', 'nvidia', 24, 24, 13.8]
    ]);
    // requests ÷ share gives back the qualifying total (174), never the window's total (767).
    for (const m of withSuppressed) expect(Math.abs(m.requests / (m.sharePct / 100) - 174)).toBeLessThan(1);
  });

  it('returns at most 15 rows; each row is only model, provider, requests, users, sharePct (no ids, no totals)', async () => {
    db.table = Array.from({ length: 17 }, (_, i) => usage(`vendor/m-${String(i).padStart(2, '0')}`, 20, 17 - i)).flat();
    const { getModelPopularity } = await load();
    const result = await getModelPopularity('all');
    expect(Object.keys(result).sort()).toEqual(['generatedAt', 'models']);
    expect(result.models).toHaveLength(15);
    expect(result.models[0].model).toBe('vendor/m-00');
    for (const row of result.models) expect(Object.keys(row).sort()).toEqual(['model', 'provider', 'requests', 'sharePct', 'users']);
    expect(JSON.stringify(result)).not.toMatch(/-user-\d/);
    // 'all' reads no date bound; the SETTLED filter is still there.
    expect(db.queries[0].filters).toEqual([['eq', 'status', 'SETTLED']]);
  });

  it('generatedAt is the ISO build time of the cached aggregate; rebuilt after the 1 h cache', async () => {
    db.table = usage('vendor/a', 20, 1);
    const { getModelPopularity } = await load();
    const first = await getModelPopularity('week');
    expect(first.generatedAt).toBe('2026-11-05T10:00:00.000Z');

    vi.setSystemTime(new Date('2026-11-05T10:40:00.000Z'));
    const cached = await getModelPopularity('week');
    expect(cached.generatedAt).toBe('2026-11-05T10:00:00.000Z');
    expect(db.queries).toHaveLength(1);

    // Another window is its own aggregate with its own time.
    expect((await getModelPopularity('month')).generatedAt).toBe('2026-11-05T10:40:00.000Z');

    vi.setSystemTime(new Date('2026-11-05T11:00:01.000Z'));
    const rebuilt = await getModelPopularity('week');
    expect(rebuilt.generatedAt).toBe('2026-11-05T11:00:01.000Z');
    expect(new Date(rebuilt.generatedAt).toISOString()).toBe(rebuilt.generatedAt);
  });

  it('the week window reads only the last 7 days', async () => {
    db.table = [...usage('vendor/recent', 20, 1)];
    db.table.push(...Array.from({ length: 20 }, (_, u) => ({ ...event('vendor/old', `old-${u}`), created_at: '2026-10-01T00:00:00.000Z' })));
    const { getModelPopularity } = await load();
    const { models } = await getModelPopularity('week');
    expect(models.map((m) => m.model)).toEqual(['vendor/recent']);
    expect(db.queries[0].filters).toContainEqual(['gte', 'created_at', '2026-10-29T10:00:00.000Z']);
  });

  it('a failed read throws and is not cached', async () => {
    db.table = usage('vendor/a', 20, 1);
    const { getModelPopularity } = await load();
    db.failNext = 'connection reset';
    await expect(getModelPopularity('week')).rejects.toThrow('connection reset');
    expect((await getModelPopularity('week')).models).toHaveLength(1);
  });
});

describe('getMonthlyEligibleModels (GET /api/models/usage-monthly k-floor)', () => {
  const at = (row: EventRow, iso: string): EventRow => ({ ...row, created_at: iso });
  /** `users` distinct users each running `model` once in `month` ('YYYY-MM'), SETTLED unless stated. */
  const monthUsage = (month: string, model: string, users: number, status = 'SETTLED', provider = 'openrouter'): EventRow[] =>
    Array.from({ length: users }, (_, u) => at(event(model, `${month}-${model}-user-${u}`, status, provider), `${month}-15T12:00:00.000Z`));

  it('keys each (month, provider, model) that 20+ distinct users ran that month, over SETTLED rows only', async () => {
    db.table = [
      ...monthUsage('2026-10', 'vendor/broad', 20),
      ...monthUsage('2026-11', 'vendor/broad', 19), // the same model, one short in November
      ...monthUsage('2026-11', 'vendor/broad', 20, 'SETTLED', 'nvidia'), // another provider is its own cell
      ...monthUsage('2026-11', 'vendor/held', 40, 'RESERVED'),
      ...monthUsage('2026-11', 'vendor/byok', 40, 'BYOK_SETTLED'),
      ...Array.from({ length: 300 }, () => at(event('vendor/one-person', 'solo'), '2026-11-02T00:00:00.000Z'))
    ];
    const { getMonthlyEligibleModels, monthlyModelKey } = await load();
    const eligible = await getMonthlyEligibleModels('2026-10');
    expect([...eligible].sort()).toEqual(
      [monthlyModelKey('2026-10', 'openrouter', 'vendor/broad'), monthlyModelKey('2026-11', 'nvidia', 'vendor/broad')].sort()
    );
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].filters).toEqual(expect.arrayContaining([['eq', 'status', 'SETTLED'], ['gte', 'created_at', '2026-10-01T00:00:00.000Z']]));
    expect(db.queries[0].columns).not.toMatch(/usd|cost|_ct|byok/i);
  });

  it('returns keys only (no user ids, no counts), and caches per span start', async () => {
    db.table = monthUsage('2026-11', 'vendor/broad', 25);
    const { getMonthlyEligibleModels } = await load();
    const eligible = await getMonthlyEligibleModels('2026-11');
    expect(JSON.stringify([...eligible])).not.toMatch(/user/);
    await getMonthlyEligibleModels('2026-11');
    expect(db.queries).toHaveLength(1);
    await getMonthlyEligibleModels('2026-10');
    expect(db.queries).toHaveLength(2);
  });

  it('a malformed month reads nothing and qualifies nothing', async () => {
    db.table = monthUsage('2026-11', 'vendor/broad', 25);
    const { getMonthlyEligibleModels } = await load();
    for (const bad of ['', '2026-13', '2026-1', "2026-11' or 1=1", '2026-11-01']) {
      expect((await getMonthlyEligibleModels(bad)).size, bad).toBe(0);
    }
    expect(db.queries).toHaveLength(0);
  });

  it('a failed read throws (the route answers 500) and is not cached', async () => {
    db.table = monthUsage('2026-11', 'vendor/broad', 25);
    const { getMonthlyEligibleModels } = await load();
    db.failNext = 'connection reset';
    await expect(getMonthlyEligibleModels('2026-11')).rejects.toThrow('connection reset');
    expect((await getMonthlyEligibleModels('2026-11')).size).toBe(1);
  });
});

describe('getAdminUserUsage (shares the paging helper)', () => {
  it('still reads every state: no status filter', async () => {
    db.table = [event('vendor/a', 'u1', 'SETTLED'), event('vendor/a', 'u1', 'RESERVED')];
    const { getAdminUserUsage } = await load();
    const rows = await getAdminUserUsage(10);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].filters.filter(([, column]) => column === 'status')).toEqual([]);
    expect(rows).toEqual([expect.objectContaining({ userId: 'u1', platformRequests: 2 })]);
  });
});
