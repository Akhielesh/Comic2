// @vitest-environment node
import { createSign, generateKeyPairSync } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../config.js', async original => ({ ...await original<typeof import('../config.js')>(), GOOGLE_OAUTH_CLIENT_ID: 'fixture-client', GOOGLE_OAUTH_CLIENT_SECRET: 'fixture-secret' }));
import { exchangeGoogleIdentity } from './googleLoginFlow.js';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const cert = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const state = { nonce: 'nonce-from-state', verifier: 'pkce-from-state', origin: 'https://comics.dreamstreamstudio.ai' };
const claims = () => ({ sub: 'stable-subject', email: 'person@gmail.com', given_name: 'Ada', email_verified: true,
  iss: 'https://accounts.google.com', aud: 'fixture-client', azp: 'fixture-client', nonce: state.nonce,
  iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 1000,
});
function mockResponse(payload: Record<string, unknown>, badSignature = false) {
  vi.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({ certs: { key: cert } } as never);
  const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString('base64url');
  const content = encode({ kid: 'key', typ: 'JWT', alg: 'RS256' }) + '.' + encode(payload);
  const signature = createSign('RSA-SHA256').update(content).sign(privateKey).toString('base64url');
  const token = content + '.' + (badSignature ? 'tampered' : signature);
  const fetch = vi.fn(async () => Response.json({ id_token: token, access_token: 'unused' }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Google OIDC identity verification', () => {
  it('verifies the signed ID token for the original PKCE exchange and classifies address authority', async () => {
    const fetch = mockResponse(claims());
    expect(await exchangeGoogleIdentity('code', state)).toEqual({ identity: { sub: 'stable-subject', email: 'person@gmail.com', firstName: 'Ada' }, authoritativeEmail: true, origin: state.origin });
    expect(fetch).toHaveBeenCalledWith('https://oauth2.googleapis.com/token', expect.objectContaining({ redirect: 'error' }));
    expect((vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as URLSearchParams).get('code_verifier')).toBe(state.verifier);
  });
  it.each([
    [{ aud: 'other-app' }], [{ iss: 'https://example.test' }], [{ nonce: 'different' }], [{ sub: '' }],
    [{ email_verified: false }], [{ email_verified: 'false' }], [{ exp: Math.floor(Date.now()/1000) - 30 }],
    [{ azp: 'another-client' }],
  ])('refuses invalid verified claims (%o)', async changed => {
    mockResponse({ ...claims(), ...changed });
    await expect(exchangeGoogleIdentity('code', state)).rejects.toThrow();
  });
  it('rejects a tampered signature', async () => {
    mockResponse(claims(), true);
    await expect(exchangeGoogleIdentity('code', state)).rejects.toThrow();
  });
  it.each([[undefined, false], ['company.test', true]])('treats a non-Gmail address as authoritative only for Google Workspace', async (hd, authoritativeEmail) => {
    mockResponse({ ...claims(), hd, email: 'ada@company.test' });
    expect((await exchangeGoogleIdentity('code', state)).authoritativeEmail).toBe(authoritativeEmail);
  });
});
