// @vitest-environment jsdom
// CHAT-0 (nav V.3-a, B14 chat half): a Chat Studio mount reads a manifest (`key, updated_at`) and
// moves bodies only for rows that changed — the old mount downloaded every chat in full (6.3 MB for
// the heaviest account) every time. Which side changed is judged against the per-device sync base,
// so an edit written by a device whose clock runs behind still arrives (chat_sync.updated_at is the
// writer's clock). Real chatStorage + chatSync over an in-memory IndexedDB and chat_sync table.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDb } from '../tests/fakeIndexedDb';
import type { FakeChatSyncCloud } from './chatSync.testkit';

const A = '11111111-1111-4111-8111-111111111111';
/** Another account that signs in on the same device. */
const B = '22222222-2222-4222-8222-222222222222';

const cloud = vi.hoisted(() => ({ user: null, rows: [], upserts: [], selects: [] }) as unknown as FakeChatSyncCloud);

vi.mock('./supabase', async () => {
  const { makeFakeChatSyncSupabase } = await import('./chatSync.testkit');
  return { supabase: makeFakeChatSyncSupabase(cloud) };
});

const idb = createFakeIndexedDb();
vi.stubGlobal('indexedDB', idb);
afterAll(() => vi.unstubAllGlobals());

import { createEmptySession, listChatSessions, saveChatSession, setChatSessionUser, syncFromCloud, type ChatSession } from './chatStorage';
import { BODY_CHUNK, MANIFEST_PAGE, pullBodies, pullManifest, pushSession, readSyncBase, removeRemote, syncDecision } from './chatSync';
import { isBodySelect } from './chatSync.testkit';
import { setLocalOwner } from './localOwner';

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};
const bodySelects = () => cloud.selects.filter((s) => isBodySelect(s.columns));
const manifestSelects = () => cloud.selects.filter((s) => !isBodySelect(s.columns));
const byTitle = async () => Object.fromEntries((await listChatSessions()).map((s) => [s.id, s.title]));
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);

/** A chat this device has, saved while offline (no push). */
const seedLocal = async (title: string, updatedAt: number, extra: Partial<ChatSession> = {}): Promise<ChatSession> => {
  const s = { ...createEmptySession(), title, updatedAt, ...extra };
  const user = cloud.user;
  cloud.user = null;
  await saveChatSession(s);
  cloud.user = user;
  return (await listChatSessions()).find((x) => x.id === s.id)!;
};
/** Another device writes this row, stamping `updated_at` from its own clock. */
const remoteWrite = (s: ChatSession, at: number) => {
  const data = { ...s, updatedAt: at, ownerUserId: A } as unknown as Record<string, unknown>;
  cloud.rows = [...cloud.rows.filter((r) => (r.key ?? `${r.kind}:${String(r.data.id)}`) !== `session:${s.id}`), {
    key: `session:${s.id}`, user_id: A, kind: 'session', data, updated_at: new Date(at).toISOString()
  }];
};

beforeEach(async () => {
  localStorage.clear();
  idb.reset();
  cloud.user = A;
  cloud.rows = [];
  cloud.upserts = [];
  cloud.selects = [];
  setChatSessionUser(null);
  setLocalOwner(A);
  await listChatSessions(); // creates the database
});

describe('light chat sync: a manifest, then only what changed', () => {
  it('a second mount with no changes sends 0 upserts and fetches 0 bodies — one manifest read only', async () => {
    // This device: two chats never synced. The cloud: one chat this device has never seen.
    await seedLocal('local one', T0);
    await seedLocal('local two', T0 + 1);
    const remoteOnly = { ...createEmptySession(), title: 'from the laptop' };
    remoteWrite(remoteOnly, T0 + 2);

    // First mount: the two local chats go up, the remote one comes down — once.
    await syncFromCloud();
    await flush();
    expect(cloud.upserts.map((u) => u.data.title).sort()).toEqual(['local one', 'local two']);
    expect(bodySelects()).toHaveLength(1);
    expect(Object.values(await byTitle()).sort()).toEqual(['from the laptop', 'local one', 'local two']);

    // Second mount, nothing changed anywhere.
    cloud.upserts = [];
    cloud.selects = [];
    await syncFromCloud();
    await flush();
    expect(cloud.upserts).toEqual([]);
    expect(bodySelects()).toEqual([]);
    expect(manifestSelects().map((s) => s.columns)).toEqual(['key, updated_at']);
  });

  it('a device with a skewed clock still receives changes (and its edit is not overwritten)', async () => {
    const mine = await seedLocal('Trip plan', T0);
    await syncFromCloud(); // first sync: pushed, the base learns T0
    await flush();
    expect(readSyncBase(A)[`session:${mine.id}`]).toBe(T0);

    // The phone, 10 minutes behind, edits the chat later in real time but stamps an EARLIER time.
    remoteWrite({ ...mine, title: 'Trip plan (edited on the phone)' }, T0 - 10 * 60_000);
    cloud.upserts = [];
    cloud.selects = [];
    await syncFromCloud();
    await flush();

    expect((await byTitle())[mine.id]).toBe('Trip plan (edited on the phone)');
    expect(cloud.upserts).toEqual([]); // the stale local copy never goes back up over it
    expect(bodySelects()).toEqual([{ columns: 'key, kind, data, updated_at', rows: 1 }]);
    // And the next mount is quiet again.
    cloud.selects = [];
    await syncFromCloud();
    await flush();
    expect(bodySelects()).toEqual([]);
    expect(cloud.upserts).toEqual([]);
  });

  it('a local edit made offline goes up on the next sync; the cloud copy is not pulled over it', async () => {
    const mine = await seedLocal('Recipes', T0);
    await syncFromCloud();
    await flush();
    await seedLocal('Recipes (offline edit)', T0 + 5_000, { id: mine.id, createdAt: mine.createdAt });
    cloud.upserts = [];
    cloud.selects = [];
    await syncFromCloud();
    await flush();
    expect(cloud.upserts.map((u) => u.data.title)).toEqual(['Recipes (offline edit)']);
    expect(bodySelects()).toEqual([]);
  });

  it('both sides changed: the later timestamp wins (as before); no base yet: the later timestamp wins too', () => {
    expect(syncDecision(T0 + 5, T0 + 9, T0)).toBe('pull');
    expect(syncDecision(T0 + 9, T0 + 5, T0)).toBe('push');
    expect(syncDecision(T0, T0 - 1, T0)).toBe('pull'); // only the remote moved (clock behind)
    expect(syncDecision(T0 + 1, T0, T0)).toBe('push'); // only the local copy moved
    expect(syncDecision(T0, T0, T0)).toBe('same');
    expect(syncDecision(T0, T0 - 1, undefined)).toBe('push');
    expect(syncDecision(T0, T0 + 1, undefined)).toBe('pull');
  });

  it('bodies are fetched in chunks of at most BODY_CHUNK keys', async () => {
    const n = BODY_CHUNK + 3;
    for (let i = 0; i < n; i++) remoteWrite({ ...createEmptySession(), title: `remote ${i}` }, T0 + i);
    await syncFromCloud();
    await flush();
    expect(bodySelects().map((s) => s.rows)).toEqual([BODY_CHUNK, 3]);
    expect((await listChatSessions()).length).toBe(n);
  });

  it('the manifest pages past the server cap, so no row is ever missed', async () => {
    const rows = Array.from({ length: MANIFEST_PAGE + 2 }, (_, i) => ({
      key: `session:${String(i).padStart(5, '0')}`, user_id: A, kind: 'session', data: { id: String(i) }, updated_at: new Date(T0).toISOString()
    }));
    cloud.rows = rows;
    cloud.maxRows = MANIFEST_PAGE; // PostgREST max-rows
    try {
      const manifest = await pullManifest();
      expect(new Set(manifest?.entries.map((e) => e.key)).size).toBe(MANIFEST_PAGE + 2);
      // The capped first answer, then the rows again in key order, page by page.
      expect(manifestSelects().map((s) => s.rows)).toEqual([MANIFEST_PAGE, MANIFEST_PAGE, 2]);
    } finally {
      cloud.maxRows = undefined;
    }
  });

  it('a server cap below MANIFEST_PAGE: every row is still read (pages follow the last key, not a fixed size)', async () => {
    cloud.rows = Array.from({ length: 1200 }, (_, i) => ({
      key: `session:${String(i).padStart(5, '0')}`, user_id: A, kind: 'session', data: { id: String(i) }, updated_at: new Date(T0).toISOString()
    }));
    cloud.maxRows = 500; // a project that lowered PostgREST max-rows
    try {
      const manifest = await pullManifest();
      expect(manifest?.entries).toHaveLength(1200);
      expect(new Set(manifest?.entries.map((e) => e.key)).size).toBe(1200);
      expect(manifestSelects().map((s) => s.rows)).toEqual([500, 500, 500, 200]);
    } finally {
      cloud.maxRows = undefined;
    }
  });

  it('a capped manifest that never ends is not used (nothing is mistaken for missing)', async () => {
    cloud.rows = Array.from({ length: 60 }, (_, i) => ({
      key: `session:${String(i).padStart(5, '0')}`, user_id: A, kind: 'session', data: { id: String(i) }, updated_at: new Date(T0).toISOString()
    }));
    cloud.maxRows = 1; // 60 rows, one per answer: past the page limit
    try {
      expect(await pullManifest()).toBeNull();
    } finally {
      cloud.maxRows = undefined;
    }
  });

  it('an account under the cap costs exactly one manifest request', async () => {
    remoteWrite({ ...createEmptySession(), title: 'only one' }, T0);
    await pullManifest();
    expect(cloud.selects).toEqual([{ columns: 'key, updated_at', rows: 1 }]);
  });

  it('saves made while an upload is in flight go up once, newest only; every caller hears when it is sent', async () => {
    let open!: () => void;
    cloud.upsertGate = new Promise<void>((r) => { open = r; });
    const base = { ...createEmptySession(), ownerUserId: A };
    const v = (n: number) => ({ ...base, title: `v${n}`, updatedAt: T0 + n });
    const done: string[] = [];
    const sends = [1, 2, 3, 4].map((n) => pushSession(v(n)).then(() => done.push(`v${n}`)));
    await flush();
    expect(cloud.upserts).toEqual([]); // v1 is uploading; v2..v4 wait
    open();
    cloud.upsertGate = undefined;
    await Promise.all(sends);
    // v1 (already uploading), then only the newest of the saves made meanwhile.
    expect(cloud.upserts.map((u) => u.data.title)).toEqual(['v1', 'v4']);
    expect(done.sort()).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(readSyncBase(A)[`session:${base.id}`]).toBe(T0 + 4);

    // Later saves start a new upload straight away.
    await pushSession(v(5));
    expect(cloud.upserts.map((u) => u.data.title)).toEqual(['v1', 'v4', 'v5']);
  });

  it('a delete drops a save still waiting to go up, so the row never comes back', async () => {
    let open!: () => void;
    cloud.upsertGate = new Promise<void>((r) => { open = r; });
    const s = { ...createEmptySession(), ownerUserId: A, updatedAt: T0 };
    const first = pushSession(s);
    const second = pushSession({ ...s, title: 'edited', updatedAt: T0 + 1 });
    await removeRemote('session', s.id);
    open();
    cloud.upsertGate = undefined;
    await Promise.all([first, second]);
    expect(cloud.upserts.map((u) => u.data.title)).toEqual([s.title]); // the edit never went up
  });

  it('storage that throws: sync still works (timestamp rule), nothing breaks', async () => {
    const mine = await seedLocal('Notes', T0);
    const realGet = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key.startsWith('dreamstream_chat_sync_base')) throw new Error('blocked');
      return realGet.call(this, key);
    });
    try {
      await syncFromCloud();
      await flush();
      expect(cloud.upserts.map((u) => u.data.title)).toEqual(['Notes']);
      expect((await byTitle())[mine.id]).toBe('Notes');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the account boundary: every read is the signed-in account’s, and the sync base is per account', () => {
  /** A row in the cloud that belongs to `owner` (as that account's own device wrote it). */
  const cloudRow = (owner: string, title: string, at: number, id?: string) => {
    const s = { ...createEmptySession(), ...(id ? { id } : {}), title, updatedAt: at, ownerUserId: owner };
    cloud.rows = [...cloud.rows, {
      key: `session:${s.id}`, user_id: owner, kind: 'session', data: s as unknown as Record<string, unknown>, updated_at: new Date(at).toISOString()
    }];
    return s;
  };

  it("signed in as A, the manifest and the bodies hold only A's rows, and a sync writes none of B's", async () => {
    const mine = cloudRow(A, 'A’s chat', T0);
    const theirs = cloudRow(B, 'B’s chat', T0 + 1);
    const manifest = await pullManifest();
    expect(manifest?.userId).toBe(A);
    expect(manifest?.entries.map((e) => e.key)).toEqual([`session:${mine.id}`]);
    // Even asked for B's key by name, the body read is A's rows only.
    const bodies = await pullBodies(A, [`session:${theirs.id}`]);
    expect(bodies?.sessions).toEqual([]);
    expect(bodies?.projects).toEqual([]);
    await syncFromCloud();
    await flush();
    const local = await byTitle();
    expect(local[mine.id]).toBe('A’s chat');
    expect(local[theirs.id]).toBeUndefined();
    expect(Object.values(local)).not.toContain('B’s chat');
  });

  it("a manifest paged past the server cap is still A's rows only", async () => {
    // B's keys sort first, so a page that forgot the account would start with them.
    const a1 = cloudRow(A, 'A one', T0, 'zz-a1');
    const a2 = cloudRow(A, 'A two', T0 + 1, 'zz-a2');
    cloudRow(B, 'B one', T0 + 2, 'aa-b1');
    cloudRow(B, 'B two', T0 + 3, 'aa-b2');
    cloud.maxRows = 1; // every answer holds one row: the manifest has to page
    try {
      const manifest = await pullManifest();
      expect(manifest?.entries.map((e) => e.key).sort()).toEqual([`session:${a1.id}`, `session:${a2.id}`].sort());
      expect(manifestSelects().length).toBeGreaterThan(1);
    } finally {
      cloud.maxRows = undefined;
    }
  });

  it('A then B on one device: two sync bases, one per account, that never share a key', async () => {
    const aRow = cloudRow(A, 'A’s chat', T0);
    const bRow = cloudRow(B, 'B’s chat', T0 + 1);
    await syncFromCloud();
    await flush();
    // B signs in on the same device.
    cloud.user = B;
    setLocalOwner(B);
    await syncFromCloud();
    await flush();
    const baseA = readSyncBase(A);
    const baseB = readSyncBase(B);
    expect(Object.keys(baseA)).toEqual([`session:${aRow.id}`]);
    expect(Object.keys(baseB)).toEqual([`session:${bRow.id}`]);
    expect(Object.keys(baseA).filter((k) => k in baseB)).toEqual([]);
    const baseKeys = Object.keys(localStorage).filter((k) => k.startsWith('dreamstream_chat_sync_base')).sort();
    expect(baseKeys).toEqual([`dreamstream_chat_sync_base:${A}`, `dreamstream_chat_sync_base:${B}`].sort());
    // B's device copy holds B's chat, never A's.
    const local = await byTitle();
    expect(local[bRow.id]).toBe('B’s chat');
    expect(local[aRow.id]).toBeUndefined();
  });
});
