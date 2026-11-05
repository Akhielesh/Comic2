// @vitest-environment jsdom
// The login sync when the account snapshot cannot be read. Right after a sign-out → sign-in
// (or an account switch, or a first sign-in on a device) AuthContext has just purged the local
// state, so a read that fails must never count as "no snapshot": the empty local state would
// be PUT over the account's keys, settings, chat memory and custom agents, for good. Real
// apiKeys / appSettings / chatStorage / localOwner; only the HTTP layer (apiClient) is faked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Settings = { mode: 'ok' | 'none' | 'throw' | 'body'; status?: number; body?: unknown };
const net = vi.hoisted(() => ({
  settings: { mode: 'ok' } as Settings,
  puts: [] as { path: string; data: Record<string, unknown> }[],
  cloud: {
    version: 2,
    keys: [{ id: 'k1', provider: 'openai', label: 'OpenAI', key: 'sk-real-cloud-key', active: true, limitUsd: null, usedUsd: 0, periodStart: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }],
    settings: {},
    modelKeys: {},
    imageModelId: null,
    chat: { memory: '- Likes noir', agents: [{ id: 'agent-1', name: 'Inker', prompt: 'ink' }] },
  } as Record<string, unknown>,
}));

vi.mock('./apiClient', () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    get: vi.fn(async (path: string) => {
      if (path !== '/api/account/settings') return { ok: true, keys: [] };
      const s = net.settings;
      if (s.mode === 'throw') throw new ApiError('failed', s.status ?? 0);
      if (s.mode === 'body') return s.body;
      if (s.mode === 'none') return { ok: true, data: null };
      return { ok: true, data: net.cloud };
    }),
    put: vi.fn(async (path: string, body: { data: Record<string, unknown> }) => {
      net.puts.push({ path, data: body.data });
      return { ok: true, persisted: true };
    }),
  };
});

import { CLOUD_SYNC_READ_FAILED_NOTICE, pushCloudSnapshot, readCloudSnapshot, reconcileOnLogin, syncOnLogin } from './cloudSync';
import { setLocalOwner } from './localOwner';
import { addKey, listKeys } from './apiKeys';
import { getChatMemory } from './chatStorage';
import { listCustomAgents } from './chatAgents';
import { appStatus } from './appStatus';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const settingsPuts = () => net.puts.filter((p) => p.path === '/api/account/settings');
const pushed = (needle: string) => settingsPuts().some((p) => JSON.stringify(p.data).includes(needle));

beforeEach(() => {
  localStorage.clear();
  appStatus.clear();
  net.puts = [];
  net.settings = { mode: 'ok' };
  // AuthContext.onSignedIn: the purge already ran, the owner marker is set, then the sync starts.
  setLocalOwner(A);
  expect(listKeys()).toEqual([]);
});

describe('reconcileOnLogin — a read that fails never writes', () => {
  const failures: [string, Settings][] = [
    ['the request never got through (status 0)', { mode: 'throw', status: 0 }],
    ['a 502 from the proxy while the backend wakes', { mode: 'throw', status: 502 }],
    ['a 429', { mode: 'throw', status: 429 }],
    ['an answer that is not ok', { mode: 'body', body: { ok: false, data: null } }],
    ['a row the server cannot read (reason: unreadable)', { mode: 'body', body: { ok: true, data: null, reason: 'unreadable' } }],
    ['a snapshot version this build does not know', { mode: 'body', body: { ok: true, data: { version: 3, keys: [] } } }],
  ];
  for (const [label, settings] of failures) {
    it(`${label}: nothing is pushed or applied, and the sync says it failed`, async () => {
      net.settings = settings;
      expect(await reconcileOnLogin(A)).toBe('failed');
      // Without the fix: one PUT carrying keys: [], memory '', agents [] — the account's copy gone.
      expect(settingsPuts()).toHaveLength(0);
      expect(listKeys()).toEqual([]);
    });
  }

  it('tells the person that nothing was changed — except for a backend without account storage', async () => {
    net.settings = { mode: 'throw', status: 503 };
    await reconcileOnLogin(A);
    expect(appStatus.getSnapshot().events[0]).toMatchObject({ level: 'warn', message: CLOUD_SYNC_READ_FAILED_NOTICE, detail: 'http_503' });
    appStatus.clear();
    net.settings = { mode: 'body', body: { ok: true, data: null, reason: 'storage_disabled' } };
    expect(await reconcileOnLogin(A)).toBe('failed');
    expect(settingsPuts()).toHaveLength(0);
    expect(appStatus.getSnapshot().events).toEqual([]);
  });

  it('a change made after a failed read stays local until the account has been read — then the merge carries it', async () => {
    net.settings = { mode: 'throw', status: 502 };
    await reconcileOnLogin(A);
    addKey({ provider: 'openai', key: 'sk-typed-after-failed-read' });
    await pushCloudSnapshot(A); // what the debounced push does 1.5 s after a change
    expect(settingsPuts()).toHaveLength(0);

    // The next run reads the account: its key, memory and agent come back, the typed key is kept, the merge is pushed.
    net.settings = { mode: 'ok' };
    expect(await reconcileOnLogin(A)).toBe('synced');
    expect(listKeys().map((k) => k.key).sort()).toEqual(['sk-real-cloud-key', 'sk-typed-after-failed-read']);
    expect(getChatMemory(A)).toContain('Likes noir');
    expect(listCustomAgents(A).map((a) => a.id)).toEqual(['agent-1']);
    expect(settingsPuts()).toHaveLength(1);
    expect(pushed('sk-real-cloud-key')).toBe(true);
    expect(pushed('sk-typed-after-failed-read')).toBe(true);

    // From then on local changes push again.
    net.puts = [];
    await pushCloudSnapshot(A);
    expect(settingsPuts()).toHaveLength(1);
  });
});

describe('reconcileOnLogin — reads that succeed', () => {
  it('control: the snapshot comes back → merged locally and pushed once', async () => {
    addKey({ provider: 'openai', key: 'sk-local-only' });
    expect(await reconcileOnLogin(A)).toBe('synced');
    expect(listKeys().map((k) => k.key).sort()).toEqual(['sk-local-only', 'sk-real-cloud-key']);
    expect(settingsPuts()).toHaveLength(1);
    expect(pushed('sk-real-cloud-key')).toBe(true);
    expect(appStatus.getSnapshot().events).toEqual([]);
  });

  it('a good answer with no snapshot and no reason: the account is new to the cloud, so it is seeded from this device', async () => {
    net.settings = { mode: 'none' };
    addKey({ provider: 'openai', key: 'sk-first-device' });
    expect(await reconcileOnLogin(A)).toBe('synced');
    expect(settingsPuts()).toHaveLength(1);
    expect(pushed('sk-first-device')).toBe(true);
  });

  it('syncOnLogin keeps its shape (resolves to nothing) and does the same work', async () => {
    expect(await syncOnLogin(A)).toBeUndefined();
    expect(listKeys().map((k) => k.key)).toEqual(['sk-real-cloud-key']);
    expect(settingsPuts()).toHaveLength(1);
  });

  it('an account that does not own this device’s data is skipped: nothing applied, nothing pushed', async () => {
    setLocalOwner(B);
    expect(await reconcileOnLogin(A)).toBe('skipped');
    expect(listKeys()).toEqual([]);
    expect(settingsPuts()).toHaveLength(0);
  });
});

describe('readCloudSnapshot — what a read found', () => {
  it('a snapshot, nothing, or a failure with its reason', async () => {
    expect(await readCloudSnapshot()).toMatchObject({ kind: 'snapshot', snapshot: { version: 2 } });
    net.settings = { mode: 'none' };
    expect(await readCloudSnapshot()).toEqual({ kind: 'none' });
    net.settings = { mode: 'throw', status: 0 };
    expect(await readCloudSnapshot()).toEqual({ kind: 'failed', reason: 'network' });
    net.settings = { mode: 'throw', status: 502 };
    expect(await readCloudSnapshot()).toEqual({ kind: 'failed', reason: 'http_502' });
    net.settings = { mode: 'body', body: { ok: true, data: null, reason: 'unreadable' } };
    expect(await readCloudSnapshot()).toEqual({ kind: 'failed', reason: 'unreadable' });
    net.settings = { mode: 'body', body: { ok: false } };
    expect(await readCloudSnapshot()).toEqual({ kind: 'failed', reason: 'not_ok' });
    net.settings = { mode: 'body', body: { ok: true, data: { version: 9 } } };
    expect(await readCloudSnapshot()).toEqual({ kind: 'failed', reason: 'unsupported_snapshot' });
  });
});
