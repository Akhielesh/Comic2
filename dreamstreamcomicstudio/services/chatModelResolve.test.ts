import { describe, it, expect } from 'vitest';
import { applyLockedChatModel } from './chatModelResolve';

const lock = { id: 'anthropic/claude-4.8-opus', source: 'openrouter' as const };

describe('applyLockedChatModel', () => {
  it('does not apply a lock when there is none', () => {
    expect(applyLockedChatModel({ locked: null, hasOverride: false, autoMode: true, sessionModelId: null })).toBeNull();
  });

  it('applies the lock to an Auto chat (the lock acts as the default model)', () => {
    expect(
      applyLockedChatModel({ locked: lock, hasOverride: false, autoMode: true, sessionModelId: null })
    ).toEqual(lock);
  });

  it('applies the lock to a chat with no pinned model', () => {
    expect(
      applyLockedChatModel({ locked: lock, hasOverride: false, autoMode: false, sessionModelId: null })
    ).toEqual(lock);
  });

  it('NEVER overrides a chat that has its own explicitly pinned model (the regression)', () => {
    // This is the bug: a chat pinned to model X must keep X even when a global lock is set,
    // so switching between chats can never surface the previous chat's / the locked model.
    expect(
      applyLockedChatModel({ locked: lock, hasOverride: false, autoMode: false, sessionModelId: 'google/gemini-2.5-flash' })
    ).toBeNull();
  });

  it('never applies the lock when a one-off override is driving the message', () => {
    expect(
      applyLockedChatModel({ locked: lock, hasOverride: true, autoMode: true, sessionModelId: null })
    ).toBeNull();
  });
});
