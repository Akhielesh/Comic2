// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isMissed } from '../views/callsBadge';
import { joinedAfter, rateQuality, videoBitrate } from './callMesh';
import { familyName } from './callCenter';
import type { CallRecord } from './types';

describe('call mesh rules', () => {
  it('the one who joined later offers (ties broken by socket id) — never both', () => {
    expect(joinedAfter({ at: 2, sid: 'a' }, { at: 1, sid: 'z' })).toBe(true);
    expect(joinedAfter({ at: 1, sid: 'z' }, { at: 2, sid: 'a' })).toBe(false);
    const x = { at: 5, sid: 'b' };
    const y = { at: 5, sid: 'a' };
    expect(joinedAfter(x, y)).not.toBe(joinedAfter(y, x));
  });
  it('shares the uplink between everyone you send to', () => {
    expect(videoBitrate(1)).toBe(1_500_000);
    expect(videoBitrate(2)).toBe(900_000);
    expect(videoBitrate(3)).toBe(600_000);
  });
  it('rates the connection from loss and round-trip time', () => {
    expect(rateQuality(0.5, 0.05)).toBe('good');
    expect(rateQuality(4, 0.05)).toBe('fair');
    expect(rateQuality(1, 0.4)).toBe('fair');
    expect(rateQuality(12, 0.05)).toBe('poor');
    expect(rateQuality(0, 0.9)).toBe('poor');
  });
});

describe('call history', () => {
  const rec = (over: Partial<CallRecord>): CallRecord => ({
    id: 'c', from: { uid: 'mom', name: 'Alice', label: 'Mom' }, invited: ['gpa'], joined: [{ uid: 'mom', name: 'Alice' }],
    video: true, at: 1, secs: 0, answered: false, why: 'no_answer', ...over,
  });
  it('a missed call: rung, never picked up on any device, not declined', () => {
    expect(isMissed(rec({}), 'gpa')).toBe(true);
    expect(isMissed(rec({ why: 'cancelled' }), 'gpa')).toBe(true);
    expect(isMissed(rec({ why: 'declined' }), 'gpa')).toBe(false);
    expect(isMissed(rec({ answered: true, why: 'done', joined: [{ uid: 'mom', name: 'Alice' }, { uid: 'gpa', name: 'Bob' }] }), 'gpa')).toBe(false);
    expect(isMissed(rec({}), 'mom')).toBe(false); // your own call isn't "missed"
    expect(isMissed(rec({}), null)).toBe(false);
  });
  it('names a nursery by its baby', () => {
    expect(familyName({ name: 'Nursery', baby: 'Aria' })).toBe('Aria’s family');
    expect(familyName({ name: 'Grandma’s house', baby: null })).toBe('Grandma’s house');
    expect(familyName(null)).toBe('Family');
  });
});
