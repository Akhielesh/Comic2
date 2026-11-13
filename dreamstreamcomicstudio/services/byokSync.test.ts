import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addKey, deleteKey, getAccountKeyMeta } from './apiKeys';
import { reconcileProviderMirror } from './byokSync';
import { clearLocalOwner, setLocalOwner } from './localOwner';

const { post, del } = vi.hoisted(() => ({ post: vi.fn(), del: vi.fn() }));
vi.mock('./apiClient', () => ({ post, del }));

const userId = 'e5072b1b-a415-475b-8173-1029e73038e9';
const otherUser = 'c374ec52-484a-4765-8d99-9460e6c887fc';

beforeEach(() => {
  window.localStorage.clear();
  clearLocalOwner();
  setLocalOwner(userId);
  post.mockReset();
  del.mockReset();
});

describe('account key mirror', () => {
  it('finishes a pending save before a later removal and clears presence metadata', async () => {
    const key = addKey({ provider: 'openrouter', key: 'local-fake-key-1234' });
    let finish!: (value: { persisted: boolean }) => void;
    post.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    del.mockResolvedValue({ ok: true });

    const save = reconcileProviderMirror(userId, 'openrouter');
    expect(post).toHaveBeenCalledWith('/api/account/byok', { provider: 'openrouter', key: key.key }, { expectedAccountId: userId });
    deleteKey(key.id);
    const remove = reconcileProviderMirror(userId, 'openrouter');
    expect(del).not.toHaveBeenCalled();
    finish({ persisted: true });
    expect(await save).toBe('synced');
    expect(await remove).toBe('synced');
    expect(del).toHaveBeenCalledWith('/api/account/byok/openrouter', { expectedAccountId: userId });
    expect(getAccountKeyMeta()).toEqual([]);
  });

  it('distinguishes a failed HTTP-200 write from a stored key', async () => {
    addKey({ provider: 'gemini', key: 'local-fake-key-abcd' });
    post.mockResolvedValueOnce({ persisted: false }).mockResolvedValueOnce({ persisted: true });

    expect(await reconcileProviderMirror(userId, 'gemini')).toBe('failed');
    expect(getAccountKeyMeta()).toEqual([]);
    expect(await reconcileProviderMirror(userId, 'gemini')).toBe('synced');
    expect(getAccountKeyMeta()).toEqual([{ provider: 'gemini', suffix: 'abcd' }]);
  });

  it('skips the write when the device belongs to a different account', async () => {
    setLocalOwner(otherUser);
    addKey({ provider: 'nvidia', key: 'local-fake-key-abcd' });
    expect(await reconcileProviderMirror(userId, 'nvidia')).toBe('skipped');
    expect(post).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
