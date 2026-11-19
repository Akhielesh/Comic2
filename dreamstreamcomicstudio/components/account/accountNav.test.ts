// @vitest-environment jsdom
// The one way to the DreamStream settings (navtheme NT-1): a request App answers in the app, a page load when nothing
// answers, and a new tab while the open comic reports the Director at work.
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_NAV_NEW_TAB_WHILE_BUSY,
  ACCOUNT_SETTINGS_EVENT,
  accountSettingsHref,
  isStudioBusy,
  requestAccountSettings,
  setStudioBusy,
  useAccountSettingsListener,
  useSettingsOpenInNewTab
} from './accountNav';

const realLocation = window.location;
const stubLocation = () => {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
  return assign;
};

afterEach(() => {
  setStudioBusy(false);
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  vi.restoreAllMocks();
});

describe('requestAccountSettings', () => {
  it('asks App with the tab and the resume point, and says App handled it', () => {
    const assign = stubLocation();
    const seen: unknown[] = [];
    const onRequest = (e: Event) => {
      seen.push((e as CustomEvent).detail);
      e.preventDefault();
    };
    window.addEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
    try {
      expect(requestAccountSettings('security')).toBe(true);
      expect(requestAccountSettings('profile', { resume: 'new-comic' })).toBe(true);
    } finally {
      window.removeEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
    }
    expect(seen).toEqual([{ tab: 'security' }, { tab: 'profile', resume: 'new-comic' }]);
    expect(assign).not.toHaveBeenCalled();
  });

  it('with nothing to answer (the QA harness, an embed) it loads the Settings deep link', () => {
    const assign = stubLocation();
    expect(requestAccountSettings('preferences')).toBe(false);
    expect(assign).toHaveBeenCalledWith('/?view=settings&tab=preferences');
    expect(accountSettingsHref('settings')).toBe('/?view=settings&tab=settings');
  });

  it('while a comic is busy it opens a new tab (noopener) and does not dispatch; the rule lifts when the comic is idle', () => {
    expect(ACCOUNT_NAV_NEW_TAB_WHILE_BUSY).toBe(true);
    const assign = stubLocation();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onRequest = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
    try {
      setStudioBusy(true);
      expect(isStudioBusy()).toBe(true);
      expect(requestAccountSettings('profile', { resume: 'new-comic' })).toBe(false);
      expect(open).toHaveBeenCalledWith('/?view=settings&tab=profile', '_blank', 'noopener');
      expect(onRequest).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      setStudioBusy(false);
      expect(requestAccountSettings('profile')).toBe(true);
      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
    }
  });

  it('useSettingsOpenInNewTab follows the busy flag', () => {
    const { result } = renderHook(() => useSettingsOpenInNewTab());
    expect(result.current).toBe(false);
    act(() => setStudioBusy(true));
    expect(result.current).toBe(true);
    act(() => setStudioBusy(false));
    expect(result.current).toBe(false);
  });
});

describe('useAccountSettingsListener', () => {
  it('opens Settings for a known tab with its resume point, and leaves anything else unhandled', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useAccountSettingsListener(handler));
    expect(requestAccountSettings('settings', { resume: 'new-comic' })).toBe(true);
    expect(handler).toHaveBeenLastCalledWith('settings', { resume: 'new-comic' });
    expect(requestAccountSettings('admin')).toBe(true);
    expect(handler).toHaveBeenLastCalledWith('admin', {});
    // A detail from elsewhere on the page with an unknown tab or resume point is never trusted.
    const odd = new CustomEvent(ACCOUNT_SETTINGS_EVENT, { cancelable: true, detail: { tab: 'billing' } });
    expect(window.dispatchEvent(odd)).toBe(true);
    window.dispatchEvent(new CustomEvent(ACCOUNT_SETTINGS_EVENT, { cancelable: true, detail: { tab: 'profile', resume: 'elsewhere' } }));
    expect(handler).toHaveBeenLastCalledWith('profile', {});
    expect(handler).toHaveBeenCalledTimes(3);
    unmount();
    const assign = stubLocation();
    expect(requestAccountSettings('profile')).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});
