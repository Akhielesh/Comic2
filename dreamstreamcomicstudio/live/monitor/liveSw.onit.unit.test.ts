// @vitest-environment node
// The service worker's "I'm on it" (public/live-sw.js, ADR 0006 WS-5): the fetch built from a
// sample push payload, the acknowledgement that never opens the app, the alert put back when it
// can't be marked, and the quiet replacement push that takes an alert's place.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const SW = readFileSync(new URL('../../public/live-sw.js', import.meta.url), 'utf8');

const NID = '11111111-2222-4333-8444-555555555555';
const ACT = 'a1.0f8e7d6c-5b4a-4321-8fed-cba987654321.1798000000.' + 'm'.repeat(43);
/** What the room sends (monitorRoom pushAlert + WS-9's act/inc/q). */
const CRY = { title: 'Crying in the Nursery', body: 'Crying for 30 s — tap to listen.', kind: 'cry', nid: NID, ref: 'e1', inc: 'inc-42', act: ACT, q: 7, at: 1_790_000_000_000 };

type Shown = { title: string; opts: Record<string, unknown> & { data: Record<string, unknown>; actions: { action: string; title: string }[] } };

function loadSW(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, scope = 'https://stream.dreamstreamstudio.ai/') {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: Shown[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const fetchMock = vi.fn(fetchImpl);
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => void (listeners[t] = fn),
    clients: { matchAll: async () => [], openWindow: async (u: string) => void opened.push(u), claim: async () => undefined },
    location: { origin: new URL(scope).origin },
    registration: {
      scope,
      showNotification: async (title: string, opts: Shown['opts']) => void shown.push({ title, opts }),
      // What's on screen now: the latest notification per tag.
      getNotifications: async () => {
        const byTag = new Map<string, Shown>();
        for (const n of shown) byTag.set(String(n.opts.tag), n);
        return [...byTag.values()].map((n) => ({ tag: n.opts.tag, data: n.opts.data, close: () => void closed.push(String(n.opts.tag)) }));
      },
    },
    skipWaiting: () => undefined,
  };
  const store = new Map<string, string>();
  const caches = {
    open: async () => ({
      match: async (k: string) => (store.has(k) ? new Response(store.get(k)!) : undefined),
      put: async (k: string, r: Response) => void store.set(k, await r.text()),
      delete: async (k: string) => store.delete(k),
      keys: async () => [],
    }),
  };
  new Function('self', 'caches', 'fetch', SW)(self, caches, fetchMock);
  const push = async (data: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.push({ data: { json: () => data }, waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
    return shown.at(-1)!;
  };
  const click = async (action: string, n: Shown) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.notificationclick({ action, notification: { close: () => undefined, tag: n.opts.tag, data: n.opts.data }, waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
    return shown.at(-1)!;
  };
  const message = async (data: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.message({ data, waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
  };
  return { push, click, message, shown, opened, closed, fetchMock };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('"I’m on it" on an alert notification', () => {
  it('appears when the push carries an action token, next to "Watch now"', async () => {
    const sw = loadSW(async () => json({ ok: true }));
    const n = await sw.push(CRY);
    expect(n.title).toBe('👶 Crying in the Nursery');
    expect(n.opts.actions.map((a) => a.action)).toEqual(['onit', 'watch']);
    expect(n.opts.requireInteraction).toBe(true);
    expect(n.opts.tag).toBe(`${NID}-cry`);
  });

  it('never appears without a valid token, nursery and incident — or on calls and tests', async () => {
    const sw = loadSW(async () => json({ ok: true }));
    for (const data of [
      { ...CRY, act: undefined },
      { ...CRY, act: 'not-a-token' },
      { ...CRY, inc: null },
      { ...CRY, nid: '../../api/x' },
      { ...CRY, kind: 'test' },
      { kind: 'call', nid: NID, call: 'abcdef0123', act: ACT, inc: 'inc-1', title: 'Mum' },
    ]) {
      const n = await sw.push(data);
      expect(n.opts.actions.some((a) => a.action === 'onit'), JSON.stringify(data)).toBe(false);
    }
  });

  it('acknowledges with the fetch built from the payload, and does not open the app', async () => {
    const sw = loadSW(async () => json({ ok: true, g: {} }));
    const n = await sw.push(CRY);
    const after = await sw.click('onit', n);
    expect(sw.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = sw.fetchMock.mock.calls[0];
    expect(url).toBe(`https://stream.dreamstreamstudio.ai/live-api/api/monitor/${NID}/act`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`DS-Act ${ACT}`);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.credentials).toBe('omit');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ a: 'ack', inc: 'inc-42' });
    expect(body.id).toMatch(/^[0-9a-f]{24}$/); // the room dedupes a repeated tap by id
    expect(sw.opened).toEqual([]);
    // The alert is replaced in place by a quiet confirmation.
    expect(after.title).toBe('✅ You’re on it');
    expect(after.opts.tag).toBe(`${NID}-cry`);
    expect(after.opts.silent).toBe(true);
    expect(after.opts.requireInteraction).toBe(false);
    expect(after.opts.body).toMatch(/Crying in the Nursery — marked as yours/);
  });

  it('one alert, one acknowledgement id: a retry after a lost answer is recognised by the room, never reported as a failure', async () => {
    // The first POST reached the room but the answer was lost; the retry must carry the SAME id
    // so the room answers "already marked" instead of refusing the spent token.
    let first = true;
    const sw = loadSW(async () => {
      if (first) {
        first = false;
        throw new TypeError('Failed to fetch');
      }
      return json({ ok: true, already: true });
    });
    const n = await sw.push(CRY);
    const back = await sw.click('onit', n);
    expect(back.opts.actions.map((a) => a.action)).toContain('onit');
    const after = await sw.click('onit', back);
    const ids = sw.fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)).id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f]{24}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(after.title).toBe('✅ You’re on it');
    // A different alert gets its own id.
    const other = await sw.push({ ...CRY, inc: 'inc-43', tag: 'other' });
    await sw.click('onit', other);
    expect(JSON.parse(String(sw.fetchMock.mock.calls[2][1].body)).id).not.toBe(ids[0]);
  });

  it('offline: the alert comes straight back, still urgent, with "I’m on it" to try again', async () => {
    const sw = loadSW(async () => {
      throw new TypeError('Failed to fetch');
    });
    const n = await sw.push(CRY);
    const back = await sw.click('onit', n);
    expect(back.title).toBe('👶 Crying in the Nursery');
    expect(back.opts.tag).toBe(`${NID}-cry`);
    expect(back.opts.requireInteraction).toBe(true);
    expect(back.opts.body).toMatch(/^Couldn’t reach the monitor to mark this/);
    expect(back.opts.body).toMatch(/Crying for 30 s/);
    expect(back.opts.actions.map((a) => a.action)).toEqual(['onit', 'watch']);
    expect(sw.opened).toEqual([]);
  });

  it('a refused or expired token: the alert comes back without a retry that can’t work', async () => {
    const sw = loadSW(async () => json({ ok: false, error: 'expired' }, 401));
    const n = await sw.push(CRY);
    const back = await sw.click('onit', n);
    expect(back.opts.body).toMatch(/can’t be marked from here any more — open the monitor/);
    expect(back.opts.actions.map((a) => a.action)).toEqual(['watch']);
    expect(back.opts.requireInteraction).toBe(true);
  });

  it('"Watch now" still opens the monitor', async () => {
    const sw = loadSW(async () => json({ ok: true }));
    const n = await sw.push(CRY);
    await sw.click('watch', n);
    expect(sw.fetchMock).not.toHaveBeenCalled();
    expect(sw.opened).toEqual([`https://stream.dreamstreamstudio.ai/#/monitor/${NID}/watch`]);
  });
});

describe('signing out on this device', () => {
  it('closes the alerts on screen, and “I’m on it” on one that arrived before can no longer act for the signed-out parent', async () => {
    const sw = loadSW(async () => json({ ok: true }));
    const n = await sw.push(CRY);
    await sw.message({ t: 'ds-signed-out' });
    expect(sw.closed).toContain(`${NID}-cry`);
    // (A notification that somehow stayed — e.g. shown on another screen — is tapped.)
    const after = await sw.click('onit', n);
    expect(sw.fetchMock).not.toHaveBeenCalled();
    expect(after.opts.body).toMatch(/signed out on this device/);
    expect(after.opts.actions).toEqual([]);
    expect(JSON.stringify(after.opts.data)).not.toContain(ACT); // the token isn't carried on
  });

  it('after signing in again, a new alert acts as normal', async () => {
    const sw = loadSW(async () => json({ ok: true }));
    await sw.message({ t: 'ds-signed-out' });
    await new Promise((r) => setTimeout(r, 5));
    const n = await sw.push(CRY);
    const after = await sw.click('onit', n);
    expect(sw.fetchMock).toHaveBeenCalledOnce();
    expect(after.title).toBe('✅ You’re on it');
  });
});

describe('the acknowledgement replacement push', () => {
  it('replaces the alert (same tag) quietly: no sound, no buzz, not held on screen', async () => {
    const sw = loadSW(async () => json({ ok: true }));
    await sw.push(CRY);
    // live-worker push/router.ts replacementOf(): the alert's payload minus `act`, kind 'ack'.
    const { act: _act, ...rest } = CRY;
    const r = await sw.push({ ...rest, title: 'Dad’s on it', body: 'Crying in the Nursery', tag: `${NID}-cry`, kind: 'ack', of: 'cry', replace: true });
    expect(r.title).toBe('✅ Dad’s on it');
    expect(r.opts.tag).toBe(`${NID}-cry`);
    expect(r.opts.silent).toBe(true);
    expect(r.opts.renotify).toBe(false);
    expect(r.opts.requireInteraction).toBe(false);
    expect(r.opts.vibrate).toBeUndefined();
    expect(r.opts.actions.map((a) => a.action)).toEqual(['watch']);
  });

  it('a replacement without its own tag still lands on the alert it replaces', async () => {
    const sw = loadSW(async () => json({ ok: true }));
    const r = await sw.push({ title: 'Mum’s on it', body: 'x', kind: 'ack', of: 'alarm', nid: NID, replace: true });
    expect(r.opts.tag).toBe(`${NID}-alarm`);
  });
});
