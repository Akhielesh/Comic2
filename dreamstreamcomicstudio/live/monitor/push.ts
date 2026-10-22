/**
 * Web Push for baby-monitor alerts: a cry or an offline camera wakes the
 * parent's phone even when Stream Studio is closed (Android/desktop; iPhone
 * once the app is added to the Home Screen — Apple's rule for web push).
 */

import { LIVE_SW_SCOPE } from '../host';

export const SW_URL = '/live-sw.js';
export const SW_SCOPE = LIVE_SW_SCOPE; // '/' on Stream Studio's own host (live/host.ts)

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iPhone/iPad Safari only allows web push for Home Screen apps. */
export function needsHomeScreen(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

export async function registerSw(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  } catch {
    return null;
  }
}

function keyBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask permission (must be called from a tap) and subscribe this device. */
export async function subscribe(vapidPublicKey: string): Promise<PushSubscriptionJSON | { error: string }> {
  if (!pushSupported()) return { error: 'This browser can’t receive alerts in the background.' };
  if (needsHomeScreen()) return { error: 'On iPhone, add Stream Studio to your Home Screen first (Share → Add to Home Screen), then turn alerts on from there.' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { error: 'Notifications are blocked — allow them for this site in your browser settings.' };
  const reg = await registerSw();
  if (!reg) return { error: 'Could not start the alert service worker.' };
  await navigator.serviceWorker.ready;
  try {
    let sub = await reg.pushManager.getSubscription();
    const want = keyBytes(vapidPublicKey);
    // A subscription bound to an old server key can't receive our pushes.
    const have = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && have && (have.length !== want.length || have.some((b, i) => b !== want[i]))) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    return sub.toJSON();
  } catch {
    return { error: 'The browser refused the alert subscription.' };
  }
}

/** Local-only notification (page open, e.g. tab in background). */
export async function localNotify(title: string, body: string, tag: string, url: string): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration(SW_SCOPE);
    if (reg) await reg.showNotification(title, { body, tag, data: { url }, icon: '/stream-studio.svg', badge: '/stream-studio.svg' } as NotificationOptions);
    else new Notification(title, { body, tag });
  } catch { /* ignore */ }
}
