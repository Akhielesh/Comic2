// @vitest-environment jsdom
// Probe: the login sync when GET /api/account/settings fails (network blip, a 502 from the proxy while
// the container wakes, a 429) — services/cloudSync.ts. pullCloudSnapshot swallows the failure and
// returns null, and syncOnLogin reads null as "first time on the cloud: seed it from this device".
// Right after a sign-out → sign-in (or an account switch / first sign-in on a device) the local data
// was just purged by AuthContext, so the seed is EMPTY — and it is PUT over the account's real
// snapshot (BYOK keys, settings, chat memory, custom agents). Expected: a failed read never writes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({
  settingsGet: 'network' as 'network' | '502' | 'ok',
  puts: [] as { path: string; data: Record<string, unknown> }[],
}));

vi.mock('../../services/apiClient', () => {
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
      if (path === '/api/account/settings') {
        if (net.settingsGet === 'network') throw new ApiError("Couldn't reach the AI server", 0);
        if (net.settingsGet === '502') throw new ApiError('Bad Gateway', 502);
        return {
          ok: true,
          data: {
            version: 2,
            keys: [{ id: 'k1', provider: 'openai', label: 'OpenAI', key: 'sk-real-cloud-key', active: true, limitUsd: null, usedUsd: 0, periodStart: new Date().toISOString(), createdAt: new Date().toISOString() }],
            settings: {},
            modelKeys: {},
            imageModelId: null,
          },
        };
      }
      return { ok: true, keys: [] };
    }),
    put: vi.fn(async (path: string, body: { data: Record<string, unknown> }) => {
      net.puts.push({ path, data: body.data });
      return { ok: true, persisted: true };
    }),
  };
});

import { syncOnLogin } from '../../services/cloudSync';
import { setLocalOwner } from '../../services/localOwner';
import { listKeys } from '../../services/apiKeys';

const A = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  localStorage.clear();
  net.puts = [];
});

describe('login sync when the account snapshot cannot be read', () => {
  for (const failure of ['network', '502'] as const) {
    it(`${failure}: never writes the (just purged, empty) local state over the account's snapshot`, async () => {
      net.settingsGet = failure;
      // AuthContext.onSignedIn: the purge already ran (sign-out, or a switch), then the owner marker is set
      // and syncOnLogin starts. Nothing is stored locally any more.
      setLocalOwner(A);
      expect(listKeys()).toEqual([]);
      await syncOnLogin(A);
      const settingsPuts = net.puts.filter((p) => p.path === '/api/account/settings');
      process.stderr.write(`probe auth1 ${failure} ${JSON.stringify({ puts: settingsPuts.length, keys: settingsPuts[0]?.data?.keys, chat: settingsPuts[0]?.data?.chat })}\n`);
      // Expected: a failed read is not "no snapshot" — nothing is pushed until the cloud has been read.
      expect(settingsPuts).toHaveLength(0);
    });
  }

  it('control: when the read succeeds the cloud keys come back locally and the merge is pushed', async () => {
    net.settingsGet = 'ok';
    setLocalOwner(A);
    await syncOnLogin(A);
    expect(listKeys().map((k) => k.key)).toContain('sk-real-cloud-key');
    expect(net.puts.filter((p) => p.path === '/api/account/settings')).toHaveLength(1);
  });
});
