// @vitest-environment jsdom
// Chat history (IndexedDB 'dreamstream_chat') is shared by every account that signs in on this
// browser, and chat_sync is live: rows must stay with the account that owns them. Real
// chatStorage + real chatSync over an in-memory IndexedDB; only the Supabase client (the
// network) is faked.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDb } from '../tests/fakeIndexedDb';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const cloud = vi.hoisted(() => ({
  /** The signed-in user per Supabase (whose token the requests ride on). */
  user: null as string | null,
  /** chat_sync rows on the server. */
  rows: [] as { user_id: string; kind: string; data: Record<string, unknown> }[],
  upserts: [] as { key: string; user_id: string; kind: string; data: Record<string, unknown> }[],
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: cloud.user ? { id: cloud.user } : null } })) },
    from: vi.fn(() => ({
      select: () => ({
        eq: async (_col: string, uid: string) => ({
          data: cloud.rows.filter((r) => r.user_id === uid).map((r) => ({ kind: r.kind, data: r.data })),
          error: null,
        }),
      }),
      upsert: async (row: (typeof cloud.upserts)[number]) => {
        cloud.upserts.push(row);
        return { error: null };
      },
      delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    })),
  },
}));

const idb = createFakeIndexedDb();
vi.stubGlobal('indexedDB', idb);
afterAll(() => vi.unstubAllGlobals());

import {
  createChatProject,
  createEmptySession,
  getChatSession,
  listChatProjects,
  listChatSessions,
  saveChatProject,
  saveChatSession,
  setChatSessionUser,
  syncFromCloud,
  branchSession,
  isChatOwnedBy,
  type ChatSession,
} from './chatStorage';
import { pushSession } from './chatSync';
import { claimUnownedData, clearLocalOwner, setLocalOwner } from './localOwner';

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};
const titles = (list: { title?: string; name?: string }[]) => list.map((x) => x.title ?? x.name).sort();
const signIn = (id: string | null) => {
  cloud.user = id;
  if (id) setLocalOwner(id);
  else clearLocalOwner();
};
const chat = (title: string, extra: Partial<ChatSession> = {}) => ({ ...createEmptySession(), title, ...extra });

beforeEach(async () => {
  localStorage.clear();
  idb.reset();
  cloud.user = null;
  cloud.rows = [];
  cloud.upserts = [];
  setChatSessionUser(null); // no tab account known: rows follow the device's owner marker
  await listChatSessions(); // creates the database (and its stores)
});

describe('chat history is scoped to the account that owns it', () => {
  it('tags rows on save; a switch hides the previous account’s chats without deleting them', async () => {
    signIn(A);
    await saveChatSession(chat('A: private plans'));
    await saveChatProject(createChatProject('A project', 'folder', 'blue'));
    expect(idb.rows('dreamstream_chat', 'sessions').map((r) => r.ownerUserId)).toEqual([A]);
    expect(idb.rows('dreamstream_chat', 'projects').map((r) => r.ownerUserId)).toEqual([A]);

    signIn(B);
    expect(await listChatSessions()).toEqual([]);
    expect(await listChatProjects()).toEqual([]);
    const aRow = idb.rows('dreamstream_chat', 'sessions')[0] as unknown as ChatSession;
    expect(await getChatSession(aRow.id)).toBeUndefined();
    await saveChatSession(chat('B: shopping'));
    expect(titles(await listChatSessions())).toEqual(['B: shopping']);

    // A signs in again: their chats are all still there, B's are not shown to them.
    signIn(A);
    expect(titles(await listChatSessions())).toEqual(['A: private plans']);
    expect(titles(await listChatProjects())).toEqual(['A project']);
    expect(idb.rows('dreamstream_chat', 'sessions')).toHaveLength(2);
  });

  it('pushes a save only for the signed-in owner — a late save of the previous account’s chat stays with it, unpushed', async () => {
    signIn(A);
    await saveChatSession(chat('A: draft'));
    await flush();
    const [loaded] = await listChatSessions(); // what A's open chat screen holds
    expect(cloud.upserts.map((u) => [u.user_id, u.data.title])).toEqual([[A, 'A: draft']]);

    signIn(B);
    cloud.upserts = [];
    // A stream finishing after the switch saves A's chat again.
    await saveChatSession({ ...loaded, title: 'A: draft (finished)', updatedAt: Date.now() + 1 });
    await flush();
    expect(cloud.upserts).toEqual([]);
    expect(await listChatSessions()).toEqual([]);
    expect(idb.rows('dreamstream_chat', 'sessions')[0]).toMatchObject({ ownerUserId: A, title: 'A: draft (finished)' });
  });

  it('syncFromCloud pushes only the signed-in user’s rows and stores theirs tagged as theirs', async () => {
    signIn(A);
    cloud.user = null; // A's chats were never synced (offline, or before chat_sync existed)
    await saveChatSession(chat('A: never synced'));
    await saveChatProject(createChatProject('A folder', 'folder', 'blue'));

    signIn(B);
    await saveChatSession(chat('B: local only'));
    const remote = { ...createEmptySession(), title: 'B: from the cloud' };
    cloud.rows = [{ user_id: B, kind: 'session', data: remote as unknown as Record<string, unknown> }];
    cloud.upserts = [];

    await syncFromCloud();
    await flush();

    const pushed = cloud.upserts.map((u) => [u.user_id, u.data.title ?? u.data.name, u.data.ownerUserId]);
    expect(pushed).toEqual([[B, 'B: local only', B]]);
    expect(titles(await listChatSessions())).toEqual(['B: from the cloud', 'B: local only']);
    const stored = idb.rows('dreamstream_chat', 'sessions').find((r) => r.title === 'B: from the cloud');
    expect(stored?.ownerUserId).toBe(B);
  });

  it('syncFromCloud touches nothing while the signed-in user is not the device’s owner', async () => {
    signIn(A);
    await saveChatSession(chat('A: mine'));
    cloud.user = B; // e.g. another tab's session, before this tab switched owners
    cloud.rows = [{ user_id: B, kind: 'session', data: { ...createEmptySession(), title: 'B: theirs' } as unknown as Record<string, unknown> }];
    cloud.upserts = [];
    await syncFromCloud();
    await flush();
    expect(cloud.upserts).toEqual([]);
    expect(titles(await listChatSessions())).toEqual(['A: mine']);
  });

  it('chats from before ownership tags belong to the account that claimed the device’s unowned data — never to the next one', async () => {
    const legacy = chat('legacy: from before tags');
    idb.seed('dreamstream_chat', 'sessions', [legacy as unknown as Record<string, unknown>]);
    // Signed out on a device nobody has claimed: still visible (chat needs a sign-in anyway).
    expect(titles(await listChatSessions())).toEqual(['legacy: from before tags']);

    claimUnownedData(A);
    signIn(A);
    const [mine] = await listChatSessions();
    expect(mine).toMatchObject({ title: 'legacy: from before tags', ownerUserId: A });

    signIn(B);
    expect(await listChatSessions()).toEqual([]);
    cloud.upserts = [];
    await syncFromCloud();
    await flush();
    expect(cloud.upserts).toEqual([]);
    // B's own new chats are B's — never the claimant's.
    await saveChatSession(chat('B: new'));
    await saveChatProject(createChatProject('B folder', 'folder', 'blue'));
    await flush();
    expect(titles(await listChatSessions())).toEqual(['B: new']);
    expect(titles(await listChatProjects())).toEqual(['B folder']);
    expect(cloud.upserts.map((u) => [u.user_id, u.data.title ?? u.data.name, u.data.ownerUserId])).toEqual([
      [B, 'B: new', B],
      [B, 'B folder', B]
    ]);
    cloud.upserts = [];

    // A again: their sync pushes it up, tagged as theirs.
    signIn(A);
    await syncFromCloud();
    await flush();
    expect(cloud.upserts.map((u) => [u.user_id, u.data.title, u.data.ownerUserId])).toEqual([[A, 'legacy: from before tags', A]]);
  });

  it('a branch of the previous account’s chat (a stale screen after a switch) stays with that account, unpushed', async () => {
    signIn(A);
    const s: ChatSession = { ...chat('A: secret plan'), turns: [{ id: 't1', role: 'user', content: 'A: my PIN hint is 4-4-2' } as never] };
    await saveChatSession(s);
    await flush();
    const [onScreen] = await listChatSessions();
    signIn(B); // another tab switched the device to B
    cloud.upserts = [];
    const branched = branchSession(onScreen, 't1');
    expect(branched.ownerUserId).toBe(A);
    await saveChatSession(branched);
    await flush();
    expect(cloud.upserts).toEqual([]);
    expect(await listChatSessions()).toEqual([]);
  });

  it('a chat started before a switch is the starter’s from birth — a late save never makes it the new account’s', async () => {
    signIn(A);
    const fresh = chat('A: brand new'); // on screen, never saved or reloaded yet
    expect(fresh.ownerUserId).toBe(A);
    const project = createChatProject('A: new folder', 'folder', 'blue');
    signIn(B);
    cloud.upserts = [];
    await saveChatSession({ ...fresh, turns: [{ id: 't', role: 'user', content: 'A typed this' } as never] });
    await saveChatProject(project);
    await flush();
    expect(cloud.upserts).toEqual([]);
    expect(await listChatSessions()).toEqual([]);
    expect(await listChatProjects()).toEqual([]);
  });

  it('untagged rows nobody claimed stay hidden — except the ones an account’s own cloud copy proves are its', async () => {
    const synced = chat('legacy: synced to A before');
    const unsynced = chat('legacy: never synced');
    idb.seed('dreamstream_chat', 'sessions', [synced, unsynced] as unknown as Record<string, unknown>[]);
    // A signs in on this device without a stored session at boot (no claim).
    signIn(A);
    expect(await listChatSessions()).toEqual([]);
    cloud.rows = [{ user_id: A, kind: 'session', data: { ...synced, title: 'legacy: synced to A before (cloud)' } as unknown as Record<string, unknown> }];
    cloud.upserts = [];
    await syncFromCloud();
    await flush();
    expect(titles(await listChatSessions())).toEqual(['legacy: synced to A before (cloud)']);
    expect(cloud.upserts).toEqual([]); // nothing of the unclaimed rows goes up
    // B never gets either.
    signIn(B);
    cloud.rows = [];
    await syncFromCloud();
    await flush();
    expect(await listChatSessions()).toEqual([]);
    expect(cloud.upserts).toEqual([]);
  });

  it('"Remember me" off, two tabs: a chat A starts after another tab moved the device to B is A’s — pushed to A, never upserted as B, never shown to B', async () => {
    // Tab 1: A's session (contexts/AuthContext tells chatStorage); A owns the device.
    setChatSessionUser(A);
    setLocalOwner(A);
    // Tab 2 confirms a link for B: the device marker is B's now. Tab 1 is still A (its own session).
    setLocalOwner(B);

    // Tab 1 (A's token): a NEW chat and a new project — tagged by the tab's account, not the device's.
    cloud.user = A;
    const s = createEmptySession({ title: 'A: private, typed after the switch' });
    const p = createChatProject('A: new folder', 'folder', 'blue');
    expect(s.ownerUserId).toBe(A);
    expect(p.ownerUserId).toBe(A);
    await saveChatSession(s);
    await saveChatProject(p);
    await flush();
    // They go up into A's own account with A's token — nothing lands in IndexedDB as B's.
    expect(cloud.upserts.map((u) => [u.user_id, u.data.title ?? u.data.name, u.data.ownerUserId])).toEqual([
      [A, 'A: private, typed after the switch', A],
      [A, 'A: new folder', A],
    ]);
    expect(idb.rows('dreamstream_chat', 'sessions').map((r) => r.ownerUserId)).toEqual([A]);
    expect(idb.rows('dreamstream_chat', 'projects').map((r) => r.ownerUserId)).toEqual([A]);
    // Tab 1 still shows A their own chats (the device marker says B, the tab's session says A).
    expect(titles(await listChatSessions())).toEqual(['A: private, typed after the switch']);
    expect(titles(await listChatProjects())).toEqual(['A: new folder']);

    // Tab 2 (B): the chat screen mounts / reloads and syncs "its" rows.
    setChatSessionUser(B);
    cloud.user = B;
    cloud.upserts = [];
    await syncFromCloud();
    await flush();
    expect(cloud.upserts).toEqual([]);
    expect(await listChatSessions()).toEqual([]);
    expect(await listChatProjects()).toEqual([]);
    // B's own new chat is B's.
    await saveChatSession(chat('B: shopping'));
    await flush();
    expect(cloud.upserts.map((u) => [u.user_id, u.data.title])).toEqual([[B, 'B: shopping']]);
    expect(titles(await listChatSessions())).toEqual(['B: shopping']);
  });

  it('a tab with no account signed in (or none known yet) follows the device’s owner marker, as before', async () => {
    setChatSessionUser(null);
    signIn(A);
    expect(createEmptySession().ownerUserId).toBe(A);
    await saveChatSession(chat('A: from a tab that only knows the marker'));
    await flush();
    expect(cloud.upserts.map((u) => [u.user_id, u.data.ownerUserId])).toEqual([[A, A]]);
    // The tab learns its account (the same one): nothing changes.
    setChatSessionUser(A.toUpperCase());
    expect(titles(await listChatSessions())).toEqual(['A: from a tab that only knows the marker']);
    expect(createEmptySession().ownerUserId).toBe(A);
    // Signed out on this tab: back to the marker.
    setChatSessionUser(undefined);
    expect(createEmptySession().ownerUserId).toBe(A);
  });

  it('isChatOwnedBy: chat memory learns only from the signed-in account’s own chats', () => {
    expect(isChatOwnedBy(A, A.toUpperCase())).toBe(true);
    expect(isChatOwnedBy(A, B)).toBe(false); // a stale screen after a switch
    expect(isChatOwnedBy(undefined, A)).toBe(false);
    expect(isChatOwnedBy(A, null)).toBe(false);
  });

  it('chatSync never uploads a row owned by someone else, or an untagged one', async () => {
    cloud.user = B;
    await pushSession({ ...chat('A: secret'), ownerUserId: A });
    await pushSession(chat('untagged'));
    expect(cloud.upserts).toEqual([]);
    await pushSession({ ...chat('B: fine'), ownerUserId: B });
    expect(cloud.upserts.map((u) => [u.user_id, u.data.title])).toEqual([[B, 'B: fine']]);
  });
});
