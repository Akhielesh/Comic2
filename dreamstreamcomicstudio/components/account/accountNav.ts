// The one way from Comic Studio to the DreamStream settings (navtheme NT-1). Every settings link (the account menu's
// rows today; the Director's keys chip and the usage links next) calls requestAccountSettings, which asks App to open
// Settings at a tab inside the app, so Back returns to the place the person left. The same window-event pattern as
// comicstudio/openSettings.ts: App answers with useAccountSettingsListener. When nothing answers (the QA harness, an
// embed), the request falls back to a page load of the Settings deep link.
//
// While a comic reports the Director at work (setStudioBusy, from the open comic), Settings opens in a new tab instead,
// so a live turn is not cut off by the trip (the precedent: reliability/OptionButtons.tsx opens its help in a new tab).
// That rule holds until liveturn LT-2 lets a comic survive the trip; LT-2 sets ACCOUNT_NAV_NEW_TAB_WHILE_BUSY to false.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isSettingsTab, type SettingsTab } from '../settingsTabs';

export const ACCOUNT_SETTINGS_EVENT = 'ds:open-account-settings';

/** Where Back from Settings resumes inside the view it left (beyond the view itself): the New comic form. */
export type AccountResume = 'new-comic';

export interface AccountSettingsOptions {
  resume?: AccountResume;
}

/** What the event carries. */
export interface AccountSettingsRequest extends AccountSettingsOptions {
  tab: SettingsTab;
}

/** Busy comics open Settings in a new tab until liveturn LT-2 ships (then: false). */
export const ACCOUNT_NAV_NEW_TAB_WHILE_BUSY = true;

/** The Settings deep link App restores on load (?view=settings&tab=…). */
export const accountSettingsHref = (tab: SettingsTab): string => `/?view=settings&tab=${encodeURIComponent(tab)}`;

const resumeOf = (value: unknown): AccountResume | undefined => (value === 'new-comic' ? 'new-comic' : undefined);

// ── Busy: the open comic says whether the Director is working ────────────────────────────────────────────────────

let busy = false;
const busyListeners = new Set<() => void>();

/** The open comic reports a live turn or render (true) and its end or unmount (false). */
export const setStudioBusy = (next: boolean): void => {
  if (busy === next) return;
  busy = next;
  for (const listener of [...busyListeners]) listener();
};

export const isStudioBusy = (): boolean => busy;

const subscribeBusy = (listener: () => void): (() => void) => {
  busyListeners.add(listener);
  return () => {
    busyListeners.delete(listener);
  };
};

/** True while settings links open a new tab (a comic is busy and the rule is on). */
export const useSettingsOpenInNewTab = (): boolean =>
  useSyncExternalStore(subscribeBusy, () => ACCOUNT_NAV_NEW_TAB_WHILE_BUSY && busy, () => false);

// ── The request and App's side ───────────────────────────────────────────────────────────────────────────────────

/**
 * Open the DreamStream settings at `tab`. True when App opened it in the app. While a comic is busy it opens in a new
 * tab instead (and returns false); when nothing in the page answers, it loads the Settings deep link.
 */
export const requestAccountSettings = (tab: SettingsTab, opts: AccountSettingsOptions = {}): boolean => {
  if (typeof window === 'undefined') return false;
  const href = accountSettingsHref(tab);
  if (ACCOUNT_NAV_NEW_TAB_WHILE_BUSY && busy) {
    window.open(href, '_blank', 'noopener');
    return false;
  }
  const detail: AccountSettingsRequest = { tab, ...(opts.resume ? { resume: opts.resume } : {}) };
  const handled = typeof CustomEvent === 'function' && !window.dispatchEvent(new CustomEvent(ACCOUNT_SETTINGS_EVENT, { cancelable: true, detail }));
  if (!handled) window.location.assign(href);
  return handled;
};

/** App's side: open Settings for every request with a known tab (the detail may come from anywhere on the page). */
export function useAccountSettingsListener(handler: (tab: SettingsTab, opts: AccountSettingsOptions) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<Partial<AccountSettingsRequest> | null>).detail;
      if (!isSettingsTab(detail?.tab)) return;
      e.preventDefault();
      const resume = resumeOf(detail?.resume);
      handlerRef.current(detail.tab, resume ? { resume } : {});
    };
    window.addEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
    return () => window.removeEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
  }, []);
}
