// @vitest-environment jsdom
// Probe: chat history from before ownership tags (every row written before the hotfix shipped) on a
// device whose session was NOT in storage at the first boot after the deploy — "Remember me" off
// (sessionStorage, gone with the tab), or simply signed out at the time. Only
// localOwner.adoptStoredSessionOwner (boot, stored session present) ever claims untagged rows; a
// later sign-in never does (AuthContext: "Untagged chat rows are NOT claimed here"). So after signing
// in, the account's own earlier chats are hidden — and stay hidden unless chat_sync (a table with
// no file under server/sql/, only docs/migrations/chat_sync.sql) returns a cloud copy of each.
// Real chatStorage + chatSync over an in-memory IndexedDB; only the Supabase client is faked.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDb } from '../fakeIndexedDb';

const A = '11111111-1111-4111-8111-111111111111';

const cloud = vi.hoisted(() => ({
  user: null as string | null,
  rows: [] as { user_id: string; kind: string; data: Record<string, unknown> }[],
}));

vi.mock('../../services/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: cloud.user ? { id: cloud.user } : null } })) },
    from: vi.fn(() => ({
      select: () => ({
        eq: async (_col: string, uid: string) => ({ data: cloud.rows.filter((r) => r.user_id === uid).map((r) => ({ kind: r.kind, data: r.data })), error: null }),
      }),
      upsert: async () => ({ error: null }),
      delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    })),
  },
}));

const idb = createFakeIndexedDb();
vi.stubGlobal('indexedDB', idb);
afterAll(() => vi.unstubAllGlobals());

import { createEmptySession, listChatSessions, saveChatSession, setChatSessionUser, syncFromCloud } from '../../services/chatStorage';
import { adoptStoredSessionOwner, clearLocalOwner, getUnownedDataOwner, setLocalOwner } from '../../services/localOwner';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  idb.reset();
  cloud.user = null;
  cloud.rows = [];
  setChatSessionUser(null);
  await listChatSessions();
});

describe('a not-remembered account’s chats from before ownership tags', () => {
  it('are still its own after it signs in (not hidden for good)', async () => {
    // Before the deploy: A's chats, saved without a tag (no ownerUserId existed). "Remember me" off:
    // the session lived in sessionStorage and ended with the tab. (The cloud copy: whatever
    // chat_sync holds — here nothing, as when the table was never created or the push failed.)
    const mine = { ...createEmptySession(), title: 'Plot ideas for issue 2' };
    delete (mine as { ownerUserId?: string }).ownerUserId;
    await saveChatSession(mine);
    await flush();
    expect(getUnownedDataOwner()).toBeNull();

    // First boot after the deploy: nothing in storage, so nobody is adopted …
    adoptStoredSessionOwner(null);
    // … then A signs in with the password (AuthContext.onSignedIn: owner marker set, nothing claimed).
    cloud.user = A;
    setLocalOwner(A);
    setChatSessionUser(A);
    await syncFromCloud();
    await flush();
    const signedIn = (await listChatSessions()).map((s) => s.title);

    // Sign out again: the device has no owner, so the untagged rows show up for nobody-in-particular.
    cloud.user = null;
    clearLocalOwner();
    setChatSessionUser(null);
    const signedOut = (await listChatSessions()).map((s) => s.title);
    process.stderr.write(`probe auth5 ${JSON.stringify({ signedIn, signedOut, unownedOwner: getUnownedDataOwner() })}\n`);

    // Expected: the account sees its own history after signing in.
    expect(signedIn).toEqual(['Plot ideas for issue 2']);
  });
});
