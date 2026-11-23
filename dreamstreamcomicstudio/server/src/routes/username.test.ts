// @vitest-environment node
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usernameRouter } from './username.js';

const f = vi.hoisted(() => ({ rpc: vi.fn(), getUserById: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ getSupabaseAdmin: () => ({ rpc: f.rpc, auth: { admin: { getUserById: f.getUserById } } }) }));
const upstream = vi.fn();
const realFetch = globalThis.fetch;
let server: Server;
let url: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(usernameRouter);
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  vi.stubGlobal('fetch', upstream);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://auth.example.invalid');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-publishable');
});
beforeEach(() => { vi.resetAllMocks(); });
afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await new Promise<void>(resolve => server.close(() => resolve())); });
const post = (path: string, body: object) => realFetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('username endpoints', () => {
  it('checks case-insensitively, treats underscores literally, and offers only valid checked alternatives', async () => {
    f.rpc.mockResolvedValue({ data: [{ handle: 'art_cat', profile_id: 'private-id' }, { handle: 'art_cat_art', profile_id: 'other-private-id' }] });
    const response = await post('/check', { username: '  Art_Cat  ' });
    const result = await response.json();
    expect(result.available).toBe(false);
    expect(result.suggestions).toContain('Art_Cat_studio');
    expect(result.suggestions).not.toContain('Art_Cat_art');
    expect(JSON.stringify(result)).not.toContain('private-id');
    expect(f.rpc.mock.calls[0][1].candidates).toEqual(['Art_Cat', 'Art_Cat_art', 'Art_Cat_studio', expect.stringMatching(/^Art_Cat_\d+$/)]);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await post('/check', { username: 'mail@example.invalid' })).status).toBe(400);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });

  it('responds identically to unknown handles, failed grants and another account returned by the provider', async () => {
    const login = { username: 'Reader', password: 'fixture-secret' };
    f.rpc.mockResolvedValueOnce({ data: [] });
    const missing = await post('/signin', login);
    const neutral = await missing.json();
    expect(missing.status).toBe(401);
    f.rpc.mockResolvedValue({ data: [{ handle: 'reader', profile_id: 'owner' }] });
    f.getUserById.mockResolvedValue({ data: { user: { id: 'owner', email: 'private@example.invalid' } } });
    upstream.mockResolvedValueOnce(new Response('{}', { status: 400 }));
    const wrong = await post('/signin', login);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(neutral);
    upstream.mockResolvedValueOnce(Response.json({ user: { id: 'stranger', email_confirmed_at: 'now' }, access_token: 'private', refresh_token: 'private' }));
    const mismatch = await post('/signin', login);
    expect(mismatch.status).toBe(401);
    expect(await mismatch.json()).toEqual(neutral);
  });

  it('returns only a verified owner session and forwards the captcha to ordinary password authentication', async () => {
    f.rpc.mockResolvedValue({ data: [{ handle: 'reader', profile_id: 'owner' }] });
    f.getUserById.mockResolvedValue({ data: { user: { id: 'owner', email: 'private@example.invalid' } } });
    upstream.mockResolvedValueOnce(Response.json({ user: { id: 'owner', email_confirmed_at: 'now' }, access_token: 'access', refresh_token: 'refresh' }));
    const response = await post('/signin', { username: 'READER', password: 'fixture-password', captchaToken: 'fixture-captcha' });
    expect(await response.json()).toEqual({ access_token: 'access', refresh_token: 'refresh' });
    expect(JSON.parse(upstream.mock.calls[0][1].body)).toMatchObject({ email: 'private@example.invalid', gotrue_meta_security: { captcha_token: 'fixture-captcha' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
