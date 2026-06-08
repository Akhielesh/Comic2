import { describe, it, expect, afterEach } from 'vitest';
import {
  isVentureLoopAllowed,
  getKillSwitch,
  setKillSwitch,
  resetKillSwitch
} from './killSwitch.js';

afterEach(() => resetKillSwitch());

describe('isVentureLoopAllowed', () => {
  it('runs only when enabled AND not killed', () => {
    expect(isVentureLoopAllowed({ enabled: true, killed: false })).toBe(true);
    expect(isVentureLoopAllowed({ enabled: true, killed: true })).toBe(false);
    expect(isVentureLoopAllowed({ enabled: false, killed: false })).toBe(false);
    expect(isVentureLoopAllowed({ enabled: false, killed: true })).toBe(false);
  });
});

describe('kill switch runtime override', () => {
  it('defaults to the env value (false in test) until overridden', () => {
    expect(getKillSwitch()).toBe(false);
  });
  it('honors a true override (emergency stop)', () => {
    setKillSwitch(true);
    expect(getKillSwitch()).toBe(true);
  });
  it('honors a false override (force-allow)', () => {
    setKillSwitch(false);
    expect(getKillSwitch()).toBe(false);
  });
  it('reset falls back to the env default', () => {
    setKillSwitch(true);
    resetKillSwitch();
    expect(getKillSwitch()).toBe(false);
  });
});
