import { describe, it, expect } from 'vitest';
import { friendlyChatError } from './chatErrors';

describe('friendlyChatError', () => {
  it('maps the bare undici/AbortController timeout string to an actionable message', () => {
    // This is the exact DOMException message Node emits when controller.abort() fires with
    // no reason — the opaque text users were seeing as "Couldn't complete that...".
    const out = friendlyChatError(new Error('This operation was aborted'));
    expect(out).toMatch(/too long/i);
    expect(out).not.toMatch(/aborted/i);
  });

  it('maps explicit timeout messages', () => {
    expect(friendlyChatError(new Error('The model stopped responding (no output for 60s).'))).toMatch(/too long/i);
    expect(friendlyChatError(new Error('OpenRouter timed out after 60s'))).toMatch(/too long/i);
  });

  it('maps transport/network failures', () => {
    expect(friendlyChatError(new Error('Failed to fetch'))).toMatch(/connection/i);
    expect(friendlyChatError(new Error('NetworkError when attempting to fetch resource'))).toMatch(/connection/i);
  });

  it('passes through a real, actionable server message unchanged', () => {
    const msg = 'Chat needs an OpenRouter or NVIDIA key. Add one in Settings.';
    expect(friendlyChatError(new Error(msg))).toBe(msg);
  });

  it('maps a shared-key spend cap / out-of-credits to a capacity message', () => {
    expect(friendlyChatError(new Error('Key limit exceeded (total limit)'))).toMatch(/capacity|free model/i);
    expect(friendlyChatError(new Error('402 Payment Required: requires more credits'))).toMatch(/credits|free model/i);
  });

  it('maps rate limiting to a wait-and-retry message', () => {
    expect(friendlyChatError(new Error('429 Too Many Requests'))).toMatch(/too many|wait/i);
  });

  it('hides raw DB errors (uuid / FK / schema cache) behind a generic message', () => {
    expect(friendlyChatError(new Error('invalid input syntax for type uuid: "demo-connection"'))).toMatch(
      /something went wrong|try again/i
    );
  });

  it('falls back gracefully on an empty/unknown error', () => {
    expect(friendlyChatError(undefined)).toMatch(/failed/i);
    expect(friendlyChatError({})).toMatch(/failed/i);
  });
});
