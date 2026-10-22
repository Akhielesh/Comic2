import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STUN, dropPort53, iceServers, includesTurn, resetIceCache } from './ice';

const TURN = {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
  username: 'u',
  credential: 'c',
};
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe('iceServers', () => {
  beforeEach(() => resetIceCache());

  it('is STUN-only without TURN secrets and never calls out', async () => {
    const f = vi.fn();
    expect(await iceServers({}, 0, f as unknown as typeof fetch)).toEqual(STUN);
    expect(f).not.toHaveBeenCalled();
  });

  it('adds TURN (minus port 53), asks for a day-long credential and caches it', async () => {
    const f = vi.fn(() => ok({ iceServers: TURN }));
    const env = { TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' };
    const s = await iceServers(env, 0, f as unknown as typeof fetch);
    expect(includesTurn(s)).toBe(true);
    expect(JSON.stringify(s)).not.toContain(':53');
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ ttl: 86400 });
    await iceServers(env, 30 * 60_000, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    await iceServers(env, 61 * 60_000, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries a failed mint after a minute instead of an hour', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })));
    const env = { TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' };
    expect(await iceServers(env, 0, f as unknown as typeof fetch)).toEqual(STUN);
    await iceServers(env, 30_000, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    await iceServers(env, 61_000, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('drops servers left with no URLs', () => {
    expect(dropPort53([{ urls: 'turn:x:53' }, { urls: ['stun:y:3478'] }])).toEqual([{ urls: ['stun:y:3478'] }]);
  });
});
