// @vitest-environment node
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CATALOG_MAINTENANCE_AUDIENCE, CATALOG_MAINTENANCE_ISSUER, createMaintenanceAuthenticator, validateMaintenanceClaims } from './catalogMaintenanceAuth.js';

const now = Date.parse('2026-11-14T02:00:00Z');
const seconds = now / 1000;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'github-key', alg: 'RS256', use: 'sig' };
const claims = (changes = {}) => ({
  iss: CATALOG_MAINTENANCE_ISSUER, aud: CATALOG_MAINTENANCE_AUDIENCE,
  repository: 'Akhielesh/Comic2', repository_id: '1151761968', repository_owner: 'Akhielesh', repository_owner_id: '102168504',
  ref: 'refs/heads/Dreamstrream-v1', ref_type: 'branch',
  sub: 'repo:Akhielesh/Comic2:ref:refs/heads/Dreamstrream-v1',
  workflow_ref: 'Akhielesh/Comic2/.github/workflows/refresh-model-catalog.yml@refs/heads/Dreamstrream-v1',
  event_name: 'schedule', runner_environment: 'github-hosted', run_id: '43521777624', run_attempt: '1',
  iat: seconds - 5, nbf: seconds - 5, exp: seconds + 295, jti: 'unique-test-token', ...changes
});
const token = (payload = claims(), header = { alg: 'RS256', typ: 'JWT', kid: 'github-key' }) => {
  const input = [header, payload].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
};
const fetchKeys = () => vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ keys: [jwk] }));

describe('catalog maintenance GitHub OIDC trust', () => {
  it('verifies a real RSA signature, uses only fixed GitHub JWKS, and rejects replay', async () => {
    const fetcher = fetchKeys();
    const authenticate = createMaintenanceAuthenticator(fetcher as typeof fetch, () => now);
    await expect(authenticate(token(), 'refresh')).resolves.toEqual({ runId: '43521777624', attempt: '1' });
    expect(fetcher.mock.calls[0][0]).toBe('https://token.actions.githubusercontent.com/.well-known/jwks');
    await expect(authenticate(token(), 'refresh')).rejects.toThrow('MAINTENANCE_UNAUTHORIZED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { repository_id: 'other' }, { repository_owner_id: 'other' }, { repository: 'attacker/Comic2' },
    { repository_owner: 'attacker' }, { ref: 'refs/heads/feature' }, { event_name: 'pull_request' },
    { workflow_ref: 'Akhielesh/Comic2/.github/workflows/ci.yml@refs/heads/Dreamstrream-v1' },
    { iss: 'https://attacker.invalid' }, { aud: 'another-service' }, { sub: 'repo:other/Comic2:ref:refs/heads/Dreamstrream-v1' },
    { exp: seconds - 1 }, { exp: seconds + 3600 }, { nbf: seconds + 100 }, { iat: seconds - 1000 },
    { runner_environment: 'self-hosted' }, { job_workflow_ref: 'other/workflow' }, { jti: undefined }
  ])('rejects changed trust claims before fetching keys: %j', async (change) => {
    const fetcher = fetchKeys();
    await expect(createMaintenanceAuthenticator(fetcher as typeof fetch, () => now)(token(claims(change)), 'refresh')).rejects.toThrow('MAINTENANCE_UNAUTHORIZED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts the immutable ID subject only with all other trust claims', () => {
    expect(() => validateMaintenanceClaims(claims({ sub: 'repo:Akhielesh@102168504/Comic2@1151761968:ref:refs/heads/Dreamstrream-v1' }), 'refresh', now)).not.toThrow();
  });
  it('rejects cross-operation tokens and tampered signatures', async () => {
    const authenticate = createMaintenanceAuthenticator(fetchKeys() as typeof fetch, () => now);
    await expect(authenticate(token(), 'probe-nvidia')).rejects.toThrow();
    const parts = token().split('.');
    const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
    await expect(authenticate(`${parts[0]}.${parts[1]}.${signature.toString('base64url')}`, 'refresh')).rejects.toThrow();
  });
  it('fails closed for a key service outage and refuses algorithm confusion', async () => {
    const fetcher = vi.fn(async () => { throw new Error('private upstream details'); });
    const authenticate = createMaintenanceAuthenticator(fetcher as typeof fetch, () => now);
    await expect(authenticate(token(), 'refresh')).rejects.toThrow('MAINTENANCE_UNAUTHORIZED');
    await expect(authenticate(token(claims(), { alg: 'HS256', typ: 'JWT', kid: 'github-key' }), 'refresh')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
