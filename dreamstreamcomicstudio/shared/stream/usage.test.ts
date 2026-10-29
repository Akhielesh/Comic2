// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  addUsage,
  allocateOverage,
  ALERT_THRESHOLDS,
  compactUsage,
  dominantPath,
  emptyCounters,
  evaluateStreamAlerts,
  FAIR_USE,
  freePathShare,
  isEmptyUsage,
  listValueOfMonth,
  listValueUsd,
  maxUsage,
  monthBounds,
  monthKey,
  monthsBefore,
  prevMonthKey,
  PROJECTION_MIN_DAYS,
  projectMonthEnd,
  sanitizeMonth,
  sanitizeUsage,
  STREAM_ALLOWANCES,
  STREAM_UNIT_PRICES,
  subUsage,
  TURN_ALERT_USD_MONTH,
  USAGE_DOUBLES,
  usageFromDoubles,
  usageToDoubles
} from './usage';

const at = (iso: string) => Date.parse(iso);

describe('stream usage — counters', () => {
  it('adds, subtracts (clamped at 0) and ignores junk', () => {
    const a = addUsage(emptyCounters(), { minutes: { server: 2, lan: 3 }, relayFrames: 100 });
    const b = addUsage(a, { minutes: { server: 1 }, relayFrames: Number.NaN, segBytes: -5 } as never);
    expect(b.minutes).toEqual({ lan: 3, direct: 0, turn: 0, server: 3 });
    expect(b.relayFrames).toBe(100);
    expect(b.segBytes).toBe(0);
    expect(subUsage(b, { relayFrames: 150, minutes: { lan: 1 } })).toMatchObject({ relayFrames: 0, minutes: { lan: 2, server: 3 } });
    // inputs are never mutated
    expect(a.minutes.server).toBe(2);
  });

  it('keeps cumulative reports monotonic (a resend never double counts)', () => {
    const first = addUsage(emptyCounters(), { minutes: { turn: 10 }, turnBytes: 1000 });
    const resend = addUsage(emptyCounters(), { minutes: { turn: 8 }, turnBytes: 1200 });
    expect(maxUsage(first, resend)).toMatchObject({ minutes: { turn: 10 }, turnBytes: 1200 });
  });

  it('compacts to non-zero fields and sanitizes stored rows', () => {
    const c = addUsage(emptyCounters(), { minutes: { direct: 1.23456 }, segCount: 3 });
    expect(compactUsage(c)).toEqual({ minutes: { direct: 1.235 }, segCount: 3 });
    expect(isEmptyUsage(emptyCounters())).toBe(true);
    expect(isEmptyUsage(c)).toBe(false);
    expect(sanitizeUsage({ minutes: { server: '4' }, rowsWrittenEst: Infinity, bogus: 9 })).toMatchObject({ minutes: { server: 4 }, rowsWrittenEst: 0 });
    expect(sanitizeMonth({ month: '2026-10', scope: 'account', counters: { call: { minutes: { turn: 2 } }, nope: {} }, updatedAt: 5 })).toMatchObject({
      month: '2026-10',
      scope: 'account',
      counters: { call: { minutes: { turn: 2 } } }
    });
    expect(sanitizeMonth({ month: 'October' })).toBeNull();
  });

  it('round-trips the Analytics Engine doubles in a fixed, append-only order', () => {
    expect(USAGE_DOUBLES.slice(0, 5)).toEqual(['minutes.lan', 'minutes.direct', 'minutes.turn', 'minutes.server', 'turnBytes']);
    expect(USAGE_DOUBLES.length).toBeLessThanOrEqual(20); // Analytics Engine limit
    const c = addUsage(emptyCounters(), { minutes: { lan: 5, server: 1 }, relayFrames: 7, workerRequestsEst: 2 });
    const d = usageToDoubles(c);
    expect(d).toHaveLength(USAGE_DOUBLES.length);
    expect(usageFromDoubles(d)).toEqual(c);
  });

  it('names the dominant path and the free-path share', () => {
    const c = addUsage(emptyCounters(), { minutes: { lan: 30, direct: 50, server: 20 } });
    expect(dominantPath(c)).toBe('direct');
    expect(dominantPath(emptyCounters())).toBe('');
    expect(freePathShare(c)).toBeCloseTo(0.8, 6);
    expect(freePathShare(emptyCounters())).toBeNull();
  });
});

describe('stream usage — months', () => {
  it('keys and bounds UTC months', () => {
    expect(monthKey(at('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(prevMonthKey('2026-01')).toBe('2025-12');
    expect(monthsBefore('2026-10', 13)).toBe('2025-09');
    expect(monthBounds(at('2026-02-10T00:00:00Z')).daysInMonth).toBe(28);
  });
});

describe('stream usage — list value (est., never a charge)', () => {
  it('prices a relayed monitor night like the feature doc (≈ $0.0055 per relay viewer-night)', () => {
    // 10 h at 15 fps = 540k incoming frames; 600 relay minutes.
    const night = addUsage(emptyCounters(), { relayFrames: 540_000, minutes: { server: 600 } });
    const v = listValueUsd(night, 'monitor');
    expect(v.estimated).toBe(true);
    const byId = Object.fromEntries(v.lines.map((l) => [l.id, l]));
    expect(byId.doRequests.units).toBe(27_000); // 20:1
    expect(byId.doDuration.units).toBeCloseTo(69, 6);
    expect(v.usd).toBeCloseTo(0.00405 + 0.0008625, 5);
  });

  it('uses measured TURN bytes when reported, else minutes × the kind’s relay bitrate', () => {
    const measured = listValueUsd(addUsage(emptyCounters(), { turnBytes: 3.1e9, minutes: { turn: 600 } }), 'monitor');
    expect(measured.lines[0]).toMatchObject({ id: 'turn', label: 'TURN relay' });
    expect(measured.usd).toBeCloseTo(3.1 * STREAM_UNIT_PRICES.turnPerGb, 6);
    // 30 min 1:1 call on TURN at the 700 kbps relay cap (+ sound) ≈ 0.18 GB ≈ $0.009 (feature doc C7)
    const call = listValueUsd(addUsage(emptyCounters(), { minutes: { turn: 30 } }), 'call');
    expect(call.lines[0].label).toBe('TURN relay (from minutes)');
    expect(call.usd).toBeCloseTo(0.009225, 6);
  });

  it('prices a broadcast hour (segments, viewers, Worker GETs) within the doc’s range', () => {
    // 1 h of 6 s segments at 720p (~1.17 GB), 20 viewers for the hour.
    const hour = addUsage(emptyCounters(), {
      segCount: 600,
      segBytes: 1.17e9,
      viewerMinutes: 20 * 60,
      doRequestsEst: 1200,
      rowsWrittenEst: 600,
      workerRequestsEst: 600
    });
    const v = listValueUsd(hour, 'broadcast');
    expect(v.usd).toBeGreaterThan(0.004);
    expect(v.usd).toBeLessThan(0.02);
    expect(v.lines.find((l) => l.id === 'workerRequests')?.units).toBe(600 + 12_000);
  });

  it('prices a 7-day cloud copy (storage for a week + multipart Class A)', () => {
    const v = listValueUsd(addUsage(emptyCounters(), { cloudCopyBytes: 2.9e9 }), 'cloud_copy');
    const storage = v.lines.find((l) => l.id === 'r2Storage')!;
    expect(storage.units).toBeCloseTo((2.9 * 7) / 30, 6);
    expect(v.lines.find((l) => l.id === 'r2Ops')!.units).toBe(Math.ceil(2.9e9 / (16 * 1024 * 1024)) + 2);
  });

  it('sums a month across kinds', () => {
    const m = listValueOfMonth({
      monitor: addUsage(emptyCounters(), { relayFrames: 20_000 }),
      call: addUsage(emptyCounters(), { minutes: { turn: 10 } })
    });
    expect(m.usd).toBeCloseTo(listValueUsd(addUsage(emptyCounters(), { relayFrames: 20_000 }), 'monitor').usd + 10 * 6.15e6 / 1e9 * 0.05, 6);
    expect(listValueOfMonth({}).usd).toBe(0);
  });
});

describe('stream usage — overage allocation (free tier consumed account-wide first)', () => {
  it('is $0 marginal while the account is inside every allowance, whatever the list value', () => {
    const r = allocateOverage({ doRequests: 900_000, turnGb: 400 }, {}, { doRequests: 0.9, turnGb: 1 });
    expect(r.accountOverageUsd).toBe(0);
    expect(r.productUsd).toBe(0);
    expect(r.meters.map((m) => m.id)).toEqual(['doRequests', 'turnGb']);
  });

  it('charges only the overage and splits it by share', () => {
    const r = allocateOverage({ turnGb: 1200, doRowsWritten: 60_000_000 }, {}, { turnGb: 1, doRowsWritten: 0.25 });
    const turn = r.meters.find((m) => m.id === 'turnGb')!;
    expect(turn.overage).toBe(200);
    expect(turn.overageUsd).toBeCloseTo(10, 6);
    expect(turn.productUsd).toBeCloseTo(10, 6);
    const rows = r.meters.find((m) => m.id === 'doRowsWritten')!;
    expect(rows.overageUsd).toBeCloseTo(10, 6);
    expect(rows.productUsd).toBeCloseTo(2.5, 6);
    expect(r.productUsd).toBeCloseTo(12.5, 6);
    expect(r.accountOverageUsd).toBeCloseTo(20, 6);
  });

  it('accepts overridden allowances and clamps shares', () => {
    const r = allocateOverage({ r2StoredGb: 12 }, { r2StoredGb: 11 }, { r2StoredGb: 7 });
    expect(r.meters[0]).toMatchObject({ overage: 1, share: 1 });
  });
});

describe('stream usage — month-end projection', () => {
  it('projects linearly and finds the crossing day', () => {
    const now = at('2026-10-11T00:00:00Z'); // 10 days into a 31-day month
    const p = projectMonthEnd(500, now, 1000);
    expect(p.daysElapsed).toBeCloseTo(10, 6);
    expect(p.perDay).toBeCloseTo(50, 6);
    expect(p.projected).toBeCloseTo(1550, 6);
    expect(p.pctOfLimit).toBeCloseTo(155, 1);
    expect(p.crossesOn).toBe('2026-10-21');
    expect(p.crossed).toBe(false);
  });

  it('does not explode in the first minutes of a month, and flags an already-crossed limit', () => {
    const early = projectMonthEnd(10, at('2026-11-01T00:01:00Z'), 100);
    expect(early.daysElapsed).toBeCloseTo(1 / 24, 2);
    const crossed = projectMonthEnd(120, at('2026-11-05T12:00:00Z'), 100);
    expect(crossed.crossed).toBe(true);
    expect(crossed.crossesOn).toBe('2026-11-05');
    expect(projectMonthEnd(1, at('2026-11-05T12:00:00Z'), 1000).crossesOn).toBeNull();
  });

  it('can treat the first days of a month as at least `minDays` elapsed (the alerts’ floor), and is plain straight-line after', () => {
    const first = projectMonthEnd(1.95, at('2026-11-01T06:17:00Z'), null, { minDays: PROJECTION_MIN_DAYS });
    expect(first.daysElapsed).toBe(3);
    expect(first.projected).toBeCloseTo((1.95 / 3) * 30, 3);
    const later = projectMonthEnd(500, at('2026-10-11T00:00:00Z'), 1000, { minDays: PROJECTION_MIN_DAYS });
    expect(later.projected).toBeCloseTo(1550, 6); // 10 days in: the floor no longer matters
  });
});

describe('stream usage — alerts', () => {
  const now = at('2026-10-21T12:00:00Z');

  it('fires free-tier alerts at 80% (warning) and 100% (critical) of the projection', () => {
    const alerts = evaluateStreamAlerts({
      nowMs: now,
      headroom: [
        { id: 'doRequests', label: 'DO requests', used: 600_000, allowance: 1_000_000, projected: 850_000 },
        { id: 'doRowsWritten', label: 'DO rows', used: 40_000_000, allowance: 50_000_000, projected: 59_000_000 },
        { id: 'r2ClassA', label: 'R2 A', used: 1, allowance: 1_000_000, projected: 2 }
      ]
    });
    expect(alerts.map((a) => [a.id, a.severity])).toEqual([
      ['free_tier:doRowsWritten', 'critical'],
      ['free_tier:doRequests', 'warning']
    ]);
    expect(alerts[1].cause).toContain('shared by every Worker');
  });

  it('fires the owner’s $10 TURN alert: warning at list price, critical once billable', () => {
    // 10 days in: 70 GB → projected ≈ 217 GB ≈ $10.85 at list price, inside the free TB.
    const warn = evaluateStreamAlerts({ nowMs: at('2026-10-11T00:00:00Z'), turnGbMonthToDate: 70 });
    expect(warn).toEqual([expect.objectContaining({ id: 'turn_spend', severity: 'warning' })]);
    expect(TURN_ALERT_USD_MONTH).toBe(10);
    // 20 days in: 800 GB → projected 1,240 GB → $12 past the free TB.
    const crit = evaluateStreamAlerts({ nowMs: at('2026-10-21T00:00:00Z'), turnGbMonthToDate: 800 });
    expect(crit.find((a) => a.id === 'turn_spend')?.severity).toBe('critical');
    expect(evaluateStreamAlerts({ nowMs: now, turnGbMonthToDate: 5 })).toEqual([]);
  });

  it('does not extrapolate one night into a monthly TURN alert on the 1st (the watch runs at 06:17 UTC)', () => {
    // One all-night TURN viewer at 0.69 Mbps ≈ 1.95 GB by 06:17 on the 1st; the real month is ≈ 96 GB ($4.80).
    // A plain straight line said ≈ 231 GB ($11.56) — a false warning, then a close the next day, every month.
    expect(evaluateStreamAlerts({ nowMs: at('2026-11-01T06:17:00Z'), turnGbMonthToDate: 1.95 })).toEqual([]);
    // A real leak still shows the next morning: 63 GB by 06:17 on the 2nd → on course for ≈ 630 GB ($31 at list price).
    expect(evaluateStreamAlerts({ nowMs: at('2026-11-02T06:17:00Z'), turnGbMonthToDate: 63 })).toEqual([expect.objectContaining({ id: 'turn_spend', severity: 'warning' })]);
    // …and the leak rule is on actuals, so it never waits for the floor.
    expect(evaluateStreamAlerts({ nowMs: at('2026-11-01T06:17:00Z'), turnGbMonthToDate: 600 }).map((a) => a.id)).toEqual(['turn_leak', 'turn_spend']);
  });

  it('flags a TURN leak (500 GB before the 15th, or 20 GB from one identifier in a day)', () => {
    expect(evaluateStreamAlerts({ nowMs: at('2026-10-10T00:00:00Z'), turnGbMonthToDate: 501 }).some((a) => a.id === 'turn_leak')).toBe(true);
    expect(evaluateStreamAlerts({ nowMs: at('2026-10-20T00:00:00Z'), turnGbMonthToDate: 501 }).some((a) => a.id === 'turn_leak')).toBe(false);
    expect(evaluateStreamAlerts({ nowMs: now, turnTopIdentifierGbDay: 21 })).toEqual([expect.objectContaining({ id: 'turn_leak' })]);
  });

  it('flags broken hibernation only after 2 days in a row over 40 GB-s per nursery-day', () => {
    expect(evaluateStreamAlerts({ nowMs: now, gbSecPerNurseryDay: [12, 41, 39] })).toEqual([]);
    expect(evaluateStreamAlerts({ nowMs: now, gbSecPerNurseryDay: [12, 41, 45] })[0]).toMatchObject({ id: 'hibernation', severity: 'critical' });
  });

  it('checks the write diet only after Phase 0, and every remaining threshold', () => {
    expect(evaluateStreamAlerts({ nowMs: now, rowsPerNurseryDay: 9000 })).toEqual([]);
    const ids = evaluateStreamAlerts({
      nowMs: now,
      phase0Shipped: true,
      rowsPerNurseryDay: ALERT_THRESHOLDS.rowsPerNurseryDay + 1,
      serverShare7d: 0.11,
      r2StoredGb: 8.5,
      emailsMonthToDate: 2401,
      containerAwakeHours: 21
    }).map((a) => a.id);
    expect(ids.sort()).toEqual(['container_awake', 'email_near_free', 'r2_near_free', 'relay_creep', 'write_diet']);
  });

  it('checks the request budget (ADR 0006: ≤ 1,000 per active nursery-day) only after Phase 0', () => {
    expect(evaluateStreamAlerts({ nowMs: now, requestsPerNurseryDay: 4000 })).toEqual([]);
    expect(evaluateStreamAlerts({ nowMs: now, phase0Shipped: true, requestsPerNurseryDay: ALERT_THRESHOLDS.requestsPerNurseryDay })).toEqual([]);
    expect(evaluateStreamAlerts({ nowMs: now, phase0Shipped: true, requestsPerNurseryDay: 1001 })).toEqual([
      expect.objectContaining({ id: 'request_diet', severity: 'warning', title: 'MonitorRoom request budget exceeded' })
    ]);
  });

  it('meters Durable Object storage against the included 5 GB as a level', () => {
    const { meters } = allocateOverage({ doStoredGb: 6 }, {}, { doStoredGb: 1 });
    expect(meters).toEqual([expect.objectContaining({ id: 'doStoredGb', allowance: 5, overage: 1, overageUsd: 0.2, productUsd: 0.2 })]);
  });

  it('never fires on missing inputs', () => {
    expect(evaluateStreamAlerts({ nowMs: now })).toEqual([]);
  });
});

describe('stream usage — fair use (owner decisions)', () => {
  it('matches the agreed allowances', () => {
    expect(FAIR_USE).toMatchObject({ relayDataGbPerAccountMonth: 10, relayDataGbPerNurseryMonth: 10, serverPictureHoursPerNurseryDay: 16, cloudCopyGbRolling: 10 });
    expect(STREAM_ALLOWANCES.turnGb).toBe(1000);
    expect(STREAM_UNIT_PRICES.checkedOn).toBe('2026-10-22');
  });
});
