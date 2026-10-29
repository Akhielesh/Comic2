// @vitest-environment node
// public/stream-alerts-bridge.js — the page on dreamstreamstudio.ai that ends this browser's old
// /live alert subscription for Stream Studio's own host (ADR 0006 WS-5; INFRA_MAP §2a).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const SRC = readFileSync(new URL('../../public/stream-alerts-bridge.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../public/stream-alerts-bridge.html', import.meta.url), 'utf8');
const PURGE_SRC = readFileSync(new URL('../accountPurge.ts', import.meta.url), 'utf8');

const STREAM = 'https://stream.dreamstreamstudio.ai';
const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const OLD = 'https://fcm.googleapis.com/fcm/send/old-endpoint';

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  keys() {
    return [...this.m.keys()].sort();
  }
}

function loadBridge(opts: { scope?: string; endpoint?: string | null; framed?: boolean } = {}) {
  const storage = new MemoryStorage();
  const unsubscribe = vi.fn(async () => true);
  const sub = opts.endpoint === null ? null : { endpoint: opts.endpoint ?? OLD, unsubscribe };
  const reg = { scope: opts.scope ?? 'https://dreamstreamstudio.ai/live', pushManager: { getSubscription: async () => sub } };
  const getRegistration = vi.fn(async () => reg);
  const parent = { postMessage: vi.fn() };
  let onMessage: ((e: unknown) => void) | null = null;
  const win: Record<string, unknown> = {
    localStorage: storage,
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      if (t === 'message') onMessage = fn;
    },
  };
  win.parent = opts.framed === false ? win : parent;
  new Function('window', 'navigator', SRC)(win, { serviceWorker: { getRegistration } });
  const send = async (data: Record<string, unknown>, from: { origin?: string; source?: unknown } = {}) => {
    parent.postMessage.mockClear();
    onMessage!({ origin: from.origin ?? STREAM, source: 'source' in from ? from.source : parent, data: { ds: 'ds-alerts-bridge', v: 1, id: 'q1', ...data } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return parent.postMessage.mock.calls[0] as [Record<string, unknown>, string] | undefined;
  };
  return { storage, unsubscribe, getRegistration, send, parent };
}

function seed(s: MemoryStorage, owner = 'u1') {
  s.setItem('ds-live-owner', owner);
  s.setItem(`ds-monitor-push-${A}`, '1');
  s.setItem(`ds-monitor-push-${A}-prefs`, '{"cry":true}');
  s.setItem(`ds-monitor-push-${B}`, '1');
  s.setItem('ds-call-ring', '1');
  s.setItem('ds-live-my-events', '[{"id":"e1","hostKey":"secret"}]');
  s.setItem(`ds-monitor-zones-${A}`, '[]');
  s.setItem('ds-usage-2026-10', '{}');
  // The main app's own keys on the same origin: never touched.
  s.setItem('dreamstream_auth_token', '{"session":"main-app"}');
  s.setItem('ds-theme', 'dark');
}

describe('the bridge page', () => {
  it('is a bare page: no inline script, no UI', () => {
    expect(HTML).toMatch(/<script src="\/stream-alerts-bridge\.js" defer><\/script>/);
    expect(HTML).not.toMatch(/<script>(?!<)/);
    expect(HTML).toMatch(/noindex/);
  });
});

describe('who it answers', () => {
  it('only Stream Studio’s host, only its parent, only in a frame', async () => {
    const b = loadBridge();
    seed(b.storage);
    expect(await b.send({ op: 'state' }, { origin: 'https://evil.example' })).toBeUndefined();
    expect(await b.send({ op: 'state' }, { origin: 'https://dreamstreamstudio.ai' })).toBeUndefined();
    expect(await b.send({ op: 'state' }, { source: {} })).toBeUndefined();
    expect(await b.send({ op: 'retire', uid: 'u1', scope: 'account' }, { origin: 'https://evil.example' })).toBeUndefined();
    expect(b.unsubscribe).not.toHaveBeenCalled();
    const top = loadBridge({ framed: false });
    seed(top.storage);
    expect(await top.send({ op: 'state' })).toBeUndefined();
  });

  it('replies to the asking origin with the same id', async () => {
    const b = loadBridge();
    const [reply, origin] = (await b.send({ op: 'state' }))!;
    expect(origin).toBe(STREAM);
    expect(reply).toMatchObject({ ds: 'ds-alerts-bridge', id: 'q1', ok: true });
  });
});

describe('state', () => {
  it('reports the old subscription, the nurseries it alerts for, ringing and whose data it is', async () => {
    const b = loadBridge();
    seed(b.storage);
    b.storage.setItem('ds-monitor-push-not-a-nursery', '1');
    const [reply] = (await b.send({ op: 'state' }))!;
    expect(reply).toMatchObject({ ok: true, endpoint: OLD, ring: true, owner: 'u1' });
    expect((reply.nids as string[]).sort()).toEqual([A, B].sort());
    expect(b.getRegistration).toHaveBeenCalledWith('/live');
  });

  it('never reports another registration of this site as the old one', async () => {
    const b = loadBridge({ scope: 'https://dreamstreamstudio.ai/' });
    const [reply] = (await b.send({ op: 'state' }))!;
    expect(reply.endpoint).toBeNull();
  });
});

describe('retire', () => {
  it('alerts: unsubscribes and clears the alert opt-ins, nothing else', async () => {
    const b = loadBridge();
    seed(b.storage);
    const [reply] = (await b.send({ op: 'retire', scope: 'alerts', uid: 'u1', reason: 'covered' }))!;
    expect(reply).toMatchObject({ ok: true, endpoint: OLD });
    expect(b.unsubscribe).toHaveBeenCalledOnce();
    expect(b.storage.keys()).toEqual(['dreamstream_auth_token', 'ds-live-my-events', 'ds-live-owner', `ds-monitor-zones-${A}`, 'ds-theme', 'ds-usage-2026-10']);
  });

  it('account (signing out on the new host): the account’s Stream Studio data goes too — the main app’s stays', async () => {
    const b = loadBridge();
    seed(b.storage);
    const [reply] = (await b.send({ op: 'retire', scope: 'account', uid: 'u1', reason: 'signout' }))!;
    expect(reply).toMatchObject({ ok: true, endpoint: OLD });
    expect(b.storage.keys()).toEqual(['dreamstream_auth_token', 'ds-theme']);
  });

  it('never for another account, and never without knowing whose sign-out it is', async () => {
    const b = loadBridge();
    seed(b.storage, 'someone-else');
    expect((await b.send({ op: 'retire', scope: 'account', uid: 'u1' }))![0]).toMatchObject({ ok: false, error: 'other_account' });
    expect((await b.send({ op: 'retire', scope: 'alerts' }))![0]).toMatchObject({ ok: false, error: 'no_account' });
    expect(b.unsubscribe).not.toHaveBeenCalled();
    expect(b.storage.getItem(`ds-monitor-push-${A}`)).toBe('1');
  });

  it('with no old subscription it still clears stale opt-ins', async () => {
    const b = loadBridge({ endpoint: null });
    seed(b.storage);
    const [reply] = (await b.send({ op: 'retire', scope: 'alerts', uid: 'u1' }))!;
    expect(reply).toEqual({ ok: true, endpoint: null, ds: 'ds-alerts-bridge', id: 'q1' });
    expect(b.storage.getItem('ds-call-ring')).toBeNull();
  });
});

describe('kept in step with live/accountPurge.ts', () => {
  const list = (src: string, name: string) => {
    const m = new RegExp(`(?:const|var) ${name} = \\[([\\s\\S]*?)\\];`).exec(src);
    if (!m) throw new Error(`${name} not found`);
    return [...m[1].matchAll(/'([^']+)'|\b(OWNER_KEY)\b/g)].map((x) => (x[2] ? 'ds-live-owner' : x[1])).sort();
  };

  it('purges exactly what signing out of Stream Studio purges', () => {
    expect(PURGE_SRC).toMatch(/OWNER_KEY = 'ds-live-owner'/);
    expect(list(SRC, 'EXACT')).toEqual(list(PURGE_SRC, 'EXACT'));
    expect(list(SRC, 'PREFIXES')).toEqual(list(PURGE_SRC, 'PREFIXES'));
  });
});
