export { USERNAME_REGEX } from '../../../shared/username.js';
const MIN_SIGNUP_AGE_YEARS = 8;
const DAY_MS = 86_400_000;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * DOB rules mirroring the clients (the live DB trigger checks the format but NOT the age).
 * One day of slack: the clients check in the user's local zone, which can be ahead of UTC.
 */
export const dobProblem = (dob: string, now: Date = new Date()): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return 'Date of birth must be valid.';
  const date = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || isoDay(date) !== dob || dob < '1900-01-01') return 'Date of birth must be valid.';
  const latest = new Date(now.getTime() + DAY_MS);
  if (dob > isoDay(latest)) return 'Date of birth cannot be in the future.';
  const oldEnough = new Date(latest);
  oldEnough.setUTCFullYear(oldEnough.getUTCFullYear() - MIN_SIGNUP_AGE_YEARS);
  if (dob > isoDay(oldEnough)) return `You must be at least ${MIN_SIGNUP_AGE_YEARS} years old to sign up.`;
  return null;
};
