import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the cloud-sync layer so we can assert the cross-device resurrection vector
// (re-pushing a deleted row to the cloud) is closed. IndexedDB is unavailable in jsdom,
// but chatStorage wraps every IDB call in try/catch, so the local path no-ops cleanly and
// the guard (which returns BEFORE any IDB call) is what we're testing.
const { pushSessionMock, pushProjectMock, removeRemoteMock, pullAllMock } = vi.hoisted(() => ({
  pushSessionMock: vi.fn().mockResolvedValue(undefined),
  pushProjectMock: vi.fn().mockResolvedValue(undefined),
  removeRemoteMock: vi.fn().mockResolvedValue(undefined),
  pullAllMock: vi.fn().mockResolvedValue(null)
}));
vi.mock('./chatSync', () => ({
  pushSession: pushSessionMock,
  pushProject: pushProjectMock,
  removeRemote: removeRemoteMock,
  pullAll: pullAllMock,
  isChatSyncAvailable: () => false
}));

import {
  saveChatSession,
  saveChatProject,
  deleteChatSession,
  deleteChatProject,
  wasDeletedThisSession,
  createEmptySession,
  createChatProject
} from './chatStorage';
import { setLocalOwner } from './localOwner';

const OWNER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  pushSessionMock.mockClear();
  pushProjectMock.mockClear();
  // Signed in: rows are tagged with (and pushed only for) the device's owner (chatStorage.owner.test.ts).
  localStorage.clear();
  setLocalOwner(OWNER);
});

describe('deleted chats/projects never resurrect via a late fire-and-forget save', () => {
  it('saveChatSession is a no-op (no cloud push) after the chat was deleted this session', async () => {
    const s = createEmptySession();
    await deleteChatSession(s.id);
    expect(wasDeletedThisSession(s.id)).toBe(true);

    pushSessionMock.mockClear(); // ignore any push from the delete path itself
    // A late background update (stream finalize / auto-title) landing after the delete:
    await saveChatSession({ ...s, title: 'late background update' });

    // The resurrection vector — re-pushing the deleted row to the cloud — is closed.
    expect(pushSessionMock).not.toHaveBeenCalled();
  });

  it('still pushes a normal, non-deleted chat', async () => {
    const s = createEmptySession();
    await saveChatSession(s);
    expect(pushSessionMock).toHaveBeenCalledTimes(1);
    expect(pushSessionMock.mock.calls[0][0]).toMatchObject({ id: s.id, ownerUserId: OWNER });
  });

  it('saveChatProject is a no-op after the project was deleted this session', async () => {
    const p = createChatProject('Work', '📁', '#888');
    await deleteChatProject(p.id);
    expect(wasDeletedThisSession(p.id)).toBe(true);

    pushProjectMock.mockClear();
    await saveChatProject({ ...p, name: 'late rename' });
    expect(pushProjectMock).not.toHaveBeenCalled();
  });

  it('still pushes a normal, non-deleted project', async () => {
    const p = createChatProject('Personal', '📁', '#999');
    await saveChatProject(p);
    expect(pushProjectMock).toHaveBeenCalledTimes(1);
  });
});
