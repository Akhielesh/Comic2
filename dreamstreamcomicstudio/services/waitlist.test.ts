import { afterEach, describe, expect, it, vi } from 'vitest';

// The direct-insert fallback writes through the public client; the fake answers like PostgREST.
const insertResult = vi.hoisted(() => ({ current: { error: null as null | { code?: string; message: string } } }));
vi.mock('./supabase', () => ({
  supabase: { from: () => ({ insert: async () => insertResult.current }) }
}));

import { interpretSubscribeResponse, submitWaitlistEmail } from './waitlist';

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

// When the backend is down the form inserts directly. Whoever typed an address must not learn
// whether it is already on the list, so a duplicate (23505) reads exactly like a new signup.
describe('submitWaitlistEmail offline fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    insertResult.current = { error: null };
  });

  it.each(['updates', 'access'] as const)('answers a duplicate %s signup exactly like a new one', async (kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    insertResult.current = { error: null };
    const fresh = await submitWaitlistEmail('new@example.com', kind);
    insertResult.current = { error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_waitlist_email_kind"' } };
    const duplicate = await submitWaitlistEmail('listed@example.com', kind);
    expect(fresh.ok).toBe(true);
    expect(duplicate).toEqual(fresh);
    expect(duplicate.message).not.toMatch(/already/i);
  });
});
