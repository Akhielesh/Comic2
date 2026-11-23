// Register interest, client side: one neutral answer for every saved address, an 8 s deadline on
// the server call, a direct save (no email) when the server cannot answer, and the same stored
// shape (the consent flag included) whichever path saved the row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const insert = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { from: () => ({ insert }) } }));
const cfg = vi.hoisted(() => ({ check: false }));
vi.mock('./clientConfig', () => ({
  API_BASE_URL: '',
  buildApiUrl: (p: string) => p,
  turnstileEnabled: () => cfg.check
}));

import {
  NEUTRAL_SUCCESS,
  SUBSCRIBE_DEADLINE_MS,
  cleanAnswers,
  interpretSubscribeResponse,
  submitWaitlistEmail
} from './waitlist';
import { INTEREST_THANKS, INTEREST_UPDATES, interestMetadata } from '../shared/interest';

const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
  cfg.check = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('interpretSubscribeResponse', () => {
  it('any 2xx ok answer becomes the one neutral success for its kind', () => {
    expect(interpretSubscribeResponse(true, 200, { ok: true, message: 'whatever' }, 'access')).toEqual({
      ok: true,
      status: 'registered',
      message: NEUTRAL_SUCCESS.access
    });
  });
  it('thanks for the answers only when some were sent', () => {
    expect(interpretSubscribeResponse(true, 200, { ok: true }, 'access', false, {})?.message).toBe('Thank you, you are on the list.');
    expect(interpretSubscribeResponse(true, 200, { ok: true }, 'access', false, { comment: 'Hi' })?.message).toBe(INTEREST_THANKS.accessWithAnswers);
  });
  it('429 is an honest wait-a-moment', () => {
    expect(interpretSubscribeResponse(false, 429, null)?.status).toBe('rate-limited');
  });
  it('400 verification is authoritative even if the page has no widget', () => {
    expect(interpretSubscribeResponse(false, 400, { status: 'verify', message: 'x' } as never, 'access', true)?.status).toBe('verify');
    expect(interpretSubscribeResponse(false, 400, { status: 'verify', message: 'x' } as never, 'access', false)).toMatchObject({ ok: false, status: 'verify', message: expect.stringMatching(/refresh/i) });
  });
  it('other 400s are shown as they are; server errors and odd bodies save directly', () => {
    expect(interpretSubscribeResponse(false, 400, { message: 'Your comment can be at most 1000 characters.' })).toMatchObject({
      ok: false,
      status: 'invalid'
    });
    expect(interpretSubscribeResponse(false, 503, { message: 'down' })).toBeNull();
    expect(interpretSubscribeResponse(true, 200, null)).toBeNull();
    expect(interpretSubscribeResponse(true, 200, { message: 'hi' })).toBeNull();
  });
});

describe('the neutral answer promises no email', () => {
  it('no success text mentions email, inbox, accounts or invites', () => {
    for (const text of Object.values(NEUTRAL_SUCCESS)) expect(text).not.toMatch(/email|inbox|account|invite|already/i);
  });
});

describe('submitWaitlistEmail', () => {
  it('sends the cleaned answers to the production same-origin endpoint and returns the neutral answer', async () => {
    const fetchMock = vi.fn(() => reply(200, { ok: true, status: 'registered', message: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await submitWaitlistEmail(' A@B.co ', 'access', { source: 'auth' }, undefined, {
      firstName: '  ',
      makes: ['kids', 'kids', 'nope' as never],
      heardFrom: 'friend',
      comment: ' hi '
    });
    expect(res).toEqual({ ok: true, status: 'registered', message: INTEREST_THANKS.accessWithAnswers });
    expect(fetchMock).toHaveBeenCalledWith('/api/newsletter/subscribe', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    // Register interest always says whether the box was ticked: here it was not.
    expect(body).toEqual({ email: 'a@b.co', kind: 'access', source: 'auth', makes: ['kids'], heardFrom: 'friend', comment: 'hi', keepUpdated: false });
    expect(insert).not.toHaveBeenCalled();
  });

  it('a ticked box travels as true and the thank-you says when they will hear; the list card never sends it', async () => {
    const fetchMock = vi.fn(() => reply(200, { ok: true, status: 'registered', message: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    const ticked = await submitWaitlistEmail('a@b.co', 'access', { source: 'auth' }, undefined, { keepUpdated: true });
    expect(ticked.message).toBe(`${INTEREST_THANKS.access} ${INTEREST_THANKS.keptUpdated}`);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).keepUpdated).toBe(true);
    await submitWaitlistEmail('a@b.co', 'updates', { source: 'home' }, undefined, { keepUpdated: true });
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).not.toHaveProperty('keepUpdated');
  });

  it('gives up on the server after the deadline and saves directly, with the same stored shape', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      )
    );
    const answers = { makes: ['webcomic' as const], heardFrom: 'search' as const, comment: 'Note', keepUpdated: true };
    const pending = submitWaitlistEmail('a@b.co', 'access', { source: 'auth' }, undefined, answers);
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_DEADLINE_MS + 1);
    const res = await pending;
    expect(res).toEqual({ ok: true, status: 'registered', message: `${INTEREST_THANKS.accessWithAnswers} ${INTEREST_THANKS.keptUpdated}` });
    // The consent time is when the person sent the form, not when the direct save ran after the deadline.
    const stamped = '2026-11-19T10:00:00.000Z';
    expect(insert).toHaveBeenCalledWith({
      email: 'a@b.co',
      kind: 'access',
      source: 'auth',
      metadata: {
        source: 'auth',
        answers: { v: 2, makes: ['webcomic'], heardFrom: 'search', comment: 'Note' },
        consent: { updates: true, at: stamped, wording: INTEREST_UPDATES.label }
      }
    });
    // The same builder the server stores with, so both paths write one shape.
    expect(insert.mock.calls[0]?.[0].metadata).toEqual(interestMetadata('auth', answers, stamped));
  });

  it('the direct save records an unticked box as an explicit no, and the list card with no consent at all', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(503, { ok: false })));
    await submitWaitlistEmail('a@b.co', 'access', { source: 'landing' });
    expect(insert.mock.calls[0]?.[0].metadata.consent).toMatchObject({ updates: false, wording: INTEREST_UPDATES.label });
    await submitWaitlistEmail('a@b.co', 'updates', { source: 'home' });
    expect(insert.mock.calls[1]?.[0].metadata).toEqual({ source: 'home' });
  });

  it('a verification refusal never falls back to a direct database write', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(400, { ok: false, status: 'verify', message: 'Please complete the check.' })));
    expect(await submitWaitlistEmail('a@b.co', 'access')).toMatchObject({ ok: false, status: 'verify' });
    expect(insert).not.toHaveBeenCalled();
    cfg.check = true;
    const res = await submitWaitlistEmail('a@b.co', 'access');
    expect(res).toMatchObject({ ok: false, status: 'verify' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('preserves verification when the API is down, and a server rejection when the widget is off', async () => {
    cfg.check = true;
    vi.stubGlobal('fetch', vi.fn(() => reply(503, { ok: false })));
    expect(await submitWaitlistEmail('a@b.co', 'access', {}, 'solved-token')).toMatchObject({ ok: false, status: 'unavailable' });
    cfg.check = false;
    vi.stubGlobal('fetch', vi.fn(() => reply(403, { ok: false })));
    expect(await submitWaitlistEmail('a@b.co', 'access')).toMatchObject({ ok: false, status: 'unavailable' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('a deployed page never skips server verification or mail processing during an outage', async () => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    expect(await submitWaitlistEmail('a@b.co', 'access')).toMatchObject({ ok: false, status: 'unavailable' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('a repeat on the direct path (23505) gets the same answer as a new address', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(503, { ok: false })));
    const first = await submitWaitlistEmail('a@b.co', 'access', {}, undefined, { comment: 'Hi', keepUpdated: false });
    insert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    const repeat = await submitWaitlistEmail('a@b.co', 'access', {}, undefined, { comment: 'Hi', keepUpdated: false });
    expect(repeat).toEqual(first);
  });

  it('a ticked box on a direct-path repeat (23505) is not promised: that save can only insert, so nothing recorded it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(503, { ok: false })));
    insert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    const repeat = await submitWaitlistEmail('a@b.co', 'access', {}, undefined, { keepUpdated: true });
    expect(repeat).toEqual({ ok: true, status: 'registered', message: INTEREST_THANKS.access });
    expect(repeat.message).not.toContain(INTEREST_THANKS.keptUpdated);
    // A new row on the same path stores the yes, so its thank-you may say they will hear.
    const fresh = await submitWaitlistEmail('b@b.co', 'access', {}, undefined, { keepUpdated: true });
    expect(fresh.message).toBe(`${INTEREST_THANKS.access} ${INTEREST_THANKS.keptUpdated}`);
  });

  it('a failed direct save is honest and retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    insert.mockResolvedValueOnce({ error: { code: '42501', message: 'denied' } });
    expect(await submitWaitlistEmail('a@b.co', 'access')).toMatchObject({ ok: false, status: 'unavailable' });
  });

  it('refuses a malformed email before sending anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await submitWaitlistEmail('nope', 'access')).toMatchObject({ ok: false, status: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('cleanAnswers', () => {
  it('cleans like the server, cuts to the caps, keeps known ids once, and leaves nothing for empty answers', () => {
    expect(cleanAnswers({})).toEqual({});
    const long = cleanAnswers({ comment: 'x'.repeat(1200), firstName: 'z'.repeat(90) });
    expect(long.comment).toHaveLength(1000);
    expect(long.firstName).toHaveLength(80);
    expect(
      cleanAnswers({
        firstName: 'A\u0000sha',
        makes: ['work', 'work', 'nope' as never],
        heardFrom: 'billboard' as never,
        comment: 'One\r\nTwo\u0007'
      })
    ).toEqual({ firstName: 'A sha', makes: ['work'], comment: 'One\nTwo' });
  });

  it('only a real true is a ticked box', () => {
    expect(cleanAnswers({ keepUpdated: true })).toEqual({ keepUpdated: true });
    expect(cleanAnswers({ keepUpdated: false })).toEqual({ keepUpdated: false });
    expect(cleanAnswers({ keepUpdated: 'yes' as never })).toEqual({ keepUpdated: false });
  });
});
