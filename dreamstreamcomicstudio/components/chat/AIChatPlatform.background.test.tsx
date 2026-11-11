// @vitest-environment jsdom
// CHAT-0, bug B4 (nav N-1, V.3-d): Chat Studio unmounts on every view switch. A reply still
// streaming kept running, but its final save ran inside a `setSessions` updater — which React never
// runs after unmount — so the answer was lost; and a view mounted meanwhile did not know the chat was
// busy, and its next edit saved a stale copy over the answer. Now the save runs outside any updater,
// the busy/abort state and the newest copy live in services/chatStreams (module scope), and a
// remounted view merges the reply when it lands.
// Also B5 end to end: a calendar card's outcome is recorded on its turn in IndexedDB, so a reload
// never offers Confirm again — including a Confirm still in flight when the view went away.
// Also the phone drawer: Escape closes it, unless a menu (or the rename field) inside it takes the key.
// Real AIChatPlatform + chatStorage over an in-memory IndexedDB; the network (chat stream, calendar,
// Supabase) and the heavy chrome are faked.
import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createFakeIndexedDb } from '../../tests/fakeIndexedDb';
import type { ChatSession } from '../../services/chatStorage';

const U = '44444444-4444-4444-8444-444444444444';

const net = vi.hoisted(() => ({
  streams: [] as { body: unknown; opts: { onDelta?: (c: string) => void }; resolve: (v: unknown) => void; reject: (e: unknown) => void }[],
  mutate: [] as { resolve: (v: unknown) => void }[]
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: '44444444-4444-4444-8444-444444444444', email: 'u@example.com', user_metadata: { display_name: 'U' } } })
}));
vi.mock('../../services/billing', () => ({ getAdminAccess: vi.fn(async () => ({ isAdmin: false })) }));
vi.mock('../../services/modelCatalog', async (orig) => ({
  ...(await orig<typeof import('../../services/modelCatalog')>()),
  fetchModelCatalog: vi.fn(async () => ({ models: [] }))
}));
vi.mock('../../services/chatApi', () => ({
  sendChatMessageStream: vi.fn(
    (body: unknown, opts: { onDelta?: (c: string) => void }) =>
      new Promise((resolve, reject) => {
        net.streams.push({ body, opts, resolve, reject });
      })
  ),
  runSwarmStream: vi.fn(),
  updateChatMemory: vi.fn(async () => ({ memory: '' })),
  generateChatTitle: vi.fn(async () => ({ title: '' })),
  friendlyChatError: (e: unknown) => String(e)
}));
vi.mock('../../services/calendarApi', () => ({
  mutateEvent: vi.fn(
    () =>
      new Promise((resolve) => {
        net.mutate.push({ resolve });
      })
  )
}));
vi.mock('../../services/clientContext', () => ({ gatherClientContext: vi.fn(async () => undefined) }));
vi.mock('../../services/telemetry', () => ({ captureError: vi.fn(), captureEvent: vi.fn() }));
vi.mock('../../services/recipes', () => ({ runRecipe: vi.fn() }));
vi.mock('./AllowanceBanner', () => ({ AllowanceBanner: () => null }));
vi.mock('../usage/UsageMeter', () => ({ UsageMeter: () => null }));
// chat_sync: signed out (nothing syncs) — chatSync.testkit.ts.
vi.mock('../../services/supabase', async () => {
  const { createFakeChatSyncCloud, makeFakeChatSyncSupabase } = await import('../../services/chatSync.testkit');
  const fake = makeFakeChatSyncSupabase(createFakeChatSyncCloud());
  return {
    supabase: {
      ...fake,
      auth: {
        ...fake.auth,
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
      }
    }
  };
});
// The conversation pane: the turns (with their real artifact cards), the busy flag, send and rename.
vi.mock('./ChatConversation', async () => {
  const { ChatArtifacts } = await import('./artifacts/ChatArtifacts');
  return {
    ChatConversation: (props: { session: ChatSession; busy: boolean; onSend: (t: string, a: never[]) => void; onRenameTitle: (t: string) => void; onToggleSidebar: () => void }) => (
      <div>
        <button onClick={props.onToggleSidebar}>toggle sidebar</button>
        <p data-testid="state">{props.busy ? 'busy' : 'idle'}</p>
        <ol>
          {props.session.turns.map((t) => (
            <li key={t.id} data-role={t.role}>
              <span>{t.content}</span>
              {t.role === 'assistant' && <ChatArtifacts artifacts={t.artifacts} />}
            </li>
          ))}
        </ol>
        <button onClick={() => props.onSend('Plan my week', [])}>send</button>
        <button onClick={() => props.onRenameTitle('Week plan')}>rename</button>
      </div>
    )
  };
});

const idb = createFakeIndexedDb();
vi.stubGlobal('indexedDB', idb);
afterAll(() => vi.unstubAllGlobals());

import { AIChatPlatform } from './AIChatPlatform';
import { listChatSessions, setChatSessionUser } from '../../services/chatStorage';
import { __resetChatStreamsForTests, hotSessions } from '../../services/chatStreams';
import { setLocalOwner } from '../../services/localOwner';
import { mutateEvent } from '../../services/calendarApi';
import { sendChatMessageStream } from '../../services/chatApi';

const flush = async () => {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const mountChat = async () => {
  const view = render(<AIChatPlatform onBack={() => {}} projects={[]} />);
  await screen.findByRole('button', { name: 'send' });
  return view;
};
const stored = async (): Promise<ChatSession> => {
  const all = await listChatSessions();
  const withTurns = all.filter((s) => s.turns.length > 0);
  expect(withTurns).toHaveLength(1);
  return withTurns[0];
};
const startReply = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  await waitFor(() => expect(net.streams).toHaveLength(1));
  await act(async () => {
    net.streams[0].opts.onDelta?.('Monday: ');
  });
};
/** A page reload: module memory (chatStreams) is gone; only IndexedDB remains. */
const reloadPage = () => {
  cleanup();
  __resetChatStreamsForTests();
};

const CALENDAR = {
  type: 'calendar_event_draft',
  data: { action: 'create', connectionId: 'conn-1', canWrite: true, event: { title: 'Gym', start: '2026-11-09T07:00:00Z' } }
};

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  idb.reset();
  __resetChatStreamsForTests();
  net.streams = [];
  net.mutate = [];
  vi.mocked(sendChatMessageStream).mockClear();
  vi.mocked(mutateEvent).mockClear();
  setLocalOwner(U);
  setChatSessionUser(U);
  await listChatSessions();
});
afterEach(() => cleanup());

describe('a reply that finishes after the chat view unmounted is kept', () => {
  it('unmount mid-stream → the final turn is in IndexedDB', async () => {
    const view = await mountChat();
    await startReply();
    view.unmount(); // the user switched to another view while the answer streamed

    await act(async () => {
      net.streams[0].resolve({ text: 'Monday: gym. Tuesday: review.', model: 'test/model' });
    });
    await flush();

    const s = await stored();
    expect(s.turns.map((t) => [t.role, t.content])).toEqual([
      ['user', 'Plan my week'],
      ['assistant', 'Monday: gym. Tuesday: review.']
    ]);
  });

  it('remount mid-stream: busy (no second send); the stream finishes → the turn shows and survives a later edit', async () => {
    const first = await mountChat();
    await startReply();
    first.unmount();

    await mountChat();
    expect(screen.getByTestId('state').textContent).toBe('busy');
    expect(screen.getByText('Monday:')).toBeTruthy(); // the partial answer, from the shared copy
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await flush();
    expect(net.streams).toHaveLength(1); // no second reply racing the first

    await act(async () => {
      net.streams[0].resolve({ text: 'Monday: gym. Tuesday: review.', model: 'test/model' });
    });
    await flush();
    expect(await screen.findByText('Monday: gym. Tuesday: review.')).toBeTruthy();
    expect(screen.getByTestId('state').textContent).toBe('idle');

    // A later edit in the new view saves the answer with it — never a stale copy over it.
    fireEvent.click(screen.getByRole('button', { name: 'rename' }));
    await flush();
    const s = await stored();
    expect(s.title).toBe('Week plan');
    expect(s.turns.map((t) => t.content)).toEqual(['Plan my week', 'Monday: gym. Tuesday: review.']);

    // And after a reload it is all still there.
    reloadPage();
    await mountChat();
    expect(screen.getByText('Monday: gym. Tuesday: review.')).toBeTruthy();
  });
});

describe('a calendar card is never offered twice (B5, end to end)', () => {
  it('Confirm → done is saved on the turn; after a reload the card is one line with no Confirm', async () => {
    await mountChat();
    await startReply();
    await act(async () => {
      net.streams[0].resolve({ text: 'Shall I add it?', artifacts: [CALENDAR] });
    });
    await flush();
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));
    await waitFor(() => expect(net.mutate).toHaveLength(1));
    await act(async () => {
      net.mutate[0].resolve({ action: 'create', event: { htmlLink: 'https://calendar.google.com/e1' } });
    });
    await flush();

    reloadPage();
    const { container } = await mountChat();
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(container.querySelector('[data-settled="calendar_event_draft"]')?.textContent).toContain('Added to your calendar');
    expect(mutateEvent).toHaveBeenCalledTimes(1);
  });

  it('a Confirm still in flight when the view went away is recorded when it lands', async () => {
    const view = await mountChat();
    await startReply();
    await act(async () => {
      net.streams[0].resolve({ text: 'Shall I add it?', artifacts: [CALENDAR] });
    });
    await flush();
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));
    await waitFor(() => expect(net.mutate).toHaveLength(1));
    view.unmount();
    await act(async () => {
      net.mutate[0].resolve({ action: 'create', event: {} });
    });
    await flush();

    reloadPage();
    await mountChat();
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(screen.getByText(/Added to your calendar/)).toBeTruthy();
    const s = await stored();
    expect(Object.values(s.turns[1].artifactState ?? {})).toEqual([expect.objectContaining({ status: 'done' })]);
  });

  it('once the user sends a new message, an untouched card collapses to one line (D3)', async () => {
    await mountChat();
    await startReply();
    await act(async () => {
      net.streams[0].resolve({ text: 'Shall I add it?', artifacts: [CALENDAR] });
    });
    await flush();
    expect(screen.getByRole('button', { name: /create/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await flush();
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(screen.getByText(/Not added — you moved on/)).toBeTruthy();
  });
});

describe('a batch calendar card remounted while an earlier view is still adding (CHAT-0 review)', () => {
  const BATCH = {
    type: 'calendar_event_draft',
    data: { action: 'create', connectionId: 'conn-1', canWrite: true, event: { title: 'Flight' }, events: [{ title: 'Flight' }, { title: 'Hotel' }, { title: 'Dinner' }] }
  };

  it('shows the earlier view’s progress, adds nothing twice, and drops idle copies once no view is up', async () => {
    const first = await mountChat();
    await startReply();
    await act(async () => {
      net.streams[0].resolve({ text: 'Here is your trip.', artifacts: [BATCH] });
    });
    await flush();
    fireEvent.click(await screen.findByRole('button', { name: /add all 3/i }));
    await waitFor(() => expect(net.mutate).toHaveLength(1));
    first.unmount(); // Flight is being written
    // No view is up: only the chat with a write in flight is still held in memory.
    expect(hotSessions().map((h) => h.turns.length)).toEqual([2]);

    await act(async () => {
      net.mutate[0].resolve({ action: 'create', event: {} }); // Flight lands; the old loop moves to Hotel
    });
    await flush();
    expect(net.mutate).toHaveLength(2);

    await mountChat(); // the user comes back while Hotel is being written
    const progress = screen.getByRole('button', { name: /adding 1\/3/i }) as HTMLButtonElement;
    expect(progress.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /add the|add all/i })).toBeNull();

    await act(async () => {
      net.mutate[1].resolve({ action: 'create', event: {} });
    });
    await flush();
    await act(async () => {
      net.mutate[2].resolve({ action: 'create', event: {} });
    });
    await flush();
    expect(mutateEvent).toHaveBeenCalledTimes(3);
    expect(vi.mocked(mutateEvent).mock.calls.map((c) => (c[2] as { title: string }).title)).toEqual(['Flight', 'Hotel', 'Dinner']);
    expect(screen.queryByRole('button', { name: /add/i })).toBeNull();
    expect(screen.getByText('Added 3 events to your calendar')).toBeTruthy();

    // Leaving Chat Studio with nothing in flight keeps no chat in memory; IndexedDB has it all.
    cleanup();
    expect(hotSessions()).toEqual([]);
    const s = await stored();
    expect(Object.values(s.turns[1].artifactState ?? {})).toEqual([expect.objectContaining({ status: 'done' })]);
  });
});

describe('the phone drawer and Escape', () => {
  const drawerOpen = () => screen.queryByTitle('Account, theme & exit') !== null;
  const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

  it('Escape closes the drawer; a menu or the rename field inside it takes Escape first', async () => {
    expect(window.matchMedia('(min-width: 768px)').matches).toBe(false); // a phone
    await mountChat();
    await startReply();
    await act(async () => {
      net.streams[0].resolve({ text: 'Monday: gym.', model: 'test/model' });
    });
    await flush();

    expect(drawerOpen()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'toggle sidebar' }));
    expect(drawerOpen()).toBe(true);
    escape();
    expect(drawerOpen()).toBe(false);

    // A row menu inside the drawer: Escape closes the menu only.
    fireEvent.click(screen.getByRole('button', { name: 'toggle sidebar' }));
    fireEvent.click(screen.getByRole('button', { name: /options for plan my week/i }));
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
    escape();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(drawerOpen()).toBe(true);

    // The rename field: Escape cancels the rename only.
    fireEvent.click(screen.getByRole('button', { name: /options for plan my week/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByDisplayValue('Plan my week');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByDisplayValue('Plan my week')).toBeNull();
    expect(drawerOpen()).toBe(true);

    escape();
    expect(drawerOpen()).toBe(false);
  });
});
