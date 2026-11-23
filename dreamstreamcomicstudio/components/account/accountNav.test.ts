// @vitest-environment jsdom
// The one way to the DreamStream settings (navtheme NT-1): a request App answers in the app, a page load when nothing
// answers, and repeated presses within a single tab.
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_SETTINGS_EVENT,
  accountSettingsHref,
  requestAccountSettings,
  useAccountSettingsListener
} from './accountNav';

const realLocation = window.location;
const stubLocation = () => {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
  return assign;
};

afterEach(() => {
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

  it('repeated requests stay in the same tab', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onRequest = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
    try {
      expect(requestAccountSettings('profile')).toBe(true);
      expect(requestAccountSettings('profile')).toBe(true);
      expect(open).not.toHaveBeenCalled();
      expect(onRequest).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
    }
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
