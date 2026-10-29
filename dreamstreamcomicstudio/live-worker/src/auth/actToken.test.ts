// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { ACT_TTL_S, actFrom, actTokensConfigured, mintActToken, resetActKeyCache, verifyActToken } from './actToken';
import { MemoryNonceStore } from './deviceToken';

const env = { ACT_TOKEN_KEY: 'k'.repeat(16) + 'this-is-only-a-test-key' };
const NID = '9d9d9d9d-1111-4222-8333-444455556666';
const UID = '0a0a0a0a-1111-4222-8333-444455556666';
const NOW = 1_800_000_000_000;

beforeEach(() => resetActKeyCache());

describe('service-worker action tokens', () => {
  it('stay dormant without a long enough key', async () => {
    expect(actTokensConfigured({})).toBe(false);
    expect(actTokensConfigured({ ACT_TOKEN_KEY: 'short' })).toBe(false);
    expect(await mintActToken({}, { nid: NID, inc: 'inc1', uid: UID }, NOW)).toBeNull();
    expect(await verifyActToken({}, 'a1.x.1.y', { nid: NID, inc: 'inc1' }, new MemoryNonceStore(), NOW)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('acknowledge one incident, once, for 30 minutes', async () => {
    expect(actTokensConfigured(env)).toBe(true);
    const t = await mintActToken(env, { nid: NID, inc: 'inc1', uid: UID }, NOW);
    expect(t!.exp).toBe(NOW / 1000 + ACT_TTL_S);
    expect(t!.token).toMatch(/^a1\.[0-9a-f-]{36}\.\d{10}\.[A-Za-z0-9_-]{43}$/);
    const used = new MemoryNonceStore();
    expect(await verifyActToken(env, t!.token, { nid: NID, inc: 'inc1' }, used, NOW + 60_000)).toEqual({ ok: true, uid: UID, exp: t!.exp });
    expect(await verifyActToken(env, t!.token, { nid: NID, inc: 'inc1' }, used, NOW + 61_000)).toEqual({ ok: false, reason: 'used' });
    const t2 = await mintActToken(env, { nid: NID, inc: 'inc1', uid: UID }, NOW);
    expect(await verifyActToken(env, t2!.token, { nid: NID, inc: 'inc1' }, new MemoryNonceStore(), NOW + ACT_TTL_S * 1000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('is bound to the nursery, the incident, the person and the key', async () => {
    const t = (await mintActToken(env, { nid: NID, inc: 'inc1', uid: UID }, NOW))!.token;
    const v = (tok: string, o = { nid: NID, inc: 'inc1' }, e = env) => verifyActToken(e, tok, o, new MemoryNonceStore(), NOW);
    expect(await v(t, { nid: '1d9d9d9d-1111-4222-8333-444455556666', inc: 'inc1' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await v(t, { nid: NID, inc: 'inc2' })).toEqual({ ok: false, reason: 'invalid' });
    const [a, , exp, mac] = t.split('.');
    expect(await v(`${a}.0b0b0b0b-1111-4222-8333-444455556666.${exp}.${mac}`)).toEqual({ ok: false, reason: 'invalid' });
    expect(await v(`${a}.${UID}.${Number(exp) + 3600}.${mac}`)).toEqual({ ok: false, reason: 'invalid' });
    resetActKeyCache();
    expect(await v(t, { nid: NID, inc: 'inc1' }, { ACT_TOKEN_KEY: 'another-key-another-key-another-key' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await v('a1.bad')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reads the DS-Act authorization header', async () => {
    const t = (await mintActToken(env, { nid: NID, inc: 'inc1', uid: 'g:guest-7' }, NOW))!.token;
    expect(actFrom(new Request('https://x/', { headers: { authorization: `DS-Act ${t}` } }))).toBe(t);
    expect(actFrom(new Request('https://x/', { headers: { authorization: `Bearer ${t}` } }))).toBeNull();
    expect(actFrom(new Request('https://x/', { headers: { authorization: 'DS-Act a1.x' } }))).toBeNull();
  });
});
