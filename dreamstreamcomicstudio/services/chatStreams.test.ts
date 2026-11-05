// services/chatStreams: the page-scoped memory a chat view shares with the views after it (CHAT-0,
// nav V.3-d). Busy and abort state survive an unmount; the newest copy of a chat written recently is
// kept (generating chats always, idle ones up to HOT_SESSION_LIMIT); in-flight artifact writes are
// tracked. No timers, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOT_SESSION_LIMIT,
  __resetChatStreamsForTests,
  abortStream,
  artifactWriteKey,
  beginArtifactWrite,
  beginStream,
  dropHotSession,
  endArtifactWrite,
  endStream,
  getHotSession,
  hotSessions,
  isArtifactWriteInFlight,
  isStreaming,
  putHotSession,
  streamingIds,
  subscribeChatStreams
} from './chatStreams';
import type { ChatSession } from './chatStorage';

const session = (id: string, updatedAt = 1) => ({ id, title: id, turns: [], updatedAt }) as unknown as ChatSession;

beforeEach(() => __resetChatStreamsForTests());
afterEach(() => vi.useRealTimers());

describe('chatStreams', () => {
  it('busy state outlives the view: begin/end/abort, and a newer stream is never ended by an older one', () => {
    const seen = vi.fn();
    subscribeChatStreams(seen);
    const first = new AbortController();
    beginStream('s1', first);
    const snap = streamingIds();
    expect(isStreaming('s1')).toBe(true);
    expect(streamingIds()).toBe(snap); // stable until something changes (useSyncExternalStore-safe)

    const second = new AbortController();
    beginStream('s1', second); // a regenerate replaced it
    endStream('s1', first);
    expect(isStreaming('s1')).toBe(true);
    endStream('s1', second);
    expect(isStreaming('s1')).toBe(false);
    expect(streamingIds()).not.toBe(snap);

    const third = new AbortController();
    beginStream('s2', third);
    abortStream('s2');
    expect(third.signal.aborted).toBe(true);
    expect(isStreaming('s2')).toBe(false);
    expect(seen).toHaveBeenCalled();
  });

  it('keeps generating chats hot always and at most HOT_SESSION_LIMIT idle ones (oldest written goes first)', () => {
    beginStream('busy', new AbortController());
    putHotSession(session('busy'));
    for (let i = 0; i < HOT_SESSION_LIMIT + 3; i++) putHotSession(session(`idle-${i}`));
    expect(getHotSession('busy')).toBeTruthy();
    expect(getHotSession('idle-0')).toBeUndefined();
    expect(getHotSession(`idle-${HOT_SESSION_LIMIT + 2}`)).toBeTruthy();
    expect(hotSessions().length).toBe(HOT_SESSION_LIMIT + 1);
    dropHotSession('busy');
    expect(getHotSession('busy')).toBeUndefined();
  });

  it('a silent put records without telling subscribers; a normal put tells them once', () => {
    const seen = vi.fn();
    subscribeChatStreams(seen);
    const s = session('a');
    putHotSession(s, { notify: false });
    expect(seen).not.toHaveBeenCalled();
    expect(getHotSession('a')).toBe(s);
    putHotSession(session('a', 2));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('tracks in-flight artifact writes by session, turn and artifact', () => {
    const key = artifactWriteKey('s1', 't1', '0:0');
    expect(key).toBe('s1:t1:0:0');
    beginArtifactWrite(key);
    expect(isArtifactWriteInFlight(key)).toBe(true);
    endArtifactWrite(key);
    expect(isArtifactWriteInFlight(key)).toBe(false);
  });

  it('schedules no timer of any kind (nothing here can wake the backend)', () => {
    vi.useFakeTimers();
    const c = new AbortController();
    beginStream('s', c);
    putHotSession(session('s'));
    beginArtifactWrite('k');
    endArtifactWrite('k');
    endStream('s', c);
    expect(vi.getTimerCount()).toBe(0);
  });
});
