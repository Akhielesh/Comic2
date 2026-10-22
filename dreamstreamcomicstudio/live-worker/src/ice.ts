// ICE servers for every WebRTC path the live Worker brokers — baby monitor, family calls
// and Stream Studio guests. STUN always; Cloudflare Realtime TURN when the owner has set
// TURN_KEY_ID + TURN_KEY_API_TOKEN (without TURN, devices behind carrier NAT or strict
// firewalls can't reach each other at all).
//
// Credentials are minted for a day and served for at most half that, so a socket that
// holds them overnight never presents expired ones. A failed mint is retried after a
// minute instead of pinning a whole hour to STUN-only.

export const STUN: RTCIceServerLike[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceEnv {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export const TURN_TTL_S = 24 * 3600;
const SERVE_MS = Math.min(60 * 60_000, (TURN_TTL_S * 1000) / 2);
const RETRY_MS = 60_000;

let cache: { key: string; until: number; servers: RTCIceServerLike[] } | null = null;

export const hasTurnConfig = (env: IceEnv): boolean => !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN);

/** Cloudflare lists a port-53 alternative that browsers time out on — drop those URLs. */
export function dropPort53(servers: RTCIceServerLike[]): RTCIceServerLike[] {
  const out: RTCIceServerLike[] = [];
  for (const s of servers) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));
    if (urls.length) out.push({ ...s, urls });
  }
  return out;
}

export async function iceServers(env: IceEnv, now = Date.now(), fetcher: typeof fetch = fetch): Promise<RTCIceServerLike[]> {
  const key = env.TURN_KEY_ID || '';
  if (cache && cache.key === key && now < cache.until) return cache.servers;
  if (!hasTurnConfig(env)) {
    cache = { key, until: now + SERVE_MS, servers: STUN };
    return STUN;
  }
  try {
    const res = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
    });
    if (res.ok) {
      const body = (await res.json()) as { iceServers?: RTCIceServerLike | RTCIceServerLike[] };
      const turn = dropPort53(Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : []);
      if (turn.length) {
        const servers = [...STUN, ...turn];
        cache = { key, until: now + SERVE_MS, servers };
        return servers;
      }
    }
  } catch {
    /* fall through to STUN-only, retried soon */
  }
  cache = { key, until: now + RETRY_MS, servers: STUN };
  return STUN;
}

/** True when the list includes a relay (turn:/turns:) server. */
export const includesTurn = (servers: RTCIceServerLike[]): boolean =>
  servers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/.test(u)));

/** Tests only. */
export function resetIceCache(): void {
  cache = null;
}
