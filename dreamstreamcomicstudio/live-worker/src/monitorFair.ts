/**
 * Two small, pure helpers for the monitor's direct-first paths (feature doc §7 C3, §4.7).
 *
 * 1. `netTag` — "is this viewer on the camera's network?" (C3: LAN first). A socket's public
 *    network (an IPv4 address; an IPv6 /64, which is one home's LAN — a phone on mobile data
 *    gets a /64 of its own) is hashed with the nursery's id and kept in that socket's WebSocket
 *    attachment only, gone with the socket. The address itself is never kept, logged, stored or
 *    sent; clients only ever learn a yes/no (`near`). A viewer near the camera gets no instant
 *    picture through our server: its direct picture over the home Wi-Fi comes first (the relay
 *    still steps in if that really fails).
 *
 * 2. `relayDataState` — the nursery's relay data this month (TURN bytes its viewers' devices
 *    received; owner decision 2026-10-22: 10 GB per nursery a month for the monitor). At 100%
 *    the monitor goes to SOUND ONLY wherever a picture would need a relay — the TURN relay or our
 *    server — and keeps the direct / Home Wi-Fi picture. Sound and alerts are never cut, and it
 *    never silently moves anyone onto the not-yet-end-to-end server relay instead.
 *
 *    What it counts: the room's own month row plus what is still owed in memory and on the
 *    sockets (usageMeter.ts) — the monitor's TURN bytes as viewers measure them (`{t:'use'}`,
 *    Phase B), clamped per socket to what a monitor can really receive (MONITOR_TURN_BPS), or
 *    estimated from their relay minutes until bytes arrive. Cloudflare's own per-nursery TURN
 *    figure (the credential's customIdentifier) stays the control total in Admin → Costs; the
 *    room can't read it. Nobody is charged: this only decides when the picture pauses.
 */

import { FAIR_USE, monthBounds, monthKey, turnBytesOf, type UsageMonth } from '../../shared/stream/usage';

const GB = 1e9;

/** The most a monitor viewer can believably receive through TURN: video ≤ 400 kbps + talk-back + headroom. */
export const MONITOR_TURN_BPS = 2_000_000;

/** The network part of an address: an IPv4 address, or an IPv6 /64 (null: not an address). */
export function networkOf(ip: string | null | undefined): string | null {
  const s = (ip ?? '').trim().toLowerCase();
  if (!s) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    return parts.every((n) => n >= 0 && n <= 255) ? `v4:${parts.join('.')}` : null;
  }
  if (!s.includes(':') || !/^[0-9a-f:]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return `v6:${all.slice(0, 4).map((h) => parseInt(h, 16).toString(16)).join(':')}`;
}

/** A socket's network, as a hash only this nursery's room can compare (null: no usable address). */
export async function netTag(nid: string, ip: string | null | undefined): Promise<string | null> {
  const net = networkOf(ip);
  if (!net) return null;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ds-near|${nid}|${net}`));
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type FairLevel = 'ok' | 'warn' | 'out';

export interface FairState {
  /** The month it is about (YYYY-MM). */
  month: string;
  level: FairLevel;
  /** Relay data used this month, GB (one decimal). */
  usedGb: number;
  /** The allowance, GB. */
  ofGb: number;
  /** Measured by the viewers' devices, or estimated from minutes on the relay. */
  measured: boolean;
  /** When the month resets (UTC ms). */
  resets: number;
}

/** The nursery's relay data this month, from its usage (written row + owed counters). */
export function relayDataState(usage: UsageMonth | null | undefined, now: number): FairState {
  const month = monthKey(now);
  const ofGb = FAIR_USE.relayDataGbPerNurseryMonth;
  const c = usage && usage.month === month ? usage.counters.monitor : undefined;
  const t = c ? turnBytesOf(c, 'monitor') : { bytes: 0, measured: false };
  const used = t.bytes / GB;
  const share = used / ofGb;
  const level: FairLevel = share >= 1 ? 'out' : share >= FAIR_USE.noticeAt[0] ? 'warn' : 'ok';
  return { month, level, usedGb: Math.round(used * 10) / 10, ofGb, measured: t.measured, resets: monthBounds(now).endMs };
}
