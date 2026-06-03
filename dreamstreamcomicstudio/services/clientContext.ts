// Gathers lightweight, privacy-conscious runtime context to send with each chat
// turn so the model has basic situational awareness (date, timezone, locale,
// units, and — only if already permitted — a coarse location).
//
// Design rules:
// - Timezone/locale/units/now are free and always sent (no permission needed).
// - Geolocation is read ONLY when the browser already granted permission; we never
//   trigger a prompt from here. The location-permission UX is a deliberate product
//   decision handled elsewhere, not silently forced by the chat send path.
// - Coordinates are coarsened server-side; this is never precise tracking.

import type { ChatClientContext } from '../apiTypes';

// Countries that use imperial units (US customary / imperial). Everyone else: metric.
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

const deriveUnits = (locale: string): 'metric' | 'imperial' => {
  const region = locale.split('-')[1]?.toUpperCase();
  return region && IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
};

/** Synchronous base context — always available, no permissions, no network. */
export const baseClientContext = (): ChatClientContext => {
  let timezone: string | undefined;
  let locale: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* ignore */
  }
  try {
    locale = navigator.language || (navigator.languages && navigator.languages[0]);
  } catch {
    /* ignore */
  }
  return {
    now: new Date().toISOString(),
    timezone,
    locale,
    units: locale ? deriveUnits(locale) : 'metric'
  };
};

// Read coarse coordinates ONLY if geolocation is already granted. Returns undefined
// (without prompting) when permission is prompt/denied or the API is unavailable.
const readGrantedLocation = async (): Promise<ChatClientContext['location'] | undefined> => {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return undefined;
  try {
    // Permissions API isn't universal; if it's missing we conservatively skip
    // rather than risk a prompt.
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    if (!perms?.query) return undefined;
    const status = await perms.query({ name: 'geolocation' as PermissionName });
    if (status.state !== 'granted') return undefined;
  } catch {
    return undefined;
  }
  return new Promise((resolve) => {
    const done = (loc: ChatClientContext['location'] | undefined) => resolve(loc);
    const timer = setTimeout(() => done(undefined), 2500);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({ lat: pos.coords.latitude, lng: pos.coords.longitude, approximate: true });
      },
      () => {
        clearTimeout(timer);
        done(undefined);
      },
      { enableHighAccuracy: false, maximumAge: 600_000, timeout: 2000 }
    );
  });
};

/**
 * Full context for a chat turn: base context plus a coarse location when (and only
 * when) geolocation is already granted. Never prompts. Safe to call on every send.
 */
export const gatherClientContext = async (): Promise<ChatClientContext> => {
  const base = baseClientContext();
  const location = await readGrantedLocation();
  return location ? { ...base, location } : base;
};
