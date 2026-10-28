// @vitest-environment jsdom
// "Remember me" OFF: one session per tab. Two tabs of the main app on one device — shared
// localStorage and IndexedDB, a separate session each. Tab 1 is signed in as A; in tab 2 a link
// for B is confirmed, which purges A's data and makes the device B's. Tab 1 learns of it only
// through supabase-js's cross-tab announcement of a session it never stored. Before the fix it
// merely ignored that and kept running as A — and everything A wrote from then on landed in the
// shared store that now belongs to B, to go up with B's next sync (BYOK keys, settings, chats).
// Real AuthContext, apiKeys, cloudSync, localOwner, chatStorage and chatSync; only the Supabase
// client (sessions, events, the chat_sync table) and the HTTP layer (apiClient) are faked.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDb } from '../tests/fakeIndexedDb';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

type FakeSession = { user: { id: string; email: string }; access_token: string; expires_at: number };
type Tab = { session: FakeSession | null; storedToken: string | null };

const h = vi.hoisted(() => ({
  /** Each AuthProvider is a tab, with its own session and its own stored (sessionStorage) token. */
  tabs: {} as Record<number, Tab>,
  /** The tab whose code is running right now. */
  active: 1,
  listeners: [] as { tab: number; cb: (event: string, session: unknown) => void }[],
  tab(): Tab {
    return (h.tabs[h.active] ??= { session: null, storedToken: null });
  },
  as<T>(tab: number, fn: () => T): T {
    const prev = h.active;
    h.active = tab;
    try {
      return fn();
    } finally {
      h.active = prev;
    }
  },
  /** Like supabase-js: every tab's subscribers hear every event (BroadcastChannel), stored or not. */
  emit(event: string, session: unknown) {
    for (const l of [...h.listeners]) h.as(l.tab, () => l.cb(event, session));
  },
  /** chat_sync: the signed-in user per token, the rows on the server, the upserts made. */
  cloudUser: null as string | null,
  upserts: [] as { key: string; user_id: string; kind: string; data: Record<string, unknown> }[],
}));

vi.mock('../services/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: h.tab().session } })),
      getUser: vi.fn(async () => ({ data: { user: h.cloudUser ? { id: h.cloudUser } : null } })),
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        const tab = h.active;
        h.listeners.push({ tab, cb });
        const initial = h.tabs[tab]?.session ?? null;
        queueMicrotask(() => h.as(tab, () => cb('INITIAL_SESSION', initial)));
        return { data: { subscription: { unsubscribe: () => (h.listeners = h.listeners.filter((l) => l.cb !== cb)) } } };
      }),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: vi.fn(() => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
      upsert: async (row: (typeof h.upserts)[number]) => {
        h.upserts.push(row);
        return { error: null };
      },
      delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    })),
  },
  getAuthRedirectUrl: () => '/auth/callback',
  isSessionExpiredByInactivity: () => false,
  // The real one compares the announced session with the one stored for THIS tab.
  isStoredSession: (session: { access_token?: string } | null) =>
    !session?.access_token || !h.tab().storedToken || session.access_token === h.tab().storedToken,
  // The real one removes this tab's stored session: from then on it has none.
  forgetTabSession: vi.fn(() => {
    h.tab().storedToken = null;
    h.tab().session = null;
  }),
  touchLastActivity: vi.fn(),
}));

const net = vi.hoisted(() => ({
  /** Every PUT of an account snapshot, with the account that owns the device at that moment (= whose cloud it goes to). */
  puts: [] as { as: string | null; data: { keys: { key: string }[] } }[],
}));
vi.mock('../services/apiClient', () => ({
  get: vi.fn(async (path: string) => (path === '/api/account/settings' ? { ok: true, data: null } : { ok: true, keys: [] })),
  put: vi.fn(async (_path: string, body: { data: (typeof net.puts)[number]['data'] }) => {
    net.puts.push({ as: localStorage.getItem('ds.localDataOwner'), data: body.data });
    return { ok: true };
  }),
}));
vi.mock('../services/deviceSessions', () => ({ registerDevice: vi.fn(async () => undefined) }));

const idb = createFakeIndexedDb();
vi.stubGlobal('indexedDB', idb);
afterAll(() => vi.unstubAllGlobals());

import { AuthProvider, OTHER_TAB_SIGN_IN_NOTICE, useAuth } from './AuthContext';
import { addKey, listKeys } from '../services/apiKeys';
import { appStatus } from '../services/appStatus';
import { createChatProject, createEmptySession, listChatSessions, saveChatSession, setChatSessionUser, syncFromCloud } from '../services/chatStorage';
import { getLocalOwner, setLocalOwner } from '../services/localOwner';
import { forgetTabSession, supabase } from '../services/supabase';

const session = (id: string): FakeSession => ({ user: { id, email: `${id.slice(0, 1)}@example.com` }, access_token: `t-${id}`, expires_at: 9_999_999_999 });

/** What a tab shows: who is signed in, and — Settings being a protected view — a way to add a key only while signed in. */
const TabView = ({ n, who }: { n: number; who: string }) => {
  const { user } = useAuth();
  return (
    <div>
      <span data-testid={`tab${n}-user`}>{user?.id ?? 'signed-out'}</span>
      {user && (
        <button type="button" data-testid={`tab${n}-add-key`} onClick={() => addKey({ provider: 'openai', key: `sk-${who}-typed-after-switch` })}>
          Add key
        </button>
      )}
    </div>
  );
};

const mountTab = async (n: number, who: string) => {
  h.active = n; // the tab whose code runs now: its mount effect reads ITS stored session
  await act(async () => {
    render(
      <AuthProvider>
        <TabView n={n} who={who} />
      </AuthProvider>
    );
  });
  await flush();
};
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const carries = (puts: typeof net.puts, needle: string) => puts.some((p) => JSON.stringify(p.data).includes(needle));

beforeEach(async () => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  idb.reset();
  appStatus.clear();
  h.tabs = {};
  h.listeners = [];
  h.cloudUser = null;
  h.upserts = [];
  net.puts = [];
  vi.mocked(forgetTabSession).mockClear();
  vi.mocked(supabase.auth.signOut).mockClear();
  setChatSessionUser(null);
  await listChatSessions(); // creates the chat database
});
afterEach(() => {
  vi.useRealTimers();
});

/** Tab 1 is A (its own stored session; A owns the device, as adopted at boot). */
const startAsA = async () => {
  h.tabs[1] = { session: session(A), storedToken: session(A).access_token };
  setLocalOwner(A);
  addKey({ provider: 'openai', key: 'sk-A-secret' });
  await mountTab(1, 'A');
  await advance(2_000); // A's login sync
  expect(screen.getByTestId('tab1-user')).toHaveTextContent(A);
  expect(net.puts.length).toBeGreaterThan(0);
};

/** In tab 2 (a fresh tab, signed out) a link for B is confirmed: B's session is stored THERE and announced everywhere. */
const switchToBInTab2 = async () => {
  h.tabs[2] = { session: null, storedToken: null };
  await mountTab(2, 'B');
  expect(screen.getByTestId('tab2-user')).toHaveTextContent('signed-out');
  h.tabs[2] = { session: session(B), storedToken: session(B).access_token };
  net.puts = [];
  await act(async () => h.emit('SIGNED_IN', session(B)));
  await advance(5_000); // B's login sync in tab 2
};

describe('AuthProvider — "Remember me" off: another tab switches the device to another account', () => {
  it('tab 1 steps aside: signed out here (no purge, no sign-out call), its own stored session forgotten, and told why', async () => {
    await startAsA();
    await switchToBInTab2();

    // Tab 2 is B and took the device: A's data was purged there.
    expect(screen.getByTestId('tab2-user')).toHaveTextContent(B);
    expect(getLocalOwner()).toBe(B);
    expect(listKeys()).toEqual([]);
    // Tab 1 no longer acts as A…
    expect(screen.getByTestId('tab1-user')).toHaveTextContent('signed-out');
    expect(forgetTabSession).toHaveBeenCalledOnce();
    expect(h.tabs[1].storedToken).toBeNull(); // a reload of tab 1 lands signed out — it can't take the device back as A
    // …without signing anyone out (that would reach tab 2 as SIGNED_OUT) or purging again.
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
    const [notice] = appStatus.getSnapshot().events;
    expect(notice).toMatchObject({ level: 'warn', message: OTHER_TAB_SIGN_IN_NOTICE });
  });

  it('a key typed in tab 1 after the switch never reaches B’s account: tab 1 can’t type one (signed out), and B’s next push carries nothing of A’s', async () => {
    await startAsA();
    await switchToBInTab2();

    // Tab 1: Settings is a protected view — nothing to type a key into any more.
    expect(screen.queryByTestId('tab1-add-key')).toBeNull();
    // (A's debounced push for a change it had made is dropped with the switch, not sent as B.)
    const sinceSwitch = net.puts.length;

    // B works on in tab 2; its next push is B's and carries only B's data.
    fireEvent.click(screen.getByTestId('tab2-add-key'));
    await advance(2_000);
    const later = net.puts.slice(sinceSwitch);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((p) => p.as === B)).toBe(true);
    expect(carries(later, 'sk-B-typed-after-switch')).toBe(true);
    expect(carries(later, 'sk-A-typed-after-switch')).toBe(false);
    expect(carries(net.puts, 'sk-A-secret')).toBe(false);
  });

  it('only a DIFFERENT account’s session makes tab 1 step aside — A’s own refresh announced by another tab changes nothing', async () => {
    await startAsA();
    net.puts = [];
    // Another tab of A's (its own session) refreshed its token.
    await act(async () => h.emit('TOKEN_REFRESHED', { ...session(A), access_token: 't-A-other-tab' }));
    await advance(2_000);
    expect(screen.getByTestId('tab1-user')).toHaveTextContent(A);
    expect(screen.getByTestId('tab1-add-key')).toBeInTheDocument();
    expect(forgetTabSession).not.toHaveBeenCalled();
    expect(appStatus.getSnapshot().events).toEqual([]);
    expect(getLocalOwner()).toBe(A);
    expect(listKeys().map((k) => k.key)).toEqual(['sk-A-secret']);
  });

  it('a signed-out tab hearing another tab’s sign-in has nothing to step aside from: nothing forgotten, no notice', async () => {
    h.tabs[1] = { session: null, storedToken: null };
    await mountTab(1, 'A');
    expect(screen.getByTestId('tab1-user')).toHaveTextContent('signed-out');
    h.tabs[2] = { session: session(B), storedToken: session(B).access_token };
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await advance(2_000);
    expect(forgetTabSession).not.toHaveBeenCalled();
    expect(appStatus.getSnapshot().events).toEqual([]);
  });
});

describe('AuthProvider — chats are tagged by the TAB’s account, not by the device marker', () => {
  it('a chat (or project) A starts while another tab already moved the device to B is A’s: pushed to A, never upserted as B, never shown to B', async () => {
    await startAsA();
    // Tab 2 just switched the device to B; the announcement has not reached tab 1 yet (or was missed).
    setLocalOwner(B);
    expect(screen.getByTestId('tab1-user')).toHaveTextContent(A);

    // Tab 1 (A, A's token): a NEW chat and a new project.
    h.cloudUser = A;
    const chat = createEmptySession({ title: 'A: private, typed after the switch' });
    const project = createChatProject('A: new folder', 'folder', 'blue');
    expect(chat.ownerUserId).toBe(A);
    expect(project.ownerUserId).toBe(A);
    await act(async () => {
      await saveChatSession(chat);
    });
    await flush();
    // It went up into A's own account (A's token, A's row) — nothing of it is B's.
    expect(h.upserts.map((u) => [u.user_id, u.data.title, u.data.ownerUserId])).toEqual([[A, 'A: private, typed after the switch', A]]);

    // Tab 2 (B): the chat screen mounts / reloads and syncs B's rows.
    h.cloudUser = B;
    setChatSessionUser(B); // what tab 2's AuthProvider did on B's session
    h.upserts = [];
    await act(async () => {
      await syncFromCloud();
    });
    await flush();
    expect(h.upserts.filter((u) => u.user_id === B)).toEqual([]);
    expect((await listChatSessions()).map((s) => s.title)).toEqual([]);
    expect(idb.rows('dreamstream_chat', 'sessions').map((r) => r.ownerUserId)).toEqual([A]);
  });
});
