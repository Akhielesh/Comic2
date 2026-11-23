// The one way from Comic Studio to the DreamStream settings (navtheme NT-1). Every settings link (the account menu's
// rows today; the Director's keys chip and the usage links next) calls requestAccountSettings, which asks App to open
// Settings at a tab inside the app, so Back returns to the place the person left. The same window-event pattern as
// comicstudio/openSettings.ts: App answers with useAccountSettingsListener. When nothing answers (the QA harness, an
// embed), the request falls back to a page load of the Settings deep link.
//
import { useEffect, useRef } from 'react';
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

/** The Settings deep link App restores on load (?view=settings&tab=…). */
export const accountSettingsHref = (tab: SettingsTab): string => `/?view=settings&tab=${encodeURIComponent(tab)}`;

const resumeOf = (value: unknown): AccountResume | undefined => (value === 'new-comic' ? 'new-comic' : undefined);

// ── The request and App's side ───────────────────────────────────────────────────────────────────────────────────

/**
 * Open settings in this tab. Signed-in Studio turns continue in the detached stream registry.
 */
export const requestAccountSettings = (tab: SettingsTab, opts: AccountSettingsOptions = {}): boolean => {
  if (typeof window === 'undefined') return false;
  const href = accountSettingsHref(tab);
  const detail: AccountSettingsRequest = { tab, ...(opts.resume ? { resume: opts.resume } : {}) };
  const handled = typeof CustomEvent === 'function' && !window.dispatchEvent(new CustomEvent(ACCOUNT_SETTINGS_EVENT, { cancelable: true, detail }));
  if (!handled) window.location.assign(href);
  return handled;
};

/** Ordinary anchor activation uses App navigation. The browser owns modified clicks, the context menu and copying. */
export function openApiKeysLink(event: React.MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  requestAccountSettings('settings');
}

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

// ── Back from Settings ───────────────────────────────────────────────────────────────────────────────────────────

export interface SettingsBackInput<V extends string> {
  /**
   * The view Settings was opened from; null when Settings was reached by its address (a deep link, a reload). Settings
   * itself reads as null: Back always leaves Settings.
   */
  returnView: V | null;
  /** The resume point the request carried. */
  resume: AccountResume | null;
  /** A comic is still open (the reader's comic). */
  hasActiveProject: boolean;
  comicsHost: boolean;
  signedIn: boolean;
}

/**
 * Where Back from Settings goes (App's onClose): the view it was opened from, with the New comic form again when the
 * request came from it; a reader whose comic is gone goes to My comics; a Settings page reached by its address goes to
 * My comics on the comics host when signed in (the person's own home there), else to the home page.
 */
export const settingsBackTarget = <V extends string>(input: SettingsBackInput<V>): { view: V | 'dashboard' | 'home'; newComic: boolean } => {
  if (input.returnView === null || input.returnView === 'settings') return { view: input.comicsHost && input.signedIn ? 'dashboard' : 'home', newComic: false };
  if (input.returnView === 'reader' && !input.hasActiveProject) return { view: 'dashboard', newComic: false };
  return { view: input.returnView, newComic: input.resume === 'new-comic' && input.returnView === 'dashboard' };
};
