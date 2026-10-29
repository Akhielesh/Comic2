// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { unb64url } from '../webpush';
import {
  APNS_TOKEN_TTL_SEC,
  apnsAlertPayload,
  apnsConfigFromEnv,
  apnsLiveActivityPayload,
  apnsProviderToken,
  apnsReasonOutcome,
  apnsTopic,
  isApnsToken,
  resetApnsTokens,
  sendApns,
  type ApnsConfig,
} from './apns';
import { resetImportedKeys } from './keys';
import { jwtParts, recordingFetch, testP8, type FixtureResponse } from './testKit';
import fixtures from './fixtures/apns/responses.json';

interface Case {
  name: string;
  source: 'recorded' | 'documented';
  response: FixtureResponse & { headers: Record<string, string>; body: string };
  expect: string;
}
const fx = fixtures as unknown as { cases: Case[] };

const TOKEN = 'a'.repeat(64);
const NOW = Date.UTC(2026, 9, 28, 2, 14, 0);

let cfg: ApnsConfig;
let pub: CryptoKey;

beforeEach(async () => {
  resetApnsTokens();
  resetImportedKeys();
  const k = await testP8();
  pub = k.publicKey;
  cfg = { keyP8: k.p8, keyId: 'KEY1234567', teamId: 'TEAM123456', bundle: 'ai.dreamstreamstudio.streamstudio' };
});

const alert = (over: Partial<Parameters<typeof sendApns>[0]> = {}) => ({ token: TOKEN, type: 'alert' as const, payload: apnsAlertPayload({ title: 'DreamStream', body: 'Nursery alert', interruption: 'time-sensitive', e: 'CIPHER', s: 'u', i: 'inc1' }), ...over });

describe('APNs reason → outcome, against every recorded and documented response', () => {
  for (const c of fx.cases) {
    it(`${c.source}: ${c.name} → ${c.expect}`, async () => {
      const { fetcher } = recordingFetch(() => c.response);
      const out = await sendApns(alert(), cfg, { fetcher, now: NOW });
      // An expired provider token is retried once with a fresh one; the fixture answers the same, so it ends fatal.
      expect(out.outcome).toBe(c.expect);
      expect(out.status).toBe(c.response.status);
      if (c.response.headers['apns-id']) expect(out.apnsId).toBe(c.response.headers['apns-id']);
      if (c.response.status !== 200) expect(out.reason).toBe(JSON.parse(c.response.body).reason);
    });
  }

  it('reports when a 410 token was last confirmed dead (so a newer registration is not pruned)', async () => {
    const c = fx.cases.find((x) => x.response.status === 410 && x.response.body.includes('timestamp'))!;
    const { fetcher } = recordingFetch(() => c.response);
    expect((await sendApns(alert(), cfg, { fetcher, now: NOW })).invalidSince).toBe(1761600000000);
  });

  it('maps by status when there is no reason', () => {
    expect(apnsReasonOutcome(200)).toBe('ok');
    expect(apnsReasonOutcome(410)).toBe('gone');
    expect(apnsReasonOutcome(502)).toBe('retry');
    expect(apnsReasonOutcome(400)).toBe('fatal');
  });

  it('only an answer about the token prunes; a topic that does not match the token is config, whatever the status', () => {
    expect(apnsReasonOutcome(400, 'BadDeviceToken')).toBe('gone');
    expect(apnsReasonOutcome(410, 'Unregistered')).toBe('gone');
    for (const reason of ['DeviceTokenNotForTopic', 'TopicDisallowed', 'BadTopic', 'MissingTopic']) {
      expect(apnsReasonOutcome(400, reason), reason).toBe('config');
      expect(apnsReasonOutcome(410, reason), `410 ${reason}`).toBe('config');
    }
  });
});

describe('sendApns request', () => {
  it('posts to the right host and path with the push type, topic, priority, expiry and collapse id', async () => {
    const { fetcher, calls } = recordingFetch(() => ({ status: 200, headers: { 'apns-id': 'X' } }));
    const out = await sendApns(alert({ collapseId: 'a1b2c3d4e5f6', expiration: 1761618000, env: 'sandbox' }), cfg, { fetcher, now: NOW });
    expect(out).toMatchObject({ outcome: 'ok', status: 200, apnsId: 'X' });
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
    expect(c.headers).toMatchObject({
      'apns-push-type': 'alert',
      'apns-topic': 'ai.dreamstreamstudio.streamstudio',
      'apns-priority': '10',
      'apns-expiration': '1761618000',
      'apns-collapse-id': 'a1b2c3d4e5f6',
      'content-type': 'application/json',
    });
    expect(JSON.parse(c.body)).toEqual({
      aps: { alert: { title: 'DreamStream', body: 'Nursery alert' }, 'interruption-level': 'time-sensitive', 'mutable-content': 1 },
      e: 'CIPHER',
      s: 'u',
      i: 'inc1',
    });
  });

  it('signs a verifiable ES256 provider token: {alg, kid}.{iss, iat}', async () => {
    const { fetcher, calls } = recordingFetch(() => ({ status: 200 }));
    await sendApns(alert(), cfg, { fetcher, now: NOW });
    const jwt = calls[0].headers.authorization.replace(/^bearer /, '');
    const { header, claims, signed, sig } = jwtParts(jwt);
    expect(header).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(claims.iss).toBe('TEAM123456');
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(sig), new TextEncoder().encode(signed));
    expect(ok).toBe(true);
  });

  it('reuses the provider token for 50 minutes, with iat aligned so isolates agree', async () => {
    const t1 = await apnsProviderToken(cfg, NOW);
    const iat = jwtParts(t1).claims.iat as number;
    expect(iat % APNS_TOKEN_TTL_SEC).toBe(0);
    expect(Math.floor(NOW / 1000) - iat).toBeLessThan(APNS_TOKEN_TTL_SEC);
    expect(await apnsProviderToken(cfg, NOW + 60_000)).toBe(t1);
    // Next window: a new token, never older than 60 minutes when used.
    const t2 = await apnsProviderToken(cfg, (iat + APNS_TOKEN_TTL_SEC) * 1000 + 1);
    expect(t2).not.toBe(t1);
    expect(jwtParts(t2).claims.iat).toBe(iat + APNS_TOKEN_TTL_SEC);
  });

  it('mints a fresh token and retries once on ExpiredProviderToken', async () => {
    const { fetcher, calls } = recordingFetch((_c, n) => (n === 0 ? { status: 403, headers: { 'apns-id': 'A' }, body: '{"reason":"ExpiredProviderToken"}' } : { status: 200, headers: { 'apns-id': 'B' } }));
    const out = await sendApns(alert(), cfg, { fetcher, now: NOW });
    expect(out).toMatchObject({ outcome: 'ok', apnsId: 'B' });
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.authorization).not.toBe(calls[0].headers.authorization);
    expect(jwtParts(calls[1].headers.authorization.slice(7)).claims.iat).toBe(Math.floor(NOW / 1000));
  });

  it('a network failure (no HTTP/2 answer) is retry, and never throws', async () => {
    const { fetcher } = recordingFetch(() => {
      throw new TypeError('Network connection lost.');
    });
    expect(await sendApns(alert(), cfg, { fetcher, now: NOW })).toMatchObject({ outcome: 'retry', status: 0, reason: 'Network' });
  });

  it('refuses a malformed token without a request (and prunes it), and an oversize payload as fatal', async () => {
    const { fetcher, calls } = recordingFetch(() => ({ status: 200 }));
    expect(await sendApns(alert({ token: '../../3/device/x' }), cfg, { fetcher })).toMatchObject({ outcome: 'gone', reason: 'MalformedToken' });
    expect(await sendApns(alert({ payload: { aps: {}, pad: 'x'.repeat(4100) } }), cfg, { fetcher })).toMatchObject({ outcome: 'fatal', reason: 'PayloadTooLarge' });
    // VoIP allows 5 KB.
    expect((await sendApns({ token: TOKEN, type: 'voip', payload: { pad: 'x'.repeat(4100) } }, cfg, { fetcher })).outcome).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('a broken key is fatal, not a crash', async () => {
    const { fetcher, calls } = recordingFetch(() => ({ status: 200 }));
    const out = await sendApns(alert(), { ...cfg, keyP8: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }, { fetcher });
    expect(out).toMatchObject({ outcome: 'fatal', reason: 'NoKey' });
    expect(calls).toHaveLength(0);
  });

  it('derives each push type’s topic and default priority', async () => {
    expect(apnsTopic('b', 'alert')).toBe('b');
    expect(apnsTopic('b', 'voip')).toBe('b.voip');
    expect(apnsTopic('b', 'liveactivity')).toBe('b.push-type.liveactivity');
    expect(apnsTopic('b', 'widgets')).toBe('b.push-type.widgets');
    const { fetcher, calls } = recordingFetch(() => ({ status: 200 }));
    await sendApns({ token: TOKEN, type: 'liveactivity', payload: apnsLiveActivityPayload({ event: 'update', timestamp: 1, contentState: { m: 'calm' } }) }, cfg, { fetcher });
    expect(calls[0].headers['apns-priority']).toBe('5');
    expect(calls[0].headers['apns-topic']).toBe('ai.dreamstreamstudio.streamstudio.push-type.liveactivity');
  });

  it('clips a collapse id to 64 bytes', async () => {
    const { fetcher, calls } = recordingFetch(() => ({ status: 200 }));
    await sendApns(alert({ collapseId: 'c'.repeat(80) }), cfg, { fetcher });
    expect(calls[0].headers['apns-collapse-id']).toHaveLength(64);
  });
});

describe('payload builders', () => {
  it('critical alerts carry the critical sound; others a plain sound only when asked', () => {
    expect(apnsAlertPayload({ title: 't', body: 'b', interruption: 'critical' }).aps).toMatchObject({ sound: { critical: 1, name: 'default', volume: 1 }, 'interruption-level': 'critical' });
    expect(apnsAlertPayload({ title: 't', body: 'b', interruption: 'active', sound: true }).aps).toMatchObject({ sound: 'default' });
    expect((apnsAlertPayload({ title: 't', body: 'b', interruption: 'passive' }).aps as Record<string, unknown>).sound).toBeUndefined();
    // No envelope: no mutable-content (nothing for the extension to decrypt).
    expect((apnsAlertPayload({ title: 't', body: 'b', interruption: 'passive' }).aps as Record<string, unknown>)['mutable-content']).toBeUndefined();
  });

  it('push-to-start Live Activity carries attributes and the alert iOS requires', () => {
    const p = apnsLiveActivityPayload({ event: 'start', timestamp: 1761100020.4, contentState: { m: 'calm', ms: 1 }, staleDate: 1761100920, alert: { title: 'DreamStream', body: 'Nursery monitor is on' } });
    expect(p).toEqual({
      aps: {
        timestamp: 1761100020,
        event: 'start',
        'content-state': { m: 'calm', ms: 1 },
        'stale-date': 1761100920,
        'attributes-type': 'NurseryAttributes',
        attributes: {},
        alert: { title: 'DreamStream', body: 'Nursery monitor is on' },
      },
    });
  });
});

describe('config', () => {
  it('stays dormant until all three secrets are set and well-formed', () => {
    expect(apnsConfigFromEnv({})).toBeNull();
    expect(apnsConfigFromEnv({ APNS_KEY_P8: '-----BEGIN PRIVATE KEY-----x', APNS_KEY_ID: 'KEY1234567' })).toBeNull();
    expect(apnsConfigFromEnv({ APNS_KEY_P8: '-----BEGIN PRIVATE KEY-----x', APNS_KEY_ID: 'short', APNS_TEAM_ID: 'TEAM123456' })).toBeNull();
    expect(apnsConfigFromEnv({ APNS_KEY_P8: '-----BEGIN PRIVATE KEY-----x', APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'TEAM123456' })).toMatchObject({
      keyId: 'KEY1234567',
      teamId: 'TEAM123456',
      bundle: 'ai.dreamstreamstudio.streamstudio',
    });
  });

  it('accepts only hex tokens (they go in the URL path)', () => {
    expect(isApnsToken('ab'.repeat(32))).toBe(true);
    expect(isApnsToken('ab'.repeat(50))).toBe(true);
    expect(isApnsToken('ab'.repeat(31))).toBe(false);
    expect(isApnsToken(`${'a'.repeat(64)}/x`)).toBe(false);
    expect(isApnsToken(null)).toBe(false);
  });
});
