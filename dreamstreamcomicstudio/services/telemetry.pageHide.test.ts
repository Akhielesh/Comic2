// @vitest-environment jsdom
// The page-hide flush (abuse-ops-3 follow-up). The server keeps only warn and above from a
// signed-out sender, so a signed-in tab's last events — info ones such as chat_turn, which feed
// the Auto model ranking and the admin chat-performance view — must leave with the account's
// bearer token (a keepalive fetch), not as an anonymous sendBeacon. Signed out, sendBeacon stays.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('./apiClient', () => ({ getCachedAuthToken: () => h.token, post: vi.fn(async () => ({ ok: true })) }));
vi.mock('./clientConfig', () => ({ buildApiUrl: (path: string) => `https://app.test${path}` }));

import { captureEvent, initTelemetry } from './telemetry';

const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
const beacon = vi.fn((_url: string, _data: Blob) => true);
const hide = () => window.dispatchEvent(new Event('pagehide'));
const chatTurn = (i: number, metadata: Record<string, unknown> = {}) =>
  captureEvent({ eventType: 'chat_turn', severity: 'info', source: 'ai_chat', metadata: { model: 'm', i, ...metadata } });
const sentEvents = (init: RequestInit) => (JSON.parse(String(init.body)) as { events: { eventType: string }[] }).events;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  beacon.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true });
  initTelemetry(); // idempotent: the listeners are installed once
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('page-hide flush', () => {
  it('signed in: keepalive fetches with the bearer token, in batches of 50, and no anonymous beacon', () => {
    h.token = 'tok-1';
    for (let i = 0; i < 70; i++) chatTurn(i);
    hide();
    expect(beacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://app.test/api/telemetry/events');
      expect(init).toMatchObject({ method: 'POST', keepalive: true });
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    }
    const [first, second] = fetchMock.mock.calls.map(([, init]) => sentEvents(init));
    expect([first.length, second.length]).toEqual([50, 20]);
    expect(first.every((e) => e.eventType === 'chat_turn')).toBe(true);
    // The queue left with the page: a second hide sends nothing.
    hide();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('signed in, past the keepalive quota: the rest goes by beacon rather than being lost', () => {
    h.token = 'tok-1';
    for (let i = 0; i < 100; i++) chatTurn(i, { pad: 'x'.repeat(900) });
    hide();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('signed out: one sendBeacon, no fetch', () => {
    h.token = undefined;
    chatTurn(1);
    hide();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe('https://app.test/api/telemetry/events');
  });
});
