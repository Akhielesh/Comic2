// resolveWhen (versions plan §9; H0): "yesterday" ends at local midnight and "this morning" at 12:00 local, in
// Asia/Kolkata (UTC+5:30, no DST) and America/Los_Angeles — including the 25-hour and 23-hour DST days.
import { describe, expect, it } from 'vitest';
import { clockLabel, dayGroupLabel, latestInWindow, resolveWhen, zonedTime } from './when';

const iso = (ms: number) => new Date(ms).toISOString();
const KOLKATA = 'Asia/Kolkata';
const LA = 'America/Los_Angeles';

describe('resolveWhen in Asia/Kolkata', () => {
  const now = Date.parse('2026-10-30T06:00:00Z'); // 11:30 IST, Friday

  it('yesterday ends at local midnight (18:30 UTC the day before)', () => {
    const w = resolveWhen({ day: 'yesterday' }, now, KOLKATA)!;
    expect(iso(w.start)).toBe('2026-10-28T18:30:00.000Z');
    expect(iso(w.end)).toBe('2026-10-29T18:30:00.000Z');
    expect(w).toMatchObject({ utc: false, label: 'yesterday', future: false });
  });

  it('this morning is 05:00–12:00 IST, never past now', () => {
    const w = resolveWhen({ day: 'today', part: 'morning' }, now, KOLKATA)!;
    expect(iso(w.start)).toBe('2026-10-29T23:30:00.000Z');
    expect(w.end).toBe(now + 1); // 12:00 IST is still ahead
    expect(w.label).toBe('this morning');
  });

  it('a date and a minute: "Tue 27 Oct at 10:42" includes that minute', () => {
    const w = resolveWhen({ day: '2026-10-27', at: '10:42' }, now, KOLKATA)!;
    expect(iso(w.end)).toBe('2026-10-27T05:13:00.000Z');
    expect(w.label).toBe('Tue 27 Oct at 10:42');
  });
});

describe('resolveWhen in America/Los_Angeles, across DST', () => {
  it('the fall-back day (Sun 1 Nov 2026) is 25 hours long', () => {
    const now = Date.parse('2026-11-02T18:00:00Z'); // Mon 10:00 PST
    const w = resolveWhen({ day: 'yesterday' }, now, LA)!;
    expect(iso(w.start)).toBe('2026-11-01T07:00:00.000Z'); // midnight PDT
    expect(iso(w.end)).toBe('2026-11-02T08:00:00.000Z'); // midnight PST
    expect(w.end - w.start).toBe(25 * 3_600_000);
    const evening = resolveWhen({ day: 'yesterday', part: 'evening' }, now, LA)!;
    expect(iso(evening.start)).toBe('2026-11-02T01:00:00.000Z'); // 17:00 PST
    expect(evening.label).toBe('yesterday evening');
  });

  it('the spring-forward day (Sun 8 Mar 2026) is 23 hours long, and the morning starts at 05:00 PDT', () => {
    const now = Date.parse('2026-03-09T20:00:00Z');
    const w = resolveWhen({ day: '2026-03-08' }, now, LA)!;
    expect(w.end - w.start).toBe(23 * 3_600_000);
    const morning = resolveWhen({ day: '2026-03-08', part: 'morning' }, now, LA)!;
    expect(iso(morning.start)).toBe('2026-03-08T12:00:00.000Z');
    expect(iso(morning.end)).toBe('2026-03-08T19:00:00.000Z');
    expect(morning.label).toBe('Sun 8 Mar morning');
  });

  it('zonedTime maps local wall time to the right instant on both sides of a change', () => {
    expect(iso(zonedTime(2026, 11, 1, 0, 0, LA))).toBe('2026-11-01T07:00:00.000Z');
    expect(iso(zonedTime(2026, 11, 1, 12, 0, LA))).toBe('2026-11-01T20:00:00.000Z');
  });
});

describe('resolveWhen edge cases', () => {
  const now = Date.parse('2026-10-30T06:00:00Z');
  it('falls back to UTC (and says so) without a valid time zone', () => {
    const w = resolveWhen({ day: 'yesterday' }, now, 'Mars/Olympus')!;
    expect(w.utc).toBe(true);
    expect(iso(w.end)).toBe('2026-10-30T00:00:00.000Z');
    expect(resolveWhen({ day: 'today' }, now)!.utc).toBe(true);
  });

  it('refuses words it cannot read', () => {
    expect(resolveWhen({ day: 'the other day' }, now, KOLKATA)).toBeNull();
    expect(resolveWhen({ day: '2026-02-30' }, now, KOLKATA)).toBeNull();
    expect(resolveWhen({ day: 'today', at: '25:00' }, now, KOLKATA)).toBeNull();
    expect(resolveWhen({ day: 'today', part: 'brunch' as never }, now, KOLKATA)).toBeNull();
  });

  it('marks a window that is entirely ahead as future', () => {
    expect(resolveWhen({ day: 'today', part: 'evening' }, now, KOLKATA)!.future).toBe(true);
  });

  it('picks the latest row inside the window ("yesterday" = latest before local midnight)', () => {
    const rows = [{ at: Date.parse('2026-10-29T10:00:00Z') }, { at: Date.parse('2026-10-29T18:00:00Z') }, { at: Date.parse('2026-10-29T19:00:00Z') }];
    const w = resolveWhen({ day: 'yesterday' }, now, KOLKATA)!;
    expect(latestInWindow(rows, (r) => r.at, { end: w.end })).toBe(rows[1]);
    expect(latestInWindow([], (r: { at: number }) => r.at, w)).toBeNull();
  });

  it('day groups and clock labels follow the viewer’s zone', () => {
    expect(dayGroupLabel(Date.parse('2026-10-29T19:00:00Z'), now, KOLKATA)).toBe('Today');
    expect(dayGroupLabel(Date.parse('2026-10-29T10:00:00Z'), now, KOLKATA)).toBe('Yesterday');
    expect(dayGroupLabel(Date.parse('2026-10-26T10:00:00Z'), now, KOLKATA)).toBe('Mon 26 Oct');
    expect(clockLabel(Date.parse('2026-10-29T05:12:00Z'), KOLKATA)).toBe('10:42');
  });
});
