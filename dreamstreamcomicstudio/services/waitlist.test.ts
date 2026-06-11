import { describe, expect, it } from 'vitest';
import { interpretSubscribeResponse } from './waitlist';

// The waitlist dedupe contract (server: POST /api/newsletter/subscribe):
//   - 2xx bodies are authoritative, INCLUDING ok:false 'account-exists' — the client
//     must surface "sign in instead" rather than falling back to a direct insert.
//   - 400 validation errors are authoritative failures.
//   - anything else → null → caller falls back to the direct Supabase capture.
describe('interpretSubscribeResponse', () => {
  it('passes through a successful new signup with its status', () => {
    const result = interpretSubscribeResponse(true, 200, {
      ok: true,
      status: 'joined',
      alreadyJoined: false,
      message: "Thanks! We'll email you the moment access opens up."
    });
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(result?.status).toBe('joined');
  });

  it('treats already-registered as an authoritative soft success', () => {
    const result = interpretSubscribeResponse(true, 200, {
      ok: true,
      status: 'already-registered',
      alreadyJoined: true,
      message: "You're already on the list."
    });
    expect(result?.ok).toBe(true);
    expect(result?.alreadyJoined).toBe(true);
    expect(result?.status).toBe('already-registered');
  });

  it('treats account-exists (2xx + ok:false) as authoritative — no fallback insert', () => {
    const result = interpretSubscribeResponse(true, 200, {
      ok: false,
      status: 'account-exists',
      message: 'You already have an account — sign in instead.'
    });
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.status).toBe('account-exists');
    expect(result?.message).toContain('sign in');
  });

  it('treats 400 validation errors as authoritative failures', () => {
    const result = interpretSubscribeResponse(false, 400, {
      ok: false,
      message: 'That email doesn’t look right — please check it.'
    });
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain('email');
  });

  it('returns null (→ fallback path) for server errors or unparseable bodies', () => {
    expect(interpretSubscribeResponse(false, 500, null)).toBeNull();
    expect(interpretSubscribeResponse(false, 502, { message: 'Bad gateway' })).toBeNull();
    expect(interpretSubscribeResponse(true, 200, null)).toBeNull();
    // 2xx with a malformed body (no ok flag) must not be trusted either.
    expect(interpretSubscribeResponse(true, 200, { message: 'hi' })).toBeNull();
  });
});
