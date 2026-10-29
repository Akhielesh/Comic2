// @vitest-environment jsdom
// live/monitor/push.ts (ADR 0006 WS-5): `dev` and `was` on the subscription the rooms get, the
// devId read from WS-6's IndexedDB, and retiring the old dreamstreamstudio.ai/live subscription
// through the same-site bridge only when nothing would go quiet.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_PATH,
  BRIDGE_TAG,
  createLegacyAlerts,
  frameBridge,
  hostAlertFlags,
  legacyCovered,
  readDevId,
  subscriptionExtras,
  withExtras,
  type BridgeAsk,
  type LegacyAlertState,
} from './push';

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const OLD = 'https://fcm.googleapis.com/fcm/send/old-endpoint';
const NEW = 'https://fcm.googleapis.com/fcm/send/new-endpoint';
const DEV = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 chars, b64url

/* ------------------------------------------------------------------ devId */

function fakeIdb(opts: { exists: boolean; stores?: Record<string, Record<string, unknown>> }) {
  const aborted = vi.fn();
  const closed = vi.fn();
  const idb = {
    open: vi.fn(() => {
      const req: Record<string, unknown> & { onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        if (!opts.exists) {
          req.transaction = { abort: aborted };
          req.onupgradeneeded?.();
          req.onerror?.(); // an aborted upgrade fails the open: nothing was created
          return;
        }
        const stores = opts.stores ?? {};
        req.result = {
          objectStoreNames: Object.keys(stores),
          transaction: (name: string) => ({
            objectStore: () => ({
              get: (key: string) => {
                const r: Record<string, unknown> & { onsuccess?: () => void } = {};
                queueMicrotask(() => {
                  r.result = stores[name]?.[key];
                  r.onsuccess?.();
                });
                return r;
              },
            }),
          }),
          close: closed,
        };
        req.onsuccess?.();
      });
      return req;
    }),
  };
  return { idb: idb as unknown as IDBFactory, aborted, closed };
}

describe('readDevId — WS-6’s device id, read-only', () => {
  it('reads ds-keys / device / self', async () => {
    const { idb, closed } = fakeIdb({ exists: true, stores: { device: { self: { devId: DEV, sig: {}, ecdh: {} } }, nmk: {} } });
    expect(await readDevId(idb)).toBe(DEV);
    expect(closed).toHaveBeenCalled();
  });

  it('never creates the database: before WS-6 makes its keys, there is no devId', async () => {
    vi.resetModules();
    const { readDevId: fresh } = await import('./push');
    const { idb, aborted } = fakeIdb({ exists: false });
    expect(await fresh(idb)).toBeNull();
    expect(aborted).toHaveBeenCalled();
  });

  it('ignores anything that is not a devId', async () => {
    vi.resetModules();
    const { readDevId: fresh } = await import('./push');
    const { idb } = fakeIdb({ exists: true, stores: { device: { self: { devId: 'short' } } } });
    expect(await fresh(idb)).toBeNull();
    expect(await fresh(undefined)).toBeNull();
  });
});

/* ---------------------------------------------------- the subscription JSON */

describe('the subscription a room receives', () => {
  const browserSub = {
    endpoint: NEW,
    toJSON: () => ({ endpoint: NEW, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;

  it('carries the devId and the old /live endpoint it replaces', async () => {
    const extra = await subscriptionExtras(NEW, { devId: async () => DEV, legacyEndpoint: async () => OLD });
    expect(extra).toEqual({ dev: DEV, was: OLD });
    const sub = withExtras(browserSub, extra);
    expect(sub.endpoint).toBe(NEW);
    expect(sub.toJSON()).toEqual({ endpoint: NEW, expirationTime: null, keys: { p256dh: 'p', auth: 'a' }, dev: DEV, was: OLD });
    await sub.unsubscribe();
    expect(browserSub.unsubscribe).toHaveBeenCalled();
  });

  it('adds nothing it doesn’t know, and never "replaces" itself', async () => {
    expect(await subscriptionExtras(NEW, { devId: async () => null, legacyEndpoint: async () => null })).toEqual({});
    expect(await subscriptionExtras(NEW, { devId: async () => null, legacyEndpoint: async () => NEW })).toEqual({});
    expect(await subscriptionExtras(NEW, { devId: async () => { throw new Error('idb'); }, legacyEndpoint: async () => { throw new Error('frame'); } })).toEqual({});
  });
});

/* -------------------------------------------------------- coverage rules */

describe('legacyCovered — the old subscription goes only when nothing would go quiet', () => {
  const legacy: LegacyAlertState = { endpoint: OLD, nids: [A, B], ring: true, owner: 'u1' };
  const host = { uid: 'u1', nids: [A, B], ring: true, subscribed: true };

  it('covered: same account, every nursery and ringing moved, a live subscription here', () => {
    expect(legacyCovered(legacy, host)).toBe(true);
  });

  it('kept while any nursery still alerts only through it', () => {
    expect(legacyCovered(legacy, { ...host, nids: [A] })).toBe(false);
  });

  it('kept while ringing still comes only through it', () => {
    expect(legacyCovered(legacy, { ...host, ring: false })).toBe(false);
  });

  it('kept without a subscription here, for another account’s data, or when there is none', () => {
    expect(legacyCovered(legacy, { ...host, subscribed: false })).toBe(false);
    expect(legacyCovered(legacy, { ...host, uid: 'u2' })).toBe(false);
    expect(legacyCovered({ ...legacy, endpoint: null }, host)).toBe(false);
  });

  it('reads this host’s own opt-ins (not their prefs)', () => {
    localStorage.clear();
    localStorage.setItem(`ds-monitor-push-${A}`, '1');
    localStorage.setItem(`ds-monitor-push-${A}-prefs`, '{"cry":true}');
    localStorage.setItem(`ds-monitor-push-${B}`, '0');
    localStorage.setItem('ds-call-ring', '1');
    expect(hostAlertFlags()).toEqual({ nids: [A], ring: true });
    localStorage.clear();
  });
});

/* ----------------------------------------------------- retire / reconcile */

function fakeAsk(state: LegacyAlertState | null, retireReply: Record<string, unknown> = { ok: true, endpoint: OLD }) {
  return vi.fn<BridgeAsk>(async (op) => (op === 'state' ? (state ? { ok: true, ...state } : null) : retireReply));
}

describe('createLegacyAlerts', () => {
  it('does nothing at all off Stream Studio’s own host', async () => {
    const ask = fakeAsk({ endpoint: OLD, nids: [], ring: false, owner: 'u1' });
    const l = createLegacyAlerts({ onStreamHost: false, ask });
    expect(await l.endpoint()).toBeNull();
    expect(await l.reconcile({ uid: 'u1', nids: [], ring: false, subscribed: true })).toBe('none');
    expect(await l.retire('account', 'u1', 'signout')).toEqual({ ok: true, endpoint: null });
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks the bridge once per page for the old endpoint', async () => {
    const ask = fakeAsk({ endpoint: OLD, nids: [A], ring: false, owner: 'u1' });
    const l = createLegacyAlerts({ onStreamHost: true, ask });
    expect(await l.endpoint()).toBe(OLD);
    expect(await l.endpoint()).toBe(OLD);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('keeps it while a nursery still depends on it; retires it once this host covers everything', async () => {
    const ask = fakeAsk({ endpoint: OLD, nids: [A, B], ring: false, owner: 'u1' });
    const l = createLegacyAlerts({ onStreamHost: true, ask });
    expect(await l.reconcile({ uid: 'u1', nids: [A], ring: false, subscribed: true })).toBe('kept');
    expect(ask).not.toHaveBeenCalledWith('retire', expect.anything());
    expect(await l.reconcile({ uid: 'u1', nids: [A, B], ring: false, subscribed: true })).toBe('retired');
    expect(ask).toHaveBeenCalledWith('retire', { scope: 'alerts', uid: 'u1', reason: 'covered' });
  });

  it('signing out here retires it with the account’s data — the bridge refuses another account’s', async () => {
    const ask = fakeAsk({ endpoint: OLD, nids: [A], ring: false, owner: 'u1' });
    const l = createLegacyAlerts({ onStreamHost: true, ask });
    expect(await l.retire('account', 'u1', 'signout')).toEqual({ ok: true, endpoint: OLD });
    expect(ask).toHaveBeenCalledWith('retire', { scope: 'account', uid: 'u1', reason: 'signout' });
    const refused = createLegacyAlerts({ onStreamHost: true, ask: fakeAsk(null, { ok: false, error: 'other_account' }) });
    expect(await refused.retire('account', 'u2', 'signout')).toEqual({ ok: false, endpoint: null, error: 'other_account' });
  });

  it('no answer from the bridge (storage isolated, offline) changes nothing', async () => {
    const ask = vi.fn<BridgeAsk>(async () => null);
    const l = createLegacyAlerts({ onStreamHost: true, ask });
    expect(await l.endpoint()).toBeNull();
    expect(await l.reconcile({ uid: 'u1', nids: [A], ring: true, subscribed: true })).toBe('none');
    expect(await l.retire('account', 'u1', 'signout')).toEqual({ ok: false, error: 'no_answer' });
  });

  it('a malformed answer is treated as no subscription', async () => {
    const ask = vi.fn<BridgeAsk>(async () => ({ ok: true, endpoint: 'javascript:alert(1)', nids: ['../x', A], ring: 'yes' }));
    const l = createLegacyAlerts({ onStreamHost: true, ask });
    expect(await l.state()).toEqual({ endpoint: null, nids: [A], ring: false, owner: null });
  });
});

/* -------------------------------------------------------- the hidden frame */

describe('frameBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('loads the apex bridge in a hidden frame, asks once it has loaded, and takes only its answer', async () => {
    const ask = frameBridge('https://dreamstreamstudio.ai', 4000);
    const pending = ask('state');
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe(`https://dreamstreamstudio.ai${BRIDGE_PATH}`);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    frame.dispatchEvent(new Event('load'));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ds: BRIDGE_TAG, v: 1, op: 'state' }), 'https://dreamstreamstudio.ai');
    const id = (post.mock.calls[0][0] as { id: string }).id;
    // Someone else's message, or the right shape from the wrong origin: ignored.
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', source: frame.contentWindow, data: { ds: BRIDGE_TAG, id, ok: true, endpoint: 'https://evil' } }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://dreamstreamstudio.ai', source: window, data: { ds: BRIDGE_TAG, id, ok: true, endpoint: 'https://evil' } }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://dreamstreamstudio.ai', source: frame.contentWindow, data: { ds: BRIDGE_TAG, id, ok: true, endpoint: OLD, nids: [], ring: false, owner: null } }));
    await expect(pending).resolves.toMatchObject({ ok: true, endpoint: OLD });
    expect(document.querySelector('iframe')).toBeNull(); // removed once answered
  });

  it('gives up quietly when the bridge never answers', async () => {
    vi.useFakeTimers();
    const pending = frameBridge('https://dreamstreamstudio.ai', 4000)('state');
    await vi.advanceTimersByTimeAsync(4001);
    await expect(pending).resolves.toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
