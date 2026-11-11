// services/chatStreams: the page-scoped memory a chat view shares with the views after it (CHAT-0,
// nav V.3-d). Busy and abort state survive an unmount; the newest copy of a chat written recently is
// kept (generating chats always, idle ones up to HOT_SESSION_LIMIT while a chat view is mounted, and
// none once no view is); in-flight artifact writes are tracked. No timers, no network.
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
  holdHotSession,
  hotSessions,
  isArtifactWriteInFlight,
  isStreaming,
  putHotSession,
  retainChatView,
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
    retainChatView(); // a chat view is mounted
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
    retainChatView();
    const seen = vi.fn();
    subscribeChatStreams(seen);
    const s = session('a');
    putHotSession(s, { notify: false });
    expect(seen).not.toHaveBeenCalled();
    expect(getHotSession('a')).toBe(s);
    putHotSession(session('a', 2));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('once the last chat view unmounts, only chats a write may still arrive for stay hot', () => {
    const releaseA = retainChatView();
    const releaseB = retainChatView(); // StrictMode, or two views for a moment
    const streaming = new AbortController();
    beginStream('streaming', streaming);
    for (const id of ['streaming', 'calendar', 'idle-1', 'idle-2']) putHotSession(session(id));
    const write = artifactWriteKey('calendar', 't1', '0:0');
    beginArtifactWrite(write);

    releaseA();
    expect(hotSessions().map((s) => s.id).sort()).toEqual(['calendar', 'idle-1', 'idle-2', 'streaming']); // a view is still up
    releaseB();
    releaseB(); // idempotent
    expect(hotSessions().map((s) => s.id).sort()).toEqual(['calendar', 'streaming']);

    // The reply lands after the view went: its copy is updated (kept), then dropped when it ends.
    putHotSession(session('streaming', 2));
    expect(getHotSession('streaming')?.updatedAt).toBe(2);
    endStream('streaming', streaming);
    expect(getHotSession('streaming')).toBeUndefined();
    endArtifactWrite(write);
    expect(hotSessions()).toEqual([]);

    // An idle chat written with no view mounted is not kept at all…
    putHotSession(session('late'));
    expect(getHotSession('late')).toBeUndefined();
    // …unless a save of it is held in flight (a second late change then builds on the first).
    const release = holdHotSession('late');
    putHotSession(session('late', 3));
    expect(getHotSession('late')?.updatedAt).toBe(3);
    release();
    expect(getHotSession('late')).toBeUndefined();

    // A view mounted again keeps recent chats hot as before.
    retainChatView();
    putHotSession(session('again'));
    expect(getHotSession('again')).toBeTruthy();
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
