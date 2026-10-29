// @vitest-environment jsdom
// live/monitor/push.ts reconcileLegacyAlerts on Stream Studio's own host (ADR 0006 WS-5): the
// start-up check loads the apex bridge only while the old address might still have something to
// end; turning alerts on (and signing out) always asks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../host', () => ({ ON_STREAM_HOST: true, LIVE_SW_SCOPE: '/', LIVE_APP_PATH: '/' }));
vi.mock('../account', () => ({ getAccount: () => ({ userId: 'u1' }) }));

import { BRIDGE_TAG, LEGACY_CLEAR_KEY, LEGACY_RECHECK_MS, legacyRecentlyClear, reconcileLegacyAlerts } from './push';

const APEX = 'https://dreamstreamstudio.ai';
const DAY = 24 * 3600_000;

/** Answer the bridge frame's next question as the apex page would. */
function answerBridge(reply: Record<string, unknown>) {
  const frame = document.querySelector('iframe');
  if (!frame) throw new Error('no bridge frame');
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((msg: unknown) => {
    const d = msg as { id: string };
    queueMicrotask(() =>
      window.dispatchEvent(new MessageEvent('message', { origin: APEX, source: frame.contentWindow, data: { ds: BRIDGE_TAG, id: d.id, ...reply } })),
    );
  });
  frame.dispatchEvent(new Event('load'));
  return post;
}

async function frameAppears(): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (document.querySelector('iframe')) return true;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  return false;
}

beforeEach(() => {
  localStorage.clear();
  // A browser with push, and this host's own subscription.
  Object.defineProperty(window, 'PushManager', { value: function PushManager() {}, configurable: true });
  Object.defineProperty(window, 'Notification', { value: { permission: 'granted' }, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new' }) } }) },
    configurable: true,
  });
});
afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('legacyRecentlyClear', () => {
  it('is a week-long hint, ignored when missing, garbled or from the future', () => {
    const now = 1_800_000_000_000;
    const at = (v: string | null) => ({ getItem: () => v }) as unknown as Storage;
    expect(legacyRecentlyClear(now, at(null))).toBe(false);
    expect(legacyRecentlyClear(now, at('nope'))).toBe(false);
    expect(legacyRecentlyClear(now, at(String(now - DAY)))).toBe(true);
    expect(legacyRecentlyClear(now, at(String(now - LEGACY_RECHECK_MS - 1)))).toBe(false);
    expect(legacyRecentlyClear(now, at(String(now + DAY)))).toBe(false);
    expect(legacyRecentlyClear(now, { getItem: () => { throw new Error('blocked'); } } as unknown as Storage)).toBe(false);
  });
});

describe('reconcileLegacyAlerts on the stream host', () => {
  it('asks the bridge at start-up; nothing left there → remembered, and the next start-up skips the frame', async () => {
    const pending = reconcileLegacyAlerts('u1', { startup: true });
    expect(await frameAppears()).toBe(true);
    answerBridge({ ok: true, endpoint: null, nids: [], ring: false, owner: null });
    await expect(pending).resolves.toBe('none');
    expect(Number(localStorage.getItem(LEGACY_CLEAR_KEY))).toBeGreaterThan(0);

    await expect(reconcileLegacyAlerts('u1', { startup: true })).resolves.toBe('none');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('an old subscription still in use is kept — and checked again next start-up', async () => {
    localStorage.setItem('ds-monitor-push-11111111-2222-4333-8444-555555555555', '1');
    vi.resetModules();
    const fresh = await import('./push');
    const pending = fresh.reconcileLegacyAlerts('u1', { startup: true });
    expect(await frameAppears()).toBe(true);
    // The old address alerts for a nursery this host hasn't taken over yet.
    answerBridge({ ok: true, endpoint: 'https://fcm.googleapis.com/fcm/send/old', nids: ['66666666-7777-4888-8999-aaaaaaaaaaaa'], ring: false, owner: 'u1' });
    await expect(pending).resolves.toBe('kept');
    expect(localStorage.getItem(LEGACY_CLEAR_KEY)).toBeNull();
  });

  it('turning alerts on asks even while the hint is fresh', async () => {
    localStorage.setItem(LEGACY_CLEAR_KEY, String(Date.now()));
    vi.resetModules();
    const fresh = await import('./push');
    const pending = fresh.reconcileLegacyAlerts('u1');
    expect(await frameAppears()).toBe(true);
    answerBridge({ ok: true, endpoint: null, nids: [], ring: false, owner: null });
    await expect(pending).resolves.toBe('none');
  });

  it('no answer from the bridge proves nothing: no hint is stored', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const fresh = await import('./push');
      const pending = fresh.reconcileLegacyAlerts('u1', { startup: true });
      await vi.advanceTimersByTimeAsync(4100);
      await expect(pending).resolves.toBe('none');
      expect(localStorage.getItem(LEGACY_CLEAR_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
