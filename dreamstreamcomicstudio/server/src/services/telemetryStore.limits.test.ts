// @vitest-environment node
// abuse-ops-3: what a sender can make the free-plan database keep. Severity filter, message /
// metadata caps, the per-/64, per-account and per-day budgets, the server's own budget for 5xx
// records, and the 150 MB size gate (with the bytes stored between two size reads).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  inserts: [] as { table: string; rows: unknown }[],
  rpc: vi.fn(async (_fn: string) => ({ data: 1024 as unknown, error: null as null | { code?: string; message: string } }))
}));
vi.mock('./supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true }),
  getSupabaseAdmin: () => ({
    rpc: db.rpc,
    from: (table: string) => ({
      insert: async (rows: unknown) => {
        db.inserts.push({ table, rows });
        return { error: null };
      }
    })
  })
}));
vi.mock('../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { logger } from '../lib/logger.js';
import {
  ACCOUNT_EVENT_ROWS_PER_DAY,
  ACCOUNT_FEEDBACK_ROWS_PER_DAY,
  ANON_METADATA_MAX_BYTES,
  ANON_ROWS_PER_CLIENT_PER_DAY,
  ANON_ROWS_PER_DAY,
  FEEDBACK_STORAGE_LIMIT_BYTES,
  SERVER_ROWS_PER_SENDER_PER_DAY,
  TELEMETRY_STORAGE_LIMIT_BYTES,
  recordFeedback,
  recordServerError,
  recordTelemetryEvents,
  resetTelemetryLimits
} from './telemetryStore.js';

type Row = { severity: string; message: string | null; metadata: Record<string, unknown>; user_id: string | null };
const storedEvents = (): Row[] => db.inserts.filter((i) => i.table === 'telemetry_events').flatMap((i) => i.rows as Row[]);
const storedFeedback = () => db.inserts.filter((i) => i.table === 'user_feedback');
const anon = (ip: string) => ({ userId: null, ip });
const errors = (n: number) => Array.from({ length: n }, (_, i) => ({ eventType: 'window_error', severity: 'error' as const, message: `boom ${i}` }));

beforeEach(() => {
  db.inserts.length = 0;
  db.rpc.mockReset();
  db.rpc.mockImplementation(async () => ({ data: 1024, error: null }));
  vi.clearAllMocks();
  resetTelemetryLimits();
});
afterEach(() => vi.useRealTimers());

describe('anonymous telemetry: severity filter and size caps', () => {
  it('stores only warn / error / critical from a signed-out sender, and logs the rest', async () => {
    const out = await recordTelemetryEvents(
      ['debug', 'info', 'warn', 'error', 'critical', 'bogus'].map((severity) => ({ eventType: 'x', severity, message: severity })),
      anon('203.0.113.9')
    );
    expect(out).toEqual({ accepted: 6, persisted: false }); // honest: not everything accepted was stored
    expect(storedEvents().map((r) => r.severity)).toEqual(['warn', 'error', 'critical']);
    // Every event still reaches the log.
    expect(vi.mocked(logger.info).mock.calls.filter(([m]) => m === 'telemetry_event')).toHaveLength(3); // debug, info, bogus→info
  });

  it('a signed-in sender keeps every severity', async () => {
    const out = await recordTelemetryEvents([{ eventType: 'x', severity: 'info' }, { eventType: 'y', severity: 'debug' }], { userId: 'u1', ip: '203.0.113.9' });
    expect(out).toEqual({ accepted: 2, persisted: true });
    expect(storedEvents()).toHaveLength(2);
  });

  it('caps a signed-out message at 1,000 characters and metadata at 4,500 bytes (signed-in: 2,000 and 8,000)', async () => {
    const big = { stack: 'é'.repeat(6_000), note: 'x"'.repeat(1_000) };
    await recordTelemetryEvents([{ eventType: 'x', severity: 'error', message: 'm'.repeat(5_000), metadata: big }], anon('203.0.113.9'));
    await recordTelemetryEvents([{ eventType: 'x', severity: 'error', message: 'm'.repeat(5_000), metadata: big }], { userId: 'u1' });
    const [a, s] = storedEvents();
    expect(a.message).toHaveLength(1_000);
    expect(a.metadata.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(a.metadata))).toBeLessThanOrEqual(ANON_METADATA_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(a.metadata))).toBeGreaterThan(ANON_METADATA_MAX_BYTES - 200);
    expect(s.message).toHaveLength(2_000);
    expect(Buffer.byteLength(JSON.stringify(s.metadata))).toBeLessThanOrEqual(8_000);
    // Small metadata is stored exactly as sent.
    await recordTelemetryEvents([{ eventType: 'x', severity: 'warn', metadata: { lineno: 3, file: 'a.js' } }], anon('203.0.113.9'));
    expect(storedEvents().at(-1)!.metadata).toEqual({ lineno: 3, file: 'a.js' });
  });

  it('caps signed-out feedback metadata too', async () => {
    await recordFeedback({ vote: 'like', metadata: { blob: 'z'.repeat(20_000) } }, anon('203.0.113.9'));
    const row = db.inserts.find((i) => i.table === 'user_feedback')!.rows as { metadata: Record<string, unknown> };
    expect(row.metadata.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(row.metadata))).toBeLessThanOrEqual(ANON_METADATA_MAX_BYTES);
  });
});

describe('anonymous telemetry: budgets', () => {
  it('300 rows a day per IPv6 /64 — rotating through the /64 does not help — and a new /64 starts fresh', async () => {
    let stored = 0;
    for (let i = 0; i < 20; i++) {
      await recordTelemetryEvents(errors(20), anon(`2001:db8:5:6::${(i + 1).toString(16)}`));
    }
    stored = storedEvents().length;
    expect(stored).toBe(ANON_ROWS_PER_CLIENT_PER_DAY);
    const out = await recordTelemetryEvents(errors(5), anon('2001:db8:5:7::1'));
    expect(out.persisted).toBe(true);
    expect(storedEvents()).toHaveLength(stored + 5);
    // One bounded log line, not one per refused batch.
    const lines = vi.mocked(logger.warn).mock.calls.filter(([m]) => m === 'telemetry_budget_exhausted');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0][1]).toMatchObject({ pool: 'anon', scope: 'sender' });
  });

  it('3,000 rows a day in all, however many senders; the next UTC day starts over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T22:00:00Z'));
    for (let i = 0; i < 12; i++) {
      for (let b = 0; b < 15; b++) await recordTelemetryEvents(errors(20), anon(`198.51.100.${i + 1}`));
    }
    expect(storedEvents()).toHaveLength(ANON_ROWS_PER_DAY);
    expect(await recordTelemetryEvents(errors(1), anon('192.0.2.1'))).toEqual({ accepted: 1, persisted: false });
    // Feedback shares the anonymous budget.
    expect(await recordFeedback({ vote: 'like' }, anon('192.0.2.1'))).toEqual({ persisted: false });
    // A signed-in sender is never held to it.
    expect(await recordTelemetryEvents(errors(1), { userId: 'u1', ip: '192.0.2.1' })).toEqual({ accepted: 1, persisted: true });
    expect(await recordFeedback({ vote: 'like' }, { userId: 'u1' })).toEqual({ persisted: true });

    vi.setSystemTime(new Date('2026-11-06T00:00:05Z'));
    expect(await recordTelemetryEvents(errors(1), anon('192.0.2.1'))).toEqual({ accepted: 1, persisted: true });
  });

  it('server 5xx records have a budget of their own: a client flood that used up the day does not stop them', async () => {
    // Every anonymous row of the day used up by client-sent events.
    for (let i = 0; i < ANON_ROWS_PER_DAY / ANON_ROWS_PER_CLIENT_PER_DAY; i++) {
      for (let b = 0; b < ANON_ROWS_PER_CLIENT_PER_DAY / 20; b++) await recordTelemetryEvents(errors(20), anon(`198.51.100.${i + 1}`));
    }
    expect(storedEvents()).toHaveLength(ANON_ROWS_PER_DAY);
    expect((await recordTelemetryEvents(errors(1), anon('203.0.113.77'))).persisted).toBe(false);
    // A client cannot claim the server's pool by sending source: 'server'.
    expect((await recordTelemetryEvents([{ eventType: 'server_error', severity: 'critical', source: 'server' }], anon('203.0.113.77'))).persisted).toBe(false);
    recordServerError({ path: '/api/x', status: 500, message: 'boom', ip: '203.0.113.77' });
    recordServerError({ path: '/api/x', status: 500, message: 'boom', ip: '203.0.113.78', userId: 'u1' });
    await vi.waitFor(() => expect(storedEvents()).toHaveLength(ANON_ROWS_PER_DAY + 2));
    expect(storedEvents().slice(-2).map((r) => [r.user_id, r.severity])).toEqual([[null, 'critical'], ['u1', 'critical']]);
  });

  it('a sender that triggers 5xx on purpose is held to its own share of the server pool', async () => {
    for (let i = 0; i < SERVER_ROWS_PER_SENDER_PER_DAY + 5; i++) recordServerError({ path: '/api/x', status: 500, message: 'boom', ip: '2001:db8:77:1::9' });
    await vi.waitFor(() => expect(storedEvents()).toHaveLength(SERVER_ROWS_PER_SENDER_PER_DAY));
    recordServerError({ path: '/api/x', status: 500, message: 'boom', ip: '2001:db8:77:2::9' });
    await vi.waitFor(() => expect(storedEvents()).toHaveLength(SERVER_ROWS_PER_SENDER_PER_DAY + 1));
  });
});

describe('signed-in budgets', () => {
  it(`${ACCOUNT_EVENT_ROWS_PER_DAY} events a UTC day per account, then logged only; another account and the next day start fresh`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T09:00:00Z'));
    for (let i = 0; i < ACCOUNT_EVENT_ROWS_PER_DAY / 50; i++) await recordTelemetryEvents(errors(50), { userId: 'u1' });
    expect(storedEvents()).toHaveLength(ACCOUNT_EVENT_ROWS_PER_DAY);
    expect(await recordTelemetryEvents(errors(1), { userId: 'u1', ip: '203.0.113.9' })).toEqual({ accepted: 1, persisted: false });
    // The account's budget does not follow its address, and another account is unaffected.
    expect((await recordTelemetryEvents(errors(1), anon('203.0.113.9'))).persisted).toBe(true);
    expect((await recordTelemetryEvents(errors(1), { userId: 'u2' })).persisted).toBe(true);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('telemetry_budget_exhausted', expect.objectContaining({ pool: 'account_events', scope: 'sender' }));
    vi.setSystemTime(new Date('2026-11-06T00:00:01Z'));
    expect((await recordTelemetryEvents(errors(1), { userId: 'u1' })).persisted).toBe(true);
  });

  it(`${ACCOUNT_FEEDBACK_ROWS_PER_DAY} feedback rows a day per account`, async () => {
    for (let i = 0; i < ACCOUNT_FEEDBACK_ROWS_PER_DAY; i++) expect(await recordFeedback({ vote: 'like', comment: `c${i}` }, { userId: 'u1' })).toEqual({ persisted: true });
    expect(await recordFeedback({ vote: 'like' }, { userId: 'u1' })).toEqual({ persisted: false });
    expect(await recordFeedback({ vote: 'like' }, { userId: 'u2' })).toEqual({ persisted: true });
    expect(storedFeedback()).toHaveLength(ACCOUNT_FEEDBACK_ROWS_PER_DAY + 1);
  });
});

describe('the 150 MB size gate', () => {
  it('above the limit no event and no signed-out feedback is stored; the size is asked once per 5 minutes', async () => {
    db.rpc.mockImplementation(async () => ({ data: TELEMETRY_STORAGE_LIMIT_BYTES + 1, error: null }));
    expect(await recordTelemetryEvents(errors(2), { userId: 'u1' })).toEqual({ accepted: 2, persisted: false });
    expect(await recordTelemetryEvents(errors(2), anon('203.0.113.9'))).toEqual({ accepted: 2, persisted: false });
    expect(await recordFeedback({ vote: 'dislike' }, anon('203.0.113.9'))).toEqual({ persisted: false });
    // Signed-in feedback still has its small margin (to 160 MB) …
    expect(await recordFeedback({ vote: 'dislike', comment: 'broken' }, { userId: 'u1' })).toEqual({ persisted: true });
    expect(storedEvents()).toHaveLength(0);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith('telemetry_table_bytes');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('telemetry_storage_full', expect.objectContaining({ limitBytes: TELEMETRY_STORAGE_LIMIT_BYTES }));
  });

  it('… and nothing at all is stored past the feedback ceiling', async () => {
    db.rpc.mockImplementation(async () => ({ data: FEEDBACK_STORAGE_LIMIT_BYTES + 1, error: null }));
    expect(await recordFeedback({ vote: 'dislike', comment: 'broken' }, { userId: 'u1' })).toEqual({ persisted: false });
    expect(storedFeedback()).toHaveLength(0);
  });

  it('between two size reads the bytes stored since the last one count: the gate closes without waiting 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    const big = (n: number) => Array.from({ length: n }, () => ({ eventType: 'x', severity: 'error', message: 'm'.repeat(2_000), metadata: { blob: 'z'.repeat(7_000) } }));
    const perBatch = Buffer.byteLength(JSON.stringify(big(50)));
    // The last read leaves room for about two and a half batches.
    db.rpc.mockImplementation(async () => ({ data: TELEMETRY_STORAGE_LIMIT_BYTES - Math.floor(perBatch * 2.5), error: null }));
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push((await recordTelemetryEvents(big(50), { userId: `u${i}` })).persisted);
    expect(results).toEqual([true, true, true, false, false, false]);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    // The next read is the truth again (here: the purge freed room), and the estimate restarts.
    vi.setSystemTime(new Date('2026-11-05T10:05:01Z'));
    db.rpc.mockImplementation(async () => ({ data: 1024, error: null }));
    expect((await recordTelemetryEvents(big(1), { userId: 'u9' })).persisted).toBe(true);
    expect(db.rpc).toHaveBeenCalledTimes(2);
  });

  it('re-checks after 5 minutes, so storing resumes once the purge has run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    db.rpc.mockImplementationOnce(async () => ({ data: TELEMETRY_STORAGE_LIMIT_BYTES * 2, error: null }));
    expect((await recordTelemetryEvents(errors(1), { userId: 'u1' })).persisted).toBe(false);
    vi.setSystemTime(new Date('2026-11-05T10:04:00Z'));
    expect((await recordTelemetryEvents(errors(1), { userId: 'u1' })).persisted).toBe(false);
    vi.setSystemTime(new Date('2026-11-05T10:05:01Z'));
    expect((await recordTelemetryEvents(errors(1), { userId: 'u1' })).persisted).toBe(true);
    expect(db.rpc).toHaveBeenCalledTimes(2);
  });

  it('before telemetry_table_bytes() exists (or if the check fails) the gate is skipped, not closed', async () => {
    db.rpc.mockImplementation(async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.telemetry_table_bytes without parameters in the schema cache' } }));
    expect(await recordTelemetryEvents(errors(1), anon('203.0.113.9'))).toEqual({ accepted: 1, persisted: true });
    expect(vi.mocked(logger.warn).mock.calls.some(([m]) => m === 'telemetry_size_check_failed')).toBe(false);
    resetTelemetryLimits();
    db.rpc.mockImplementation(async () => {
      throw new Error('network');
    });
    expect(await recordTelemetryEvents(errors(1), anon('203.0.113.9'))).toEqual({ accepted: 1, persisted: true });
  });
});
