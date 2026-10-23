import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonitorMs, addNightSegment, addSave, deviceMonth, meetingUse, nightOverlaps, nightSummary, saveMeetingUse } from './ledger';
import { createViewerMeter, viewerPath } from './monitorUsage';
import { MeetingMeter } from './studioUsage';

const H = 3_600_000;
const MIN = 60_000;
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('nights (18:00 → 09:00 local)', () => {
  it('splits a stretch across the night windows it overlaps, keyed by the evening', () => {
    expect(nightOverlaps(local(2026, 10, 22, 20), local(2026, 10, 23, 7))).toEqual([{ key: '2026-10-22', ms: 11 * H }]);
    // An afternoon stretch that runs into the evening counts only from 18:00.
    expect(nightOverlaps(local(2026, 10, 22, 16), local(2026, 10, 22, 19))).toEqual([{ key: '2026-10-22', ms: H }]);
    // Early morning belongs to the evening before.
    expect(nightOverlaps(local(2026, 10, 23, 2), local(2026, 10, 23, 3))).toEqual([{ key: '2026-10-22', ms: H }]);
    // Daytime is no night at all.
    expect(nightOverlaps(local(2026, 10, 23, 10), local(2026, 10, 23, 17))).toEqual([]);
    expect(nightOverlaps(5, 5)).toEqual([]);
  });

  it('"Last night" in the morning, "Tonight so far" after 18:00, per nursery, last 14 nights kept', () => {
    addNightSegment('n1', 'lan', local(2026, 10, 22, 19), local(2026, 10, 23, 5));
    addNightSegment('n1', 'turn', local(2026, 10, 23, 5), local(2026, 10, 23, 5, 12));
    addNightSegment('n2', 'direct', local(2026, 10, 22, 21), local(2026, 10, 22, 22));
    const morning = nightSummary('n1', local(2026, 10, 23, 8));
    expect(morning?.label).toBe('Last night');
    expect(morning?.ms).toEqual({ lan: 10 * H, direct: 0, turn: 12 * MIN, server: 0 });
    expect(nightSummary('n2', local(2026, 10, 23, 8))?.ms.direct).toBe(H);
    expect(nightSummary('nope', local(2026, 10, 23, 8))).toBeNull();
    addNightSegment('n1', 'direct', local(2026, 10, 23, 19), local(2026, 10, 23, 20));
    expect(nightSummary('n1', local(2026, 10, 23, 21))?.label).toBe('Tonight so far');
    for (let d = 1; d <= 20; d++) addNightSegment('n3', 'lan', local(2026, 9, d, 20), local(2026, 9, d, 21));
    expect(Object.keys(JSON.parse(localStorage.getItem('ds-usage-nights-n3') ?? '{}'))).toHaveLength(14);
  });
});

describe('this device’s month', () => {
  it('adds monitor minutes and saves by destination; keeps only this month and last', () => {
    const now = Date.UTC(2026, 9, 23, 12);
    addMonitorMs('lan', now - H, now);
    addMonitorMs('server', now - 10 * MIN, now);
    addMonitorMs('direct', now, now - 1); // nothing
    addSave('drive', 6.2e9, now);
    addSave('device', 3e9, now);
    addSave('cloud', 2.84e9, now);
    addSave('drive', 0, now);
    const m = deviceMonth('2026-10');
    expect(m.monitor).toEqual({ lan: H, direct: 0, turn: 0, server: 10 * MIN });
    expect(m.saves).toEqual({ drive: 6.2e9, device: 3e9, cloud: 2.84e9 });
    localStorage.setItem('ds-usage-device-2026-07', '{}');
    addSave('device', 1, Date.UTC(2026, 10, 2));
    expect(localStorage.getItem('ds-usage-device-2026-07')).toBeNull();
    expect(localStorage.getItem('ds-usage-device-2026-10')).not.toBeNull();
    expect(deviceMonth('2026-11').saves.device).toBe(1);
  });

  it('survives junk and blocked storage (nothing shown, nothing thrown)', () => {
    localStorage.setItem('ds-usage-device-2026-10', '{"monitor":{"lan":-5,"turn":"x"},"saves":{"drive":"bad"}}');
    expect(deviceMonth('2026-10')).toEqual({ month: '2026-10', monitor: { lan: 0, direct: 0, turn: 0, server: 0 }, saves: { drive: 0, device: 0, cloud: 0 } });
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => addSave('drive', 5)).not.toThrow();
    expect(nightSummary('n1')).toBeNull();
    spy.mockRestore();
  });
});

describe('meetings this device hosted', () => {
  it('keeps one entry per event (latest wins), last 20', () => {
    const totals = { ms: { lan: 0, direct: 30 * MIN, turn: 5 * MIN, server: 0 }, turnBytes: 1e8, startedAt: 0 };
    saveMeetingUse('e1', totals, 2, 1);
    saveMeetingUse('e1', { ...totals, turnBytes: 2e8 }, 3, 2);
    expect(meetingUse('e1')).toMatchObject({ guests: 3, turnBytes: 2e8 });
    for (let i = 0; i < 25; i++) saveMeetingUse(`x${i}`, totals, 1, i);
    expect(meetingUse('e1')).toBeNull();
    expect(meetingUse('x24')).not.toBeNull();
    saveMeetingUse('', totals, 1);
    expect(meetingUse('')).toBeNull();
  });

  it('MeetingMeter: one meter per guest link, minutes per path, nothing sent anywhere', () => {
    let t = 1_000;
    const mm = new MeetingMeter(() => t);
    mm.sync([{ sid: 'a', state: 'connecting' }]);
    t += MIN;
    mm.sync([{ sid: 'a', state: 'connected', path: 'internet' }, { sid: 'b', state: 'connected', path: 'relay' }]);
    t += 10 * MIN;
    mm.sync([{ sid: 'a', state: 'connected', path: 'internet' }]); // b left: stops counting
    t += 5 * MIN;
    const tot = mm.totals();
    expect(tot.ms).toEqual({ lan: 0, direct: 15 * MIN, turn: 10 * MIN, server: 0 });
    expect(mm.guests).toBe(2);
    mm.save('ev');
    expect(meetingUse('ev')?.guests).toBe(2);
    // A meeting nobody joined leaves nothing behind.
    const empty = new MeetingMeter(() => t);
    empty.save('ev2');
    expect(meetingUse('ev2')).toBeNull();
  });
});

describe('the monitor viewer’s meter', () => {
  it('the path: the direct link when it is up, else our server while its picture draws, else none', () => {
    expect(viewerPath({ linkState: 'connected', netPath: 'lan', relayOn: true, relayDrawing: true })).toBe('lan');
    expect(viewerPath({ linkState: 'connected', netPath: 'relay', relayOn: false, relayDrawing: false })).toBe('turn');
    expect(viewerPath({ linkState: 'failed', netPath: null, relayOn: true, relayDrawing: true })).toBe('server');
    expect(viewerPath({ linkState: 'failed', netPath: null, relayOn: true, relayDrawing: false })).toBeNull();
    expect(viewerPath({ linkState: 'connecting', netPath: null, relayOn: false, relayDrawing: false })).toBeNull();
  });

  it('writes this device’s night and month as it goes, reports to the room, and flushes on pagehide and on leaving', () => {
    vi.useFakeTimers();
    vi.setSystemTime(local(2026, 10, 22, 21));
    const sent: unknown[] = [];
    const interval = vi.spyOn(window, 'setInterval');
    const v = createViewerMeter('nid', (m) => sent.push(m));
    v.meter.connected();
    v.meter.setPath('lan');
    for (let i = 0; i < 12 * 20; i++) {
      vi.advanceTimersByTime(5000);
      v.meter.tick();
    }
    window.dispatchEvent(new Event('pagehide'));
    expect(sent.at(-1)).toEqual({ t: 'use', minutes: { lan: 20, direct: 0, turn: 0 }, turnBytes: 0 });
    vi.advanceTimersByTime(2 * MIN);
    v.dispose();
    expect(sent.at(-1)).toEqual({ t: 'use', minutes: { lan: 22, direct: 0, turn: 0 }, turnBytes: 0 });
    expect(nightSummary('nid', local(2026, 10, 22, 23))?.ms.lan).toBe(22 * MIN);
    expect(deviceMonth().monitor.lan).toBe(22 * MIN);
    // After dispose, pagehide no longer reaches it.
    const n = sent.length;
    window.dispatchEvent(new Event('pagehide'));
    expect(sent).toHaveLength(n);
    // No clock of its own: the screen's existing 5 s tick drives it.
    expect(interval).not.toHaveBeenCalled();
  });
});
