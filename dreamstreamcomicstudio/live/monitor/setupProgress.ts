/**
 * "Get set up" checklist progress for a nursery, as seen from this device.
 * Steps are marked where they happen (the camera screen, the watch screen);
 * the family step is done once someone else has an account in the nursery
 * or a guest has joined with the share link (marked where a parent sees it).
 */

export type SetupStep = 'camera' | 'watch' | 'alerts' | 'talk' | 'family';

export const SETUP_STEPS: SetupStep[] = ['camera', 'watch', 'alerts', 'talk', 'family'];

const key = (nid: string) => `ds-monitor-setup-${nid}`;
const hiddenKey = (nid: string) => `ds-monitor-setup-hidden-${nid}`;

function read(nid: string): Partial<Record<SetupStep, number>> {
  try {
    return JSON.parse(localStorage.getItem(key(nid)) || '{}') as Partial<Record<SetupStep, number>>;
  } catch {
    return {};
  }
}

export function markSetup(nid: string, step: SetupStep): void {
  const s = read(nid);
  if (s[step]) return;
  s[step] = Date.now();
  try {
    localStorage.setItem(key(nid), JSON.stringify(s));
  } catch { /* storage unavailable */ }
}

export function setupDone(nid: string, memberCount: number): Record<SetupStep, boolean> {
  const s = read(nid);
  return {
    camera: !!s.camera,
    watch: !!s.watch,
    alerts: !!s.alerts,
    talk: !!s.talk,
    family: memberCount > 1 || !!s.family,
  };
}

export function setupHidden(nid: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(nid)) === '1';
  } catch {
    return false;
  }
}

export function hideSetup(nid: string, hidden = true): void {
  try {
    if (hidden) localStorage.setItem(hiddenKey(nid), '1');
    else localStorage.removeItem(hiddenKey(nid));
  } catch { /* storage unavailable */ }
}
