// Low-power mode (reader.md §9.3): slide turns instead of the paper fold, no ambient blur, no grain.
// On when the device is clearly low-end (≤ 4 cores and ≤ 2 GB), when Save-Data is on, or when the
// first real turn MEASURED slow (p90 frame time > 24 ms over ≥ 10 frames; remembered for the session).
// The reader can override it in Settings ("Fancy page turns").

import { useCallback, useState } from 'react';
import { p90 } from './flipPhysics';
import { readMeasuredLowPower, writeMeasuredLowPower, type Tri } from './readerPrefs';

export const SLOW_FRAME_P90_MS = 24;
export const MIN_MEASURED_FRAMES = 10;

type HintNavigator = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };

/** Device hints alone (no measurement). */
export const staticLowPower = (nav: Partial<HintNavigator> | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean => {
  if (!nav) return false;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 8;
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 4;
  return (cores <= 4 && memory <= 2) || !!nav.connection?.saveData;
};

/** The measured verdict for one turn's frame deltas, or null when there weren't enough frames. */
export const measuredSlow = (deltas: number[]): boolean | null => (deltas.length >= MIN_MEASURED_FRAMES ? p90(deltas) > SLOW_FRAME_P90_MS : null);

/** 'on' = fancy turns forced on, 'off' = forced off (low power), 'auto' = hints or measurement. */
export const decideLowPower = (fancyTurns: Tri, staticLow: boolean, measured: boolean): boolean =>
  fancyTurns === 'on' ? false : fancyTurns === 'off' ? true : staticLow || measured;

export function useLowPower(fancyTurns: Tri): { lowPower: boolean; measured: boolean; reportFrames(deltas: number[]): void } {
  const [staticLow] = useState(() => staticLowPower());
  const [measured, setMeasured] = useState(() => readMeasuredLowPower());
  const reportFrames = useCallback((deltas: number[]) => {
    const slow = measuredSlow(deltas);
    if (slow) {
      writeMeasuredLowPower(true);
      setMeasured(true);
    }
  }, []);
  return { lowPower: decideLowPower(fancyTurns, staticLow, measured), measured, reportFrames };
}
