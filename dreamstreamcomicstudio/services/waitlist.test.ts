// Register interest, client side: one neutral answer for every saved address, an 8 s deadline on
// the server call, a direct save (no email) when the server cannot answer, and the same stored
// shape whichever path saved the row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const insert = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { from: () => ({ insert }) } }));
const cfg = vi.hoisted(() => ({ check: false }));
vi.mock('./clientConfig', () => ({
  API_BASE_URL: 'https://api.test',
  buildApiUrl: (p: string) => `https://api.test${p}`,
  turnstileEnabled: () => cfg.check
}));

import {
  NEUTRAL_SUCCESS,
  SUBSCRIBE_DEADLINE_MS,
  cleanAnswers,
  interpretSubscribeResponse,
  submitWaitlistEmail
} from './waitlist';
import { interestMetadata } from '../shared/interest';

const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
  cfg.check = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
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
  it('429 is an honest wait-a-moment', () => {
    expect(interpretSubscribeResponse(false, 429, null)?.status).toBe('rate-limited');
  });
  it('400 verify: asks again with a check on the page, saves directly without one', () => {
    expect(interpretSubscribeResponse(false, 400, { status: 'verify', message: 'x' } as never, 'access', true)?.status).toBe('verify');
    expect(interpretSubscribeResponse(false, 400, { status: 'verify', message: 'x' } as never, 'access', false)).toBeNull();
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
  it('sends the cleaned answers to the server and returns the neutral answer', async () => {
    const fetchMock = vi.fn(() => reply(200, { ok: true, status: 'registered', message: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await submitWaitlistEmail(' A@B.co ', 'access', { source: 'auth' }, undefined, {
      firstName: '  ',
      features: ['chat', 'chat', 'nope' as never],
      studios: ['stream_studio'],
      comment: ' hi '
    });
    expect(res).toEqual({ ok: true, status: 'registered', message: NEUTRAL_SUCCESS.access });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ email: 'a@b.co', kind: 'access', source: 'auth', features: ['chat'], studios: ['stream_studio'], comment: 'hi' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('gives up on the server after the deadline and saves directly, with the same stored shape', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      )
    );
    const answers = { features: ['series' as const], featureOther: 'Voice', studios: ['dashboards' as const], comment: 'Note' };
    const pending = submitWaitlistEmail('a@b.co', 'access', { source: 'auth' }, undefined, answers);
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_DEADLINE_MS + 1);
    const res = await pending;
    expect(res).toEqual({ ok: true, status: 'registered', message: NEUTRAL_SUCCESS.access });
    expect(insert).toHaveBeenCalledWith({
      email: 'a@b.co',
      kind: 'access',
      source: 'auth',
      metadata: { source: 'auth', answers: { v: 1, features: ['series'], other: 'Voice', studios: ['dashboards'], comment: 'Note' } }
    });
    // The same builder the server stores with, so both paths write one shape.
    expect(insert.mock.calls[0]?.[0].metadata).toEqual(interestMetadata('auth', answers));
  });

  it('400 verify with no check on the page saves directly; with a check it asks again', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(400, { ok: false, status: 'verify', message: 'Please complete the check.' })));
    expect((await submitWaitlistEmail('a@b.co', 'access')).ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    cfg.check = true;
    const res = await submitWaitlistEmail('a@b.co', 'access');
    expect(res).toMatchObject({ ok: false, status: 'verify' });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('a repeat on the direct path (23505) gets the same answer as a new address', async () => {
    vi.stubGlobal('fetch', vi.fn(() => reply(503, { ok: false })));
    const first = await submitWaitlistEmail('a@b.co', 'access');
    insert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    const repeat = await submitWaitlistEmail('a@b.co', 'access');
    expect(repeat).toEqual(first);
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
    const long = cleanAnswers({ comment: 'x'.repeat(1200), featureOther: 'y'.repeat(200), firstName: 'z'.repeat(90) });
    expect(long.comment).toHaveLength(1000);
    expect(long.featureOther).toHaveLength(120);
    expect(long.firstName).toHaveLength(80);
    expect(
      cleanAnswers({
        firstName: 'A\u0000sha',
        featureOther: '  ',
        studios: ['dashboards', 'dashboards', 'nope' as never],
        comment: 'One\r\nTwo\u0007'
      })
    ).toEqual({ firstName: 'A sha', studios: ['dashboards'], comment: 'One\nTwo' });
  });
});
