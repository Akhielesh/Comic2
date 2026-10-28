// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { makeDeviceTokenJwk, secretValue, thumbprint } from './genDeviceTokenKey.mjs';
import { mintDeviceGrant, resetDeviceKeyCache, verifyDeviceToken } from '../../live-worker/src/auth/deviceToken';

const UID = '0a0a0a0a-1111-4222-8333-444455556666';
const DEV = '7e7e7e7e-1111-4222-8333-444455556666';

describe('genDeviceTokenKey', () => {
  it('prints a P-256 private JWK whose kid is its thumbprint, which the Worker can sign and verify with', async () => {
    const jwk = await makeDeviceTokenJwk();
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwk.d).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(jwk.kid).toBe(await thumbprint(jwk));
    resetDeviceKeyCache();
    const env = { DEVICE_TOKEN_JWK: JSON.stringify(secretValue(jwk, null)) };
    const g = await mintDeviceGrant(env, { uid: UID, dev: DEV, jkt: 'J'.repeat(43), nids: [], scp: ['glance'] });
    expect(g).not.toBeNull();
    expect(await verifyDeviceToken(env, g!.token, 'grant')).toMatchObject({ ok: true, claims: { sub: UID } });
  });

  it('rotation puts the new key first and keeps the old ones verifying', async () => {
    const a = await makeDeviceTokenJwk();
    const b = await makeDeviceTokenJwk();
    const c = await makeDeviceTokenJwk();
    expect(secretValue(c, a)).toEqual({ keys: [c, a] });
    expect(secretValue(c, { keys: [b, a, { kty: 'EC' }] })).toEqual({ keys: [c, b, a] });
    expect(secretValue(c, c)).toEqual({ keys: [c] });
  });
});
