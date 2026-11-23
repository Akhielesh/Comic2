// @vitest-environment node
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  available: vi.fn(), start: vi.fn(), read: vi.fn(), save: vi.fn(), exchange: vi.fn(), resolve: vi.fn(), issue: vi.fn(), captcha: vi.fn(),
}));
vi.mock('../services/googleLoginFlow.js', async original => ({
  ...await original<typeof import('../services/googleLoginFlow.js')>(), loginAvailable: f.available, googleAuthorization: f.start,
  readGoogleFlow: f.read, saveGoogleFlow: f.save, exchangeGoogleIdentity: f.exchange,
}));
vi.mock('../services/googleLoginAccounts.js', async original => ({
  ...await original<typeof import('../services/googleLoginAccounts.js')>(), resolveGoogleAccount: f.resolve, issueGoogleSession: f.issue,
}));
vi.mock('../services/turnstile.js', () => ({ turnstileConfigured: () => true, verifyTurnstile: (token: string) => f.captcha(token) }));
import { finishGoogleAuthorization, googleLoginRouter } from './googleLogin.js';
import { GoogleLoginAccountError } from '../services/googleLoginAccounts.js';

const origin = 'https://comics.dreamstreamstudio.ai';
const browserSecret = 'b'.repeat(43);
const grant = 'g'.repeat(43);
const identity = { sub: 'google-sub', email: 'creator@gmail.com', firstName: 'Ada' };
const stored = { data: { origin, identity, authoritativeEmail: true }, challenge: 'fixture' };
let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json()); app.use('/google', googleLoginRouter); app.get('/callback', finishGoogleAuthorization);
  await new Promise<void>(done => { server = app.listen(0, '127.0.0.1', done); });
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>(done => server.close(() => done())));
beforeEach(() => {
  vi.resetAllMocks(); f.available.mockResolvedValue(true); f.captcha.mockResolvedValue(true);
  f.read.mockResolvedValue(stored); f.resolve.mockResolvedValue('needs-profile');
  f.issue.mockResolvedValue({ tokenHash: 'hash' });
});
const post = (route: string, body: unknown, appOrigin = origin) => fetch(base + '/google/' + route, {
  method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
describe('Google login route', () => {
  it('starts only from an allowlisted app origin, using its bot check and an opaque browser challenge', async () => {
    const body = { browserChallenge: browserSecret, captchaToken: 'solved' };
    expect((await post('start', body, 'https://example.test')).status).toBe(400);
    expect((await post('start', { browserChallenge: browserSecret })).status).toBe(400);
    f.start.mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth');
    expect((await post('start', body)).status).toBe(200);
    expect(f.start).toHaveBeenCalledExactlyOnceWith(origin, browserSecret);
    expect(f.captcha).toHaveBeenCalledWith('solved');
  });
  it('consumes callback state once and returns only an opaque grant in the fragment', async () => {
    f.read.mockResolvedValueOnce({ data: { origin }, challenge: 'fixture' }).mockResolvedValueOnce(null);
    f.exchange.mockResolvedValue(stored.data); f.save.mockResolvedValue(grant);
    const path = '/callback?state=login.' + browserSecret + '&code=fixture';
    const res = await fetch(base + path, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe(origin + '/?view=auth#google_finish=' + grant);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(base + path, { redirect: 'manual' })).status).toBe(400);
    expect(f.exchange).toHaveBeenCalledOnce();
  });
  it('requires same-origin browser proof and profile before issuing a first session', async () => {
    const body = { browserSecret, grant };
    f.read.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...stored, data: { ...stored.data, origin: 'https://example.test' } });
    expect((await post('complete', body)).status).toBe(410);
    expect((await post('complete', body)).status).toBe(410);
    expect(await (await post('complete', body)).json()).toMatchObject({ needsProfile: true, email: identity.email });
    expect(f.issue).not.toHaveBeenCalled();
    f.read.mockResolvedValueOnce(stored).mockResolvedValueOnce(null);
    expect((await post('complete', { ...body, profile: {} })).status).toBe(410);
    expect(f.issue).not.toHaveBeenCalled();
  });
  it('refuses automatic email linking and external domains not vouched for by Google', async () => {
    f.resolve.mockResolvedValueOnce('email-conflict');
    expect((await post('complete', { browserSecret, grant })).status).toBe(409);
    f.read.mockResolvedValue({ ...stored, data: { ...stored.data, authoritativeEmail: false } });
    expect(await (await post('complete', { browserSecret, grant })).json()).toEqual({ message: expect.stringContaining('verify this address') });
    expect(f.issue).not.toHaveBeenCalled();
  });
  it('lets validation errors be corrected and signs an existing bound member in without changing their profile', async () => {
    f.issue.mockRejectedValueOnce(new GoogleLoginAccountError('invalid-profile', 'Check your date of birth.'));
    f.save.mockResolvedValueOnce('replacement');
    const first = await post('complete', { browserSecret, grant, profile: {} });
    expect(first.status).toBe(422); expect((await first.json()).grant).toBe('replacement');
    f.resolve.mockResolvedValueOnce('bound');
    const result = await post('complete', { browserSecret, grant, profile: { username: 'ignored' } });
    expect(await result.json()).toEqual({ tokenHash: 'hash' });
    expect(f.issue).toHaveBeenLastCalledWith(identity, undefined);
  });
});
