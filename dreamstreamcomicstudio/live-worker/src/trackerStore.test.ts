// @vitest-environment node
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { sanitizeTrack, TrackerStore } from './trackerStore';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function sqlStorage() {
  const db = new SQL.Database();
  return {
    exec(q: string, ...b: unknown[]) {
      const st = db.prepare(q);
      try {
        st.bind(b.map((v) => (v === undefined ? null : v)) as never);
        const rows: Record<string, unknown>[] = [];
        while (st.step()) rows.push(st.getAsObject());
        return { toArray: () => rows };
      } finally {
        st.free();
      }
    },
  };
}

const NOW = Date.UTC(2026, 9, 21, 15, 0);
const MOM = { name: 'Alice', uid: 'u-mom' };
const DAD = { name: 'Ben', uid: 'u-dad' };
const ok = (input: Record<string, unknown>, who = MOM, now = NOW) => {
  const r = sanitizeTrack(input, who, now);
  if (!r.ok) throw new Error(r.error);
  return r.row;
};

describe('sanitizeTrack', () => {
  it('keeps only known, clamped fields per kind', () => {
    const r = ok({ id: 'abc12345', kind: 'bottle', start: NOW - 60_000, data: { ml: 5000.7, milk: 'formula', evil: '<script>', note: '  a\u0000b  ' } });
    expect(r.data).toEqual({ ml: 1000, milk: 'formula', note: 'a b' });
    expect(r.end).toBe(r.start); // point-in-time entries end where they start
    expect(r.by).toBe('Alice');
  });

  it('lets timers run, and rejects impossible times', () => {
    expect(ok({ id: 'sleep001', kind: 'sleep', start: NOW - 3600_000, end: null }).end).toBeNull();
    expect(sanitizeTrack({ id: 'x1234567', kind: 'sleep', start: NOW, end: NOW - 1 }, MOM, NOW)).toMatchObject({ ok: false });
    expect(sanitizeTrack({ id: 'x1234567', kind: 'breast', start: NOW - 5 * 3600_000, end: NOW }, MOM, NOW)).toMatchObject({ ok: false, error: /too long/ });
    expect(sanitizeTrack({ id: 'x1234567', kind: 'note', start: NOW - 500 * 86400_000 }, MOM, NOW)).toMatchObject({ ok: false });
    expect(sanitizeTrack({ id: 'x1234567', kind: 'note', start: NOW + 3600_000 }, MOM, NOW)).toMatchObject({ ok: false });
    expect(sanitizeTrack({ id: 'bad id!', kind: 'note', start: NOW }, MOM, NOW)).toMatchObject({ ok: false });
    expect(sanitizeTrack({ id: 'x1234567', kind: 'sushi', start: NOW }, MOM, NOW)).toMatchObject({ ok: false });
  });

  it('asks for the essentials', () => {
    expect(sanitizeTrack({ id: 'b1234567', kind: 'bottle', start: NOW, data: {} }, MOM, NOW)).toMatchObject({ ok: false, error: /how much/ });
    expect(sanitizeTrack({ id: 't1234567', kind: 'temp', start: NOW, data: { c: 'hot' } }, MOM, NOW)).toMatchObject({ ok: false });
    expect(sanitizeTrack({ id: 'm1234567', kind: 'med', start: NOW, data: { dose: 5 } }, MOM, NOW)).toMatchObject({ ok: false, error: /name/ });
    expect(ok({ id: 'g1234567', kind: 'growth', start: NOW, data: { kg: 6.4321, cm: 61.25 } }).data).toEqual({ kg: 6.432, cm: 61.3 });
  });
});

describe('TrackerStore', () => {
  it('stores, edits (keeping who logged it) and lists by time', () => {
    const s = new TrackerStore(sqlStorage());
    s.put(ok({ id: 'feed0001', kind: 'bottle', start: NOW - 3 * 3600_000, data: { ml: 120, milk: 'breast' } }));
    s.put(ok({ id: 'dipe0001', kind: 'diaper', start: NOW - 2 * 3600_000, data: { pee: true, poo: true, color: 'yellow' } }));
    // Dad corrects the bottle amount.
    s.put(ok({ id: 'feed0001', kind: 'bottle', start: NOW - 3 * 3600_000, data: { ml: 150, milk: 'breast' } }, DAD, NOW + 1000));
    const all = s.range(NOW - 86400_000, NOW + 1);
    expect(all.map((r) => r.id)).toEqual(['feed0001', 'dipe0001']);
    expect(all[0].data.ml).toBe(150);
    expect(all[0].by).toBe('Alice');
    expect(s.latest().bottle?.id).toBe('feed0001');
  });

  it('a timer started on one phone is stopped on another', () => {
    const s = new TrackerStore(sqlStorage());
    s.put(ok({ id: 'nap00001', kind: 'sleep', start: NOW - 40 * 60_000, end: null, data: { where: 'crib' } }));
    expect(s.running().map((r) => r.id)).toEqual(['nap00001']);
    s.put(ok({ id: 'nap00001', kind: 'sleep', start: NOW - 40 * 60_000, end: NOW, data: { where: 'crib' } }, DAD));
    expect(s.running()).toEqual([]);
    expect(s.get('nap00001')?.end).toBe(NOW);
  });

  it('includes entries crossing the window edge and running timers', () => {
    const s = new TrackerStore(sqlStorage());
    const midnight = Date.UTC(2026, 9, 21);
    s.put(ok({ id: 'night001', kind: 'sleep', start: midnight - 3 * 3600_000, end: midnight + 4 * 3600_000 }));
    s.put(ok({ id: 'nap00002', kind: 'sleep', start: NOW - 600_000, end: null }));
    s.put(ok({ id: 'old00001', kind: 'note', start: midnight - 30 * 3600_000, data: { note: 'yesterday' } }));
    expect(s.range(midnight, midnight + 86400_000).map((r) => r.id)).toEqual(['night001', 'nap00002']);
  });

  it('deletes softly, so offline phones learn — and a stale edit can’t resurrect it', () => {
    const s = new TrackerStore(sqlStorage());
    s.put(ok({ id: 'note0001', kind: 'note', start: NOW - 1000, data: { note: 'gassy' } }));
    expect(s.delete('note0001', NOW + 10)).toBe(true);
    expect(s.range(0, NOW + 1)).toEqual([]);
    expect(s.changedSince(NOW).map((r) => [r.id, r.deleted])).toEqual([['note0001', true]]);
    expect(s.put(ok({ id: 'note0001', kind: 'note', start: NOW - 1000, data: { note: 'edited offline' } }, MOM, NOW + 20))).toBeNull();
    expect(s.delete('note0001', NOW + 30)).toBe(false);
  });

  it('closes forgotten timers and forgets very old entries', () => {
    const s = new TrackerStore(sqlStorage());
    s.put(ok({ id: 'forgot01', kind: 'activity', start: NOW - 30 * 3600_000, end: null, data: { type: 'tummy' } }, MOM, NOW));
    s.purge(NOW);
    expect(s.get('forgot01')?.end).toBe(NOW - 30 * 3600_000 + 3600_000);
  });

  it('exports CSV with formulas neutralised', () => {
    const s = new TrackerStore(sqlStorage());
    s.put(ok({ id: 'note0002', kind: 'note', start: NOW - 1000, data: { note: 'fine' } }, { name: '=HYPERLINK("x")', uid: 'u-x' }));
    const csv = s.csv(0, NOW + 1, (t) => new Date(t).toISOString());
    expect(csv.split('\r\n')[0]).toBe('start,end,minutes,type,details,logged_by');
    expect(csv.split('\r\n')[1].endsWith(`"'=HYPERLINK(""x"")"`)).toBe(true);
  });
});
