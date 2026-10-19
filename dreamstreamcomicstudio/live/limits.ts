/**
 * User-set duration limits (stream length, recording length) and the alerts
 * leading up to them. Pure so it's unit-tested; the Studio polls it at 1 Hz.
 */

/** Seconds-remaining thresholds that raise an alert, most distant first. */
export const LIMIT_ALERT_POINTS = [300, 60, 10] as const;

export const LIMIT_CHOICES_MIN = [0, 15, 30, 45, 60, 90, 120, 180] as const;

export interface LimitCheck {
  /** Seconds left before the limit (null = no limit set). */
  remainingSec: number | null;
  /** A threshold just crossed that hasn't alerted yet. */
  alertAt: (typeof LIMIT_ALERT_POINTS)[number] | null;
  /** The limit has been reached. */
  reached: boolean;
}

export function checkLimit(elapsedSec: number, limitMin: number, alreadyAlerted: ReadonlySet<number>): LimitCheck {
  if (!limitMin || limitMin <= 0) return { remainingSec: null, alertAt: null, reached: false };
  const remainingSec = Math.max(0, limitMin * 60 - elapsedSec);
  if (remainingSec <= 0) return { remainingSec: 0, alertAt: null, reached: true };
  // Fire only the CLOSEST crossed threshold — joining at 30 s left shouldn't
  // replay the 5-minute warning.
  let alertAt: LimitCheck['alertAt'] = null;
  for (const p of LIMIT_ALERT_POINTS) {
    if (remainingSec <= p && !alreadyAlerted.has(p)) alertAt = p;
  }
  return { remainingSec, alertAt, reached: false };
}

/** Mark the fired threshold AND every more-distant one as done. */
export function markAlerted(alerted: Set<number>, point: number): void {
  for (const p of LIMIT_ALERT_POINTS) if (p >= point) alerted.add(p);
}

export function fmtRemaining(sec: number): string {
  if (sec >= 120) return `${Math.round(sec / 60)} minutes`;
  if (sec >= 60) return '1 minute';
  return `${Math.max(1, Math.round(sec))} seconds`;
}

export const limitLabel = (min: number): string =>
  !min ? 'No limit' : min < 60 ? `${min} min` : min % 60 === 0 ? `${min / 60} h` : `${Math.floor(min / 60)} h ${min % 60} min`;
