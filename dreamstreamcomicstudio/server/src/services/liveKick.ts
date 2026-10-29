import crypto from 'crypto';

// "Not you? Secure my account" must also close what the intruder has OPEN — monitor, call-line
// and admin sockets — and stop their alert subscriptions (ADR 0006 D6.2; WS-5 review). The
// account's own tokens can't ask for that any more: live_secure_account() has just ended every
// session, so the live Worker's POST /api/me/kick (which lists nurseries with the caller's token)
// gets nowhere. So the backend asks the live Worker directly, signed with the secret the database
// and the email Worker already share (SECURITY_HOOK_SECRET), naming the account and the nurseries
// live_secure_account() returned:
//
//   POST <LIVE_API_ORIGIN>/live-api/x/user/<uid>/kick
//   x-ds-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<p>")>
//   {"p": "{\"v\":1,\"kind\":\"kick\",\"uid\":…,\"why\":\"secured\",\"nids\":[…],\"at\":<ms>}"}
//
// The same signing as /x/user/<uid>/notify (live-worker ops.ts): ±5 minutes, single use. The Worker
// answers 2xx {ok: true} only when every nursery room and the call line confirmed — anything else
// (not deployed yet: 404; a room that didn't answer; no secret here) is reported as not kicked,
// and the "Not you?" page says what to do instead. Never throws, never blocks securing the account.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NURSERIES = 50;
const TIMEOUT_MS = 6000;

export type KickOutcome = { kicked: boolean; reason?: 'not_configured' | 'not_deployed' | 'unconfirmed' | 'unreachable' | 'bad_input' };

const realFetch: typeof fetch = (input, init) => fetch(input, init);
let fetcher: typeof fetch = realFetch;
/** Tests swap the network out. */
export function setLiveKickFetcher(f?: typeof fetch): void {
  fetcher = f ?? realFetch;
}

/** The secret to sign with: SECURITY_HOOK_SECRET, or its newest half while rotating ("old|new"). */
function signingSecret(): string | null {
  const parts = String(process.env.SECURITY_HOOK_SECRET || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function liveApiOrigin(): string {
  const raw = String(process.env.LIVE_API_ORIGIN || 'https://dreamstreamstudio.ai').trim().replace(/\/+$/, '');
  return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(raw) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(raw) ? raw : 'https://dreamstreamstudio.ai';
}

/** The signed request, exposed for tests and for the Worker side's contract test. */
export function signedKickRequest(uid: string, nids: string[], secret: string, nowMs = Date.now()): { url: string; init: RequestInit; p: string } {
  const p = JSON.stringify({ v: 1, kind: 'kick', uid: uid.toLowerCase(), why: 'secured', nids, at: nowMs });
  const t = String(Math.floor(nowMs / 1000));
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${p}`).digest('hex');
  return {
    url: `${liveApiOrigin()}/live-api/x/user/${uid.toLowerCase()}/kick`,
    p,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ds-signature': `t=${t},v1=${v1}` },
      body: JSON.stringify({ p }),
    },
  };
}

/**
 * Ask the live Worker to close every socket of `uid` in these nurseries and on their call line,
 * and drop the account's alert subscriptions there. `kicked: true` only when it confirmed.
 */
export async function kickAccountEverywhere(uid: string, nurseries: unknown, nowMs = Date.now()): Promise<KickOutcome> {
  if (!UUID_RE.test(uid)) return { kicked: false, reason: 'bad_input' };
  const secret = signingSecret();
  if (!secret) return { kicked: false, reason: 'not_configured' };
  const nids = [...new Set((Array.isArray(nurseries) ? nurseries : []).map((n) => String(n ?? '').toLowerCase()).filter((n) => UUID_RE.test(n)))].slice(0, MAX_NURSERIES);
  const { url, init } = signedKickRequest(uid, nids, secret, nowMs);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(url, { ...init, signal: ctl.signal });
    if (res.status === 404 || res.status === 405 || res.status === 501) return { kicked: false, reason: 'not_deployed' };
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return res.ok && body?.ok === true ? { kicked: true } : { kicked: false, reason: 'unconfirmed' };
  } catch {
    return { kicked: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
