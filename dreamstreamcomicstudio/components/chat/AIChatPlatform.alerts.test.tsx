// @vitest-environment jsdom
// Chat's alert wiring (notify SPEC §5.9, NF-3): an answer that is saved, or a failure, calls the alert source once;
// Stop and a connected-data notice (the person's own move, a calm refusal) never do; the open chat is the one the
// person looks at while Chat is mounted, and nothing is looked at once it unmounts. Real AIChatPlatform over an
// in-memory IndexedDB, the network faked (the same harness as AIChatPlatform.background.test.tsx).
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
// The conversation pane: send and Stop.
vi.mock('./ChatConversation', () => ({
  ChatConversation: (props: { session: ChatSession; busy: boolean; onSend: (t: string, a: never[]) => void; onStop: () => void }) => (
    <div>
      <p data-testid="state">{props.busy ? 'busy' : 'idle'}</p>
      <button onClick={() => props.onSend('Plan my week', [])}>send</button>
      <button onClick={() => props.onStop()}>stop</button>
    </div>
  )
}));
// The alert source is spied (its own rules are chatAlerts.test.ts); the bus is real.
vi.mock('../../services/alerts/chatAlerts', async (orig) => ({
  ...(await orig<typeof import('../../services/alerts/chatAlerts')>()),
  chatAnswered: vi.fn()
}));

const idb = createFakeIndexedDb();
vi.stubGlobal('indexedDB', idb);
afterAll(() => vi.unstubAllGlobals());

import { AIChatPlatform } from './AIChatPlatform';
import { listChatSessions, setChatSessionUser } from '../../services/chatStorage';
import { __resetChatStreamsForTests } from '../../services/chatStreams';
import { setLocalOwner } from '../../services/localOwner';
import { sendChatMessageStream } from '../../services/chatApi';
import { chatAnswered } from '../../services/alerts/chatAlerts';
import { lookingTarget, setLooking } from '../../services/alerts/bus';

const flush = async () => {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const mountChat = async () => {
  const view = render(<AIChatPlatform onBack={() => {}} projects={[]} />);
  await screen.findByRole('button', { name: 'send' });
  return view;
};
const startReply = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'send' }));
  await waitFor(() => expect(net.streams).toHaveLength(1));
};
const answeredCalls = () => vi.mocked(chatAnswered).mock.calls.map((c) => c[0]);

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  idb.reset();
  __resetChatStreamsForTests();
  setLooking(null, 'chat');
  net.streams = [];
  net.mutate = [];
  vi.mocked(sendChatMessageStream).mockClear();
  vi.mocked(chatAnswered).mockClear();
  setLocalOwner(U);
  setChatSessionUser(U);
  await listChatSessions();
});
afterEach(() => cleanup());

describe('chat alerts', () => {
  it('an answer that is saved calls the alert source once, with its turn and artifacts', async () => {
    await mountChat();
    await startReply();
    const artifacts = [{ type: 'clarify', data: { question: 'Which week?', options: [] } }];
    await act(async () => {
      net.streams[0].resolve({ text: 'Which week do you mean?', model: 'test/model', artifacts });
    });
    await flush();
    expect(answeredCalls()).toHaveLength(1);
    const call = answeredCalls()[0];
    expect(call.failed).toBeFalsy();
    expect(call.artifacts).toEqual(artifacts);
    expect(typeof call.turnId).toBe('string');
    const [session] = (await listChatSessions()).filter((s) => s.turns.length);
    expect(call.sessionId).toBe(session.id);
  });

  it('a failure calls it with failed', async () => {
    await mountChat();
    await startReply();
    await act(async () => {
      net.streams[0].reject(new Error('The provider is down.'));
    });
    await flush();
    expect(answeredCalls()).toHaveLength(1);
    expect(answeredCalls()[0].failed).toBe(true);
  });

  it('Stop never alerts', async () => {
    await mountChat();
    await startReply();
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    await act(async () => {
      net.streams[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    await flush();
    expect(answeredCalls()).toEqual([]);
  });

  it('a connected-data notice never alerts', async () => {
    await mountChat();
    await startReply();
    await act(async () => {
      net.streams[0].reject(Object.assign(new Error('This chat uses your connected accounts, so it needs a standard model.'), { code: 'CONNECTED_DATA_NEEDS_STANDARD_MODEL' }));
    });
    await flush();
    expect(answeredCalls()).toEqual([]);
  });

  it('the open chat is what the person looks at while Chat is mounted; nothing once it unmounts', async () => {
    const view = await mountChat();
    await flush();
    const target = lookingTarget();
    expect(target?.app).toBe('chat');
    expect(typeof target?.id).toBe('string');
    view.unmount();
    expect(lookingTarget()).toBeNull();
  });
});
