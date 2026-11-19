// Chat's alert source (notify SPEC §5.9, NF-3): the kind per answer (a clarify card asks, a calendar card waits for a
// confirm, a failure, else a plain answer), the "new answer" mark only when the person is not looking at that chat,
// coming back to it clears the mark, and the waiting kinds are exactly Chat's acting card types.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ looking: null as null | { app: string; id: string }, focused: true, listeners: new Set<() => void>(), posted: [] as unknown[] }));
vi.mock('./bus', () => ({
  postAlert: (d: unknown) => bus.posted.push(d),
  isLooking: (t: { app: string; id: string }) => bus.focused && !!bus.looking && bus.looking.app === t.app && bus.looking.id === t.id,
  lookingTarget: () => bus.looking,
  onLookingChange: (fn: () => void) => {
    bus.listeners.add(fn);
    return () => bus.listeners.delete(fn);
  }
}));

import { ACTING_ARTIFACT_TYPES } from '../../components/chat/artifacts/ChatArtifacts';
import { createEmptySession } from '../chatStorage';
import { __resetChatStreamsForTests, putHotSession, retainChatView, unseenAnswerIds } from '../chatStreams';
import { CHAT_OPEN_EVENT, CHAT_WAITING_KINDS, chatAlertKind, chatAnswered, requestChatOpen, watchChatSeen } from './chatAlerts';

beforeEach(() => {
  __resetChatStreamsForTests();
  bus.looking = null;
  bus.focused = true;
  bus.listeners.clear();
  bus.posted = [];
});
afterEach(() => vi.restoreAllMocks());

describe('chatAlertKind', () => {
  it('a clarify card asks, a calendar card waits for a confirm, a failure fails, else an answer', () => {
    expect(chatAlertKind({ artifacts: [{ type: 'weather' }] })).toBe('chat_reply');
    expect(chatAlertKind({ artifacts: [] })).toBe('chat_reply');
    expect(chatAlertKind({})).toBe('chat_reply');
    expect(chatAlertKind({ artifacts: [{ type: 'map' }, { type: 'clarify' }] })).toBe('chat_question');
    expect(chatAlertKind({ artifacts: [{ type: 'calendar_event_draft' }] })).toBe('chat_confirm');
    expect(chatAlertKind({ artifacts: [{ type: 'calendar_event_draft' }, { type: 'clarify' }] })).toBe('chat_question');
    expect(chatAlertKind({ artifacts: [{ type: 'clarify' }], failed: true })).toBe('chat_failed');
  });

  it('the waiting kinds are exactly Chat’s acting card types', () => {
    expect(Object.keys(CHAT_WAITING_KINDS).sort()).toEqual([...ACTING_ARTIFACT_TYPES].sort());
  });
});

describe('chatAnswered', () => {
  it('posts one alert with the chat’s own title from the kept copy, and marks it unseen while elsewhere', () => {
    // A mounted chat view keeps its chats' newest copies (the answering chat's copy is kept while it streams).
    const release = retainChatView();
    putHotSession({ ...createEmptySession(), id: 'c1', title: 'Weekend plans' });
    chatAnswered({ sessionId: 'c1', turnId: 't1', artifacts: [{ type: 'clarify' }] });
    expect(bus.posted).toHaveLength(1);
    expect(bus.posted[0]).toMatchObject({ kind: 'chat_question', target: { app: 'chat', id: 'c1' }, title: 'Weekend plans' });
    expect(JSON.stringify(bus.posted[0])).not.toMatch(/content|text/);
    expect([...unseenAnswerIds()]).toEqual(['c1']);
    release();
  });

  it('while the person looks at that chat: no unseen mark (the core keeps the alert quiet)', () => {
    bus.looking = { app: 'chat', id: 'c1' };
    chatAnswered({ sessionId: 'c1', turnId: 't1' });
    expect(unseenAnswerIds().size).toBe(0);
    // Another chat is not looked at.
    chatAnswered({ sessionId: 'c2', turnId: 't2', failed: true });
    expect([...unseenAnswerIds()]).toEqual(['c2']);
    expect(bus.posted.map((d) => (d as { kind: string }).kind)).toEqual(['chat_reply', 'chat_failed']);
  });

  it('two answers in one chat are two alerts (distinct keys)', () => {
    chatAnswered({ sessionId: 'c1', turnId: 't1' });
    chatAnswered({ sessionId: 'c1', turnId: 't1' });
    const keys = bus.posted.map((d) => (d as { key: string }).key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('watchChatSeen', () => {
  it('coming back to a chat (looked at again) clears its mark', () => {
    chatAnswered({ sessionId: 'c1', turnId: 't1' });
    const off = watchChatSeen();
    bus.looking = { app: 'chat', id: 'c1' };
    bus.focused = false;
    bus.listeners.forEach((fn) => fn());
    expect([...unseenAnswerIds()]).toEqual(['c1']); // not focused yet: not seen
    bus.focused = true;
    bus.listeners.forEach((fn) => fn());
    expect(unseenAnswerIds().size).toBe(0);
    off();
    expect(bus.listeners.size).toBe(0);
  });
});

describe('requestChatOpen', () => {
  it('asks a mounted Chat to open the chat', () => {
    const seen = vi.fn();
    window.addEventListener(CHAT_OPEN_EVENT, (e) => seen((e as CustomEvent).detail));
    requestChatOpen('c7');
    expect(seen).toHaveBeenCalledWith({ id: 'c7' });
  });
});
