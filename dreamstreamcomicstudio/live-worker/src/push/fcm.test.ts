// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { unb64url } from '../webpush';
import { FCM_SCOPE, fcmAccessToken, fcmConfigFromEnv, fcmErrorOutcome, isFcmToken, resetFcmTokens, sendFcm, type FcmConfig } from './fcm';
import { resetImportedKeys } from './keys';
import { jwtParts, recordingFetch, testServiceAccount, type FixtureResponse, type RecordedCall } from './testKit';
import fixtures from './fixtures/fcm/responses.json';

interface Case {
  name: string;
  source: 'recorded' | 'documented';
  response: FixtureResponse & { headers: Record<string, string>; body: string };
  expect: string;
  errorCode?: string;
}
const fx = fixtures as unknown as { send: Case[]; oauth: Case[] };

const TOKEN = 'fGx1Q2s3T4u5V6w7X8y9Z0:APA91bH-test_registration_token_0123456789abcdefghijklmnopqrstuvwxyz';
const NOW = Date.UTC(2026, 9, 28, 2, 14, 0);
const OAUTH_OK = fx.oauth.find((c) => c.expect === 'ok')!.response;

let cfg: FcmConfig;
let pub: CryptoKey;

beforeEach(async () => {
  resetFcmTokens();
  resetImportedKeys();
  const sa = await testServiceAccount();
  pub = sa.publicKey;
  cfg = fcmConfigFromEnv({ FCM_SA_JSON: sa.json })!;
});

/** Google's two hosts: the token endpoint answers `oauth`, FCM answers `send(n)`. */
function google(send: (n: number, call: RecordedCall) => FixtureResponse | Response, oauth: (n: number) => FixtureResponse | Response = () => OAUTH_OK) {
  let sends = 0;
  let tokens = 0;
  return recordingFetch((call) => (call.url.startsWith('https://oauth2.googleapis.com/') ? oauth(tokens++) : send(sends++, call)));
}

const alert = { token: TOKEN, data: { e: 'CIPHER', s: 'u', i: 'a1b2c3d4e5f6', q: '812' }, androidPriority: 'high' as const, ttl: 300, collapseKey: 'a1b2c3d4e5f6' };

describe('FCM error → outcome, against every recorded and documented response', () => {
  for (const c of fx.send) {
    it(`${c.source}: ${c.name} → ${c.expect}`, async () => {
      const { fetcher } = google(() => c.response);
      const out = await sendFcm(alert, cfg, { fetcher, now: NOW });
      expect(out.outcome).toBe(c.expect);
      expect(out.status).toBe(c.response.status);
      if (c.errorCode) expect(out.errorCode).toBe(c.errorCode);
    });
  }

  it('only an error that names the token prunes it: a payload bug never wipes the registry', () => {
    const payloadBug = fx.send.find((c) => c.name.startsWith('our payload is wrong'))!;
    expect(fcmErrorOutcome(400, JSON.parse(payloadBug.response.body)).outcome).toBe('fatal');
    expect(fcmErrorOutcome(404, { error: { status: 'NOT_FOUND', message: 'Project not found' } }).outcome).toBe('fatal');
  });

  it('reads Retry-After on quota errors', async () => {
    const quota = fx.send.find((c) => c.errorCode === 'QUOTA_EXCEEDED')!;
    const { fetcher } = google(() => quota.response);
    expect((await sendFcm(alert, cfg, { fetcher, now: NOW })).retryAfterSec).toBe(30);
  });
});

describe('sendFcm request', () => {
  it('sends a data-only, high-priority Android message with ttl and collapse key', async () => {
    const ok = fx.send.find((c) => c.expect === 'ok')!;
    const { fetcher, calls } = google(() => ok.response);
    const out = await sendFcm(alert, cfg, { fetcher, now: NOW });
    expect(out).toMatchObject({ outcome: 'ok', status: 200, name: 'projects/dreamstream-test/messages/0:1761617640123456%31bd1c9631bd1c96' });
    const send = calls.find((c) => c.url.includes('fcm.googleapis.com'))!;
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/dreamstream-test/messages:send');
    expect(send.headers.authorization).toBe('Bearer ya29.c.test-access-token');
    expect(JSON.parse(send.body)).toEqual({
      message: {
        token: TOKEN,
        data: { e: 'CIPHER', s: 'u', i: 'a1b2c3d4e5f6', q: '812' },
        android: { priority: 'HIGH', ttl: '300s', collapse_key: 'a1b2c3d4e5f6' },
      },
    });
    // No `notification` block: Google sees no text.
    expect(send.body).not.toContain('notification');
  });

  it('carries an apns block (and a Live Activity token) for iPhones on the FCM fallback', async () => {
    const { fetcher, calls } = google(() => ({ status: 200, body: '{"name":"n"}' }));
    await sendFcm({ token: TOKEN, apns: { headers: { 'apns-priority': '5' }, payload: { aps: { event: 'update', timestamp: 1, 'content-state': { m: 'calm' } } }, liveActivityToken: 'ab'.repeat(32) } }, cfg, { fetcher, now: NOW });
    const msg = JSON.parse(calls[1].body).message;
    expect(msg.apns).toEqual({ headers: { 'apns-priority': '5' }, payload: { aps: { event: 'update', timestamp: 1, 'content-state': { m: 'calm' } } }, live_activity_token: 'ab'.repeat(32) });
    expect(msg.android).toBeUndefined();
  });

  it('exchanges a verifiable RS256 service-account assertion for the OAuth token', async () => {
    const { fetcher, calls } = google(() => ({ status: 200, body: '{"name":"n"}' }));
    await sendFcm(alert, cfg, { fetcher, now: NOW });
    const tok = calls[0];
    expect(tok.url).toBe('https://oauth2.googleapis.com/token');
    expect(tok.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(tok.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const { header, claims, signed, sig } = jwtParts(form.get('assertion')!);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'test0key0id' });
    expect(claims).toEqual({ iss: 'fcm-sender@dreamstream-test.iam.gserviceaccount.com', scope: FCM_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: NOW / 1000, exp: NOW / 1000 + 3600 });
    expect(await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, pub, unb64url(sig), new TextEncoder().encode(signed))).toBe(true);
  });

  it('caches the OAuth token for 55 minutes, shared by concurrent senders', async () => {
    const { fetcher, calls } = google(() => ({ status: 200, body: '{"name":"n"}' }));
    await Promise.all(Array.from({ length: 8 }, () => sendFcm(alert, cfg, { fetcher, now: NOW })));
    await sendFcm(alert, cfg, { fetcher, now: NOW + 54 * 60_000 });
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
    await sendFcm(alert, cfg, { fetcher, now: NOW + 56 * 60_000 });
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(2);
  });

  it('on a 401 drops the cached OAuth token and retries once with a fresh one', async () => {
    const refused = fx.send.find((c) => c.name.startsWith('an access token Google refuses'))!;
    let n = 0;
    const { fetcher, calls } = google(
      () => (n++ === 0 ? refused.response : { status: 200, body: '{"name":"n"}' }),
      (i) => ({ status: 200, body: JSON.stringify({ access_token: `ya29.token${i}`, expires_in: 3599 }) }),
    );
    const out = await sendFcm(alert, cfg, { fetcher, now: NOW });
    expect(out.outcome).toBe('ok');
    const sends = calls.filter((c) => c.url.includes('fcm.googleapis.com'));
    expect(sends.map((c) => c.headers.authorization)).toEqual(['Bearer ya29.token0', 'Bearer ya29.token1']);
  });

  it('OAuth failures: a refused key is fatal (and not re-asked for a minute); an outage is retry', async () => {
    for (const c of fx.oauth.filter((x) => x.expect !== 'ok')) {
      resetFcmTokens();
      const { fetcher, calls } = google(() => ({ status: 200, body: '{}' }), () => c.response);
      const out = await sendFcm(alert, cfg, { fetcher, now: NOW });
      expect(out, c.name).toMatchObject({ outcome: c.expect, status: 0, errorCode: 'OAuth' });
      expect(calls.some((x) => x.url.includes('fcm.googleapis.com'))).toBe(false);
      await sendFcm(alert, cfg, { fetcher, now: NOW + 1000 });
      const asked = calls.filter((x) => x.url.includes('oauth2')).length;
      expect(asked, c.name).toBe(c.expect === 'fatal' ? 1 : 2);
    }
  });

  it('a network failure is retry, and never throws', async () => {
    const { fetcher } = recordingFetch((call) => {
      if (call.url.includes('oauth2')) return OAUTH_OK;
      throw new TypeError('Network connection lost.');
    });
    expect(await sendFcm(alert, cfg, { fetcher, now: NOW })).toMatchObject({ outcome: 'retry', status: 0, errorCode: 'Network' });
  });

  it('refuses bad input before any request', async () => {
    const { fetcher, calls } = google(() => ({ status: 200, body: '{}' }));
    expect(await sendFcm({ ...alert, token: 'x' }, cfg, { fetcher })).toMatchObject({ outcome: 'gone', errorCode: 'MalformedToken' });
    expect(await sendFcm({ ...alert, data: { from: 'x' } }, cfg, { fetcher })).toMatchObject({ outcome: 'fatal', errorCode: 'BadData' });
    expect(await sendFcm({ ...alert, data: { 'google.x': 'y' } }, cfg, { fetcher })).toMatchObject({ outcome: 'fatal', errorCode: 'BadData' });
    expect(await sendFcm({ ...alert, data: { e: 'x'.repeat(4100) } }, cfg, { fetcher })).toMatchObject({ outcome: 'fatal', errorCode: 'PayloadTooLarge' });
    expect(calls).toHaveLength(0);
  });
});

describe('config', () => {
  it('stays dormant until a usable service account is set', async () => {
    expect(fcmConfigFromEnv({})).toBeNull();
    expect(fcmConfigFromEnv({ FCM_SA_JSON: 'not json' })).toBeNull();
    expect(fcmConfigFromEnv({ FCM_SA_JSON: JSON.stringify({ project_id: 'p', client_email: 'a@b' }) })).toBeNull();
    expect(cfg).toMatchObject({ projectId: 'dreamstream-test', clientEmail: 'fcm-sender@dreamstream-test.iam.gserviceaccount.com', tokenUri: 'https://oauth2.googleapis.com/token' });
  });

  it('never lets the secret point the Worker at another token endpoint', async () => {
    const sa = JSON.parse((await testServiceAccount()).json);
    expect(fcmConfigFromEnv({ FCM_SA_JSON: JSON.stringify({ ...sa, token_uri: 'https://evil.example/token' }) })?.tokenUri).toBe('https://oauth2.googleapis.com/token');
  });

  it('accepts a PEM with literal \\n escapes (as pasted from the JSON file)', async () => {
    const sa = JSON.parse((await testServiceAccount()).json);
    const escaped = { ...sa, private_key: sa.private_key.replace(/\n/g, '\\n') };
    const c = fcmConfigFromEnv({ FCM_SA_JSON: JSON.stringify(escaped) })!;
    const { fetcher } = google(() => ({ status: 200, body: '{}' }));
    expect('token' in (await fcmAccessToken(c, { fetcher, now: NOW }))).toBe(true);
  });

  it('recognises registration tokens', () => {
    expect(isFcmToken(TOKEN)).toBe(true);
    expect(isFcmToken('short')).toBe(false);
    expect(isFcmToken('has spaces in it but is long enough')).toBe(false);
  });
});
