// Low-power mode (reader.md §9.3): device hints, a measured slow first turn (remembered for the session),
// and the reader's override.
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { decideLowPower, measuredSlow, staticLowPower, useLowPower } from './useLowPower';

afterEach(() => window.sessionStorage.clear());

describe('low power', () => {
  it('device hints: ≤ 4 cores and ≤ 2 GB, or Save-Data', () => {
    expect(staticLowPower({ hardwareConcurrency: 4, deviceMemory: 2 } as never)).toBe(true);
    expect(staticLowPower({ hardwareConcurrency: 4, deviceMemory: 4 } as never)).toBe(false);
    expect(staticLowPower({ hardwareConcurrency: 8, connection: { saveData: true } } as never)).toBe(true);
    expect(staticLowPower(undefined)).toBe(false);
  });

  it('measured: p90 frame time over 24 ms with at least 10 frames', () => {
    expect(measuredSlow([16, 16, 16])).toBeNull();
    expect(measuredSlow(Array(12).fill(17))).toBe(false);
    expect(measuredSlow([...Array(8).fill(16), 30, 30, 30, 30])).toBe(true);
  });

  it('the reader can force fancy turns on or off', () => {
    expect(decideLowPower('on', true, true)).toBe(false);
    expect(decideLowPower('off', false, false)).toBe(true);
    expect(decideLowPower('auto', false, true)).toBe(true);
    expect(decideLowPower('auto', false, false)).toBe(false);
  });

  it('a slow first turn switches to slide turns for the rest of the session', () => {
    const { result } = renderHook(() => useLowPower('auto'));
    expect(result.current.lowPower).toBe(false);
    act(() => result.current.reportFrames([...Array(10).fill(40)]));
    expect(result.current.lowPower).toBe(true);
    expect(window.sessionStorage.getItem('comicstudio.reader.lowpower')).toBe('1');
    const again = renderHook(() => useLowPower('auto'));
    expect(again.result.current.lowPower).toBe(true);
  });
});
