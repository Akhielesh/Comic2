// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EID_MAX, EidMinter, EidSeen, isEid, mintEid, parseEid } from './eid';

describe('eid', () => {
  it('mints and parses "<dev>:<seq>"', () => {
    expect(mintEid('cam-1a2b3c4d', 1761100020000)).toBe('cam-1a2b3c4d:1761100020000');
    expect(parseEid('cam-1a2b3c4d:1761100020000')).toEqual({ dev: 'cam-1a2b3c4d', seq: 1761100020000 });
    expect(parseEid('AbCdEfGhIjKlMnOpQrStUv:0')).toEqual({ dev: 'AbCdEfGhIjKlMnOpQrStUv', seq: 0 });
    expect(mintEid('x'.repeat(40), Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(EID_MAX);
  });

  it('refuses what could collide or smuggle', () => {
    for (const bad of ['', 'cam', 'cam:', ':1', 'cam:01', 'cam:-1', 'cam:1.5', 'c m:1', 'cam:1:2', 'cam:99999999999999999', `${'x'.repeat(41)}:1`, 42, null]) {
      expect(parseEid(bad), String(bad)).toBeNull();
      expect(isEid(bad)).toBe(false);
    }
    expect(() => mintEid('bad dev', 1)).toThrow();
    expect(() => mintEid('cam', -1)).toThrow();
    expect(() => mintEid('cam', 1.5)).toThrow();
  });

  it('a minter rises with the clock, never repeats, and survives a reload', () => {
    let clock = 1_000;
    const a = new EidMinter('cam', 0, () => clock);
    expect(a.next()).toBe('cam:1000');
    expect(a.next()).toBe('cam:1001'); // same millisecond
    clock = 900; // the clock steps back
    expect(a.next()).toBe('cam:1002');
    clock = 5_000; // the camera reloads later, forgetting its counter
    expect(new EidMinter('cam', 0, () => clock).next()).toBe('cam:5000');
    // …or remembering it, when the clock is behind what it used.
    expect(new EidMinter('cam', a.seq, () => 10).next()).toBe('cam:1003');
    expect(() => new EidMinter('no spaces')).toThrow();
  });

  it('viewers alert on the first arrival and drop the duplicate', () => {
    const seen = new EidSeen(3);
    expect(seen.first('cam:1')).toBe(true); // data channel, first
    expect(seen.first('cam:1')).toBe(false); // the room's copy
    expect(seen.first('cam:2')).toBe(true);
    expect(seen.first('cam:3')).toBe(true);
    expect(seen.first('cam:4')).toBe(true); // forgets cam:1, the oldest
    expect(seen.size).toBe(3);
    expect(seen.has('cam:1')).toBe(false);
    // No eid (an older camera) or a malformed one: always alert — a missed alert is worse than two.
    expect(seen.first(undefined)).toBe(true);
    expect(seen.first(undefined)).toBe(true);
    expect(seen.first('garbage')).toBe(true);
    expect(seen.first('garbage')).toBe(true);
  });
});
