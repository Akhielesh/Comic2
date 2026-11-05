/**
 * The address a per-client limit counts against (abuse-ops-8).
 *
 * A port of live-worker/src/origin.ts `clientKey` for the Express backend, taking the address
 * Express resolved (`req.ip`, which honours TRUST_PROXY; the API Worker overwrites
 * X-Forwarded-For with CF-Connecting-IP) instead of a Workers Request:
 *   - IPv4 is keyed as-is: `4:203.0.113.9`;
 *   - an IPv4 address written as IPv6 (`::ffff:203.0.113.9`, how Node reports IPv4 on a dual-stack
 *     socket) is that IPv4 address, not a /64 shared by every IPv4 client;
 *   - IPv6 is keyed by its /64: `6:2001:0db8:0005:0006`. One subscriber gets a whole /64, so keying
 *     a single v6 address would let anyone rotate through 2^64 of them and never meet a limit.
 *     The cost is that unrelated people behind one /64 share an allowance; the live Worker already
 *     accepts that trade;
 *   - anything else (a hostname from a misconfigured proxy, junk) is keyed by its first 64
 *     characters: `x:…`;
 *   - no address at all gives null, and each caller decides what that means.
 *
 * It lives in server/src/lib rather than shared/** so the backend does not import Worker code.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv6 address's first four groups (its /64), lower-case and zero-padded; null if it isn't one. */
export function ipv6Prefix64(ip: string): string | null {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;
  // An embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is two groups.
  const v4 = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const p = v4[2].split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    s = `${v4[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':');
}

/** `4:<IPv4>`, `6:<IPv6 /64>`, `x:<other, ≤64 chars>`, or null when there is no address. */
export function clientKey(ip: string | null | undefined): string | null {
  let s = String(ip ?? '').trim();
  if (!s) return null;
  const mapped = s.toLowerCase().match(/^(?:\[)?::ffff:(\d{1,3}(?:\.\d{1,3}){3})(?:\])?$/);
  if (mapped) s = mapped[1];
  const v4 = s.match(IPV4);
  if (v4 && v4.slice(1).every((n) => Number(n) <= 255)) return `4:${s}`;
  const v6 = ipv6Prefix64(s);
  if (v6) return `6:${v6}`;
  return `x:${s.slice(0, 64)}`;
}
