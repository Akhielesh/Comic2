// @vitest-environment jsdom
// The long-term memory's connected-content flag (chatStorage markChatMemoryConnected, wave note 2)
// follows the memory to every device through the account snapshot: a device that received the
// memory without the flag would compose it into a free-model turn. Merged as "either side" (the
// merged memory keeps both sides' lines) and cleared only with the memory. Real chatStorage,
// cloudSync and localOwner; only the HTTP layer (apiClient) is faked, as in cloudSync.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({
  puts: [] as { path: string; data: Record<string, unknown> }[],
  cloud: null as Record<string, unknown> | null
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
    get: vi.fn(async (path: string) => (path === '/api/account/settings' ? { ok: true, data: net.cloud } : { ok: true, keys: [] })),
    put: vi.fn(async (path: string, body: { data: Record<string, unknown> }) => {
      net.puts.push({ path, data: body.data });
      return { ok: true, persisted: true };
    })
  };
});

import { reconcileOnLogin } from './cloudSync';
import { setLocalOwner } from './localOwner';
import { getChatMemory, isChatMemoryConnected, markChatMemoryConnected, setChatMemory } from './chatStorage';

const A = '11111111-1111-4111-8111-111111111111';
const cloudWith = (chat: Record<string, unknown>) => ({ version: 2, keys: [], settings: {}, modelKeys: {}, imageModelId: null, chat });
const lastPushedChat = () => {
  const puts = net.puts.filter((p) => p.path === '/api/account/settings');
  return (puts[puts.length - 1]?.data.chat || {}) as Record<string, unknown>;
};

beforeEach(() => {
  localStorage.clear();
  net.puts = [];
  net.cloud = null;
  setLocalOwner(A);
});

describe('cloud sync: the memory connected-content flag', () => {
  it('a flagged account memory arrives flagged on a new device', async () => {
    net.cloud = cloudWith({ memory: '- Planning the launch with Dana', agents: [], memoryConnected: true });
    expect(await reconcileOnLogin(A)).toBe('synced');
    expect(getChatMemory(A)).toContain('Planning the launch with Dana');
    expect(isChatMemoryConnected(A)).toBe(true);
    expect(lastPushedChat().memoryConnected).toBe(true);
  });

  it('a flag set on this device is pushed and survives an unflagged account copy (either side wins)', async () => {
    setChatMemory('- Planning the launch with Dana', A);
    markChatMemoryConnected(A);
    net.cloud = cloudWith({ memory: '- Lives in Lisbon', agents: [] });
    expect(await reconcileOnLogin(A)).toBe('synced');
    expect(getChatMemory(A)).toContain('Lives in Lisbon');
    expect(isChatMemoryConnected(A)).toBe(true);
    expect(lastPushedChat().memoryConnected).toBe(true);
  });

  it('control: unflagged on both sides → no flag anywhere', async () => {
    setChatMemory('- Prefers short answers', A);
    net.cloud = cloudWith({ memory: '- Lives in Lisbon', agents: [] });
    expect(await reconcileOnLogin(A)).toBe('synced');
    expect(isChatMemoryConnected(A)).toBe(false);
    expect(lastPushedChat()).not.toHaveProperty('memoryConnected');
  });

  it('an empty memory carries no flag (cleared with the memory)', async () => {
    net.cloud = cloudWith({ memory: '', agents: [], memoryConnected: true });
    expect(await reconcileOnLogin(A)).toBe('synced');
    expect(isChatMemoryConnected(A)).toBe(false);
  });
});
