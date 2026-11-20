// The "new answer" set (notify SPEC §5.9, NF-3): page-scoped like the rest of chatStreams, a stable snapshot for
// useSyncExternalStore, subscribers told on a real change only, and gone on a reload (the test reset).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetChatStreamsForTests, getChatStreamsVersion, markAnswerSeen, markAnswerUnseen, subscribeChatStreams, unseenAnswerIds } from './chatStreams';

beforeEach(() => __resetChatStreamsForTests());

describe('unseen answers', () => {
  it('marks and clears a chat; the snapshot is the same Set until something changes', () => {
    const empty = unseenAnswerIds();
    expect(empty.size).toBe(0);
    expect(unseenAnswerIds()).toBe(empty);
    markAnswerUnseen('c1');
    const one = unseenAnswerIds();
    expect(one).not.toBe(empty);
    expect([...one]).toEqual(['c1']);
    expect(unseenAnswerIds()).toBe(one);
    markAnswerUnseen('c1'); // already marked: no change
    expect(unseenAnswerIds()).toBe(one);
    markAnswerUnseen('c2');
    markAnswerSeen('c1');
    expect([...unseenAnswerIds()]).toEqual(['c2']);
  });

  it('tells subscribers on a change only', () => {
    const fn = vi.fn();
    const off = subscribeChatStreams(fn);
    const v = getChatStreamsVersion();
    markAnswerUnseen('c1');
    markAnswerUnseen('c1');
    markAnswerSeen('c9'); // never marked
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getChatStreamsVersion()).toBe(v + 1);
    markAnswerSeen('c1');
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it('is never persisted: a reload (the module reset) forgets it, and nothing is written to storage', () => {
    localStorage.clear();
    sessionStorage.clear();
    markAnswerUnseen('c1');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    __resetChatStreamsForTests();
    expect(unseenAnswerIds().size).toBe(0);
  });
});
