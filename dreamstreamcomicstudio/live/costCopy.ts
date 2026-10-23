/**
 * Every user-facing word about cost, paths and fair use in Stream Studio — ONE place
 * (ADR 0007 D4; feature doc §4). Comic Studio's patterns, translated: the path and its cost
 * on the verb before an action, a pill while live, a receipt after, a calm monthly card.
 *
 * The rules (enforced by costCopy.unit.test.ts, next to monitor/privacyCopy.unit.test.ts):
 *   1. "free" is never attached to our relay (`turn`) or our server (`server`) as a path.
 *      Free means Home Wi-Fi, Direct, Google Drive or this device. Something that goes through
 *      our servers but costs the user nothing (a broadcast) is "free for you", and says it goes
 *      through our servers in the same breath.
 *   2. "end-to-end" is never claimed for the server relay: it isn't end-to-end encrypted yet
 *      (it may only say "not end-to-end encrypted").
 *   3. Dollars appear only inside "What this costs DreamStream (est.)", always marked as an
 *      estimate at list price and never as a charge. Users are not charged (D1).
 *   4. Every action that uses our servers says so before it starts.
 *   5. Nothing here ever says a limit cuts the baby monitor's sound or alerts — they are never cut.
 *
 * Units: relay data in GB (10⁹ bytes, the unit Cloudflare bills); hours and minutes for time;
 * `≈` for estimates, no `≈` for exact numbers.
 */
import { FAIR_USE, STREAM_UNIT_PRICES, type StreamPath } from '@/shared/stream/usage';
import { LOCAL_REC_BITRATE_FACTOR, type QualityPreset } from './config';
import { HARD_VIEWER_CAP, REPLAY_WINDOW_MS } from './protocol';

/* ------------------------------------------------------------ formatting */

/** "< 1 min", "12 min", "1 h 02 m", "10 h", "212 h". */
export function fmtDuration(ms: number): string {
  const min = Math.max(0, ms) / 60_000;
  if (min < 1) return '< 1 min';
  if (min < 59.5) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  if (h >= 10) return `${Math.round(min / 60)} h`;
  if (m === 60) return `${h + 1} h`;
  return m ? `${h} h ${String(m).padStart(2, '0')} m` : `${h} h`;
}

/** Relay data, in the GB Cloudflare bills (10⁹ bytes): "0.14 GB", "2.1 GB", "12 GB". */
export function fmtGb(bytes: number): string {
  const gb = Math.max(0, bytes) / 1e9;
  if (gb === 0) return '0 GB';
  if (gb < 0.01) return '< 0.01 GB';
  return `${gb < 1 ? gb.toFixed(2) : gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/** A list-price estimate (only ever inside "What this costs DreamStream"). */
export function fmtUsdEst(usd: number): string {
  if (!(usd > 0)) return '$0.00';
  if (usd < 0.01) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
}

/** The same, said as an estimate: "≈ $0.06", "under $0.01", "$0.00". */
export function approxUsd(usd: number): string {
  const s = fmtUsdEst(usd);
  return usd >= 0.01 ? `≈ ${s}` : s;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM' (UTC, like the usage rows) → "October". */
export function monthName(month: string): string {
  const m = Number(month.slice(5, 7));
  return MONTHS[m - 1] ?? month;
}

/** The day allowances reset: the 1st of the next month (UTC) → "November 1". */
export function resetDay(month: string): string {
  const m = Number(month.slice(5, 7));
  return Number.isFinite(m) && m >= 1 && m <= 12 ? `${MONTHS[m % 12]} 1` : 'on the 1st';
}

/** Percent for a meter, whole numbers, 0–100+. */
export const pctOf = (used: number, limit: number): number => (limit > 0 ? Math.max(0, Math.round((used / limit) * 100)) : 0);

/* ----------------------------------------------------- who pays, and paths */

/** The who-pays chip, in the same words everywhere. */
export const WHO_PAYS = {
  devices: 'your devices',
  wifi: 'your Wi-Fi',
  drive: 'your Google Drive',
  servers: 'our servers',
} as const;

/** The live path pill — three user words (Home Wi-Fi, Direct, Through our server/relay). */
export const PATH_PILL: Readonly<Record<StreamPath, string>> = {
  lan: 'Home Wi-Fi · free',
  direct: 'Direct · free',
  turn: 'Through our relay · encrypted',
  server: 'Through our server',
};

/** The pill's tooltip: what the path means for cost and privacy. */
export const PATH_TIP: Readonly<Record<StreamPath, string>> = {
  lan: 'Straight between your devices. Nothing leaves your home, and it keeps working if the internet drops.',
  direct: 'Device to device, end-to-end encrypted. No server in between.',
  turn: 'Your network blocks direct links, so an encrypted relay forwards it. It can’t see your video. It uses relay data — Direct and Home Wi-Fi don’t.',
  // The wording privacyCopy.unit.test.ts requires for the server relay.
  server: 'Passed along by our server in memory only, never stored, not end-to-end encrypted.',
};

/** The relay pill's tooltip with this month's relay data, when known ("Uses relay data: 2.1 of 10 GB this month"). */
export function relayTip(used?: { bytes: number; limitGb: number; measured?: boolean } | null): string {
  if (!used) return PATH_TIP.turn;
  return `${PATH_TIP.turn} Relay data this month: ${used.measured === false ? '≈ ' : ''}${fmtGb(used.bytes)} of ${used.limitGb} GB.`;
}

/** After a call's status ("4:12 · Direct · free"). */
export const callPathSuffix = (p: StreamPath | null): string => (p ? ` · ${PATH_PILL[p]}` : '');

/** A viewer row in People: how that person's picture reaches them (only our server is known per viewer). */
export const VIEWER_VIA_SERVER = ' · through our server';

/* ------------------------------------------------- before an action (§4.2) */

export const MEETING_LINE = 'Direct between you and your guests — free.';
export const MEETING_LINE_TIP = 'If someone’s network blocks direct video, an encrypted relay carries it for them.';

const replayHours = Math.round(REPLAY_WINDOW_MS / 3_600_000);
/** Go live: it goes through our servers — and the host isn't charged for it. */
export const GO_LIVE_LINE = `Through our servers · free for you · replay kept ${replayHours} h.`;
export const GO_LIVE_LINE_TIP = `Your viewers (up to ${HARD_VIEWER_CAP}) watch through our servers. You aren’t charged. The replay is deleted ${replayHours} hours after the stream ends.`;
/** While live: the viewer count's tooltip (§4.3 "Live · through our servers"). */
export const BROADCAST_TIP = `Live · through our servers · free for you, up to ${HARD_VIEWER_CAP} viewers. Replay kept ${replayHours} h.`;

/** Bytes an hour of this preset sends (× the local-recording factor for a master copy). */
export function bytesPerHour(p: Pick<QualityPreset, 'videoBps' | 'audioBps'>, videoFactor = 1): number {
  return ((p.videoBps * videoFactor + p.audioBps) / 8) * 3600;
}

/** Under the Studio's ready check, before going live. */
export function studioViewersLine(p: Pick<QualityPreset, 'id' | 'videoBps' | 'audioBps'>): string {
  return `Your viewers watch through our servers — free for you. You upload ≈ ${fmtGb(bytesPerHour(p))} an hour at ${p.id}.`;
}

/** Customize → Recording → "Also keep a 7-day cloud copy". */
export function cloudCopySettingDesc(p: Pick<QualityPreset, 'id' | 'videoBps' | 'audioBps'>, highBitrate: boolean): string {
  const gb = fmtGb(bytesPerHour(p, highBitrate ? LOCAL_REC_BITRATE_FACTOR : 1));
  return `Off unless you turn it on. Each recorded hour at ${p.id} uses ≈ ${gb} of your upload and our storage — kept 7 days, up to ${FAIR_USE.cloudCopyGbRolling} GB per account. Google Drive and this device are free, and the file is yours to keep.`;
}

/** The save sheet's who-pays chips on every free option. */
export const FREE_CHIP = { drive: 'Free · yours to keep', device: 'Free · on this device' } as const;
export const CLOUD_COPY_HEAD = 'Or a 7-day copy · through our servers';
/** A 7-day copy while Google Drive is connected (§4.6). */
export const CLOUD_COPY_DRIVE_TIP = 'Google Drive is connected: it keeps this free, and the file is yours to keep. The 7-day copy uses our storage and your upload.';

/**
 * Baby monitor camera setup (§4.2) — for MonitorCamera.tsx, next to (never instead of) the
 * privacy copy that privacyCopy.unit.test.ts guards.
 */
export const CAMERA_FAMILY_LINE = 'Your family watches directly — free. Phones on the same Wi-Fi use no internet at all.';

/* -------------------------------------------------------- receipts (§4.4) */

export interface PathTime {
  lan: number;
  direct: number;
  turn: number;
  server: number;
}

const sumMs = (t: PathTime) => t.lan + t.direct + t.turn + t.server;

/** The one word for a session: a relay if any of it relayed, Home Wi-Fi if all of it was, else Direct. */
export function mainPath(t: PathTime): StreamPath | null {
  if (!(sumMs(t) > 0)) return null;
  if (t.server > 0 && t.server >= t.turn) return 'server';
  if (t.turn > 0) return 'turn';
  if (t.direct === 0) return 'lan';
  return 'direct';
}

export interface CallReceipt {
  ms: number;
  path: StreamPath;
  /** TURN bytes this device received (0 = none, or the other end was the relayed one). */
  turnBytes: number;
  outgoing: boolean;
}

/** A finished call → its receipt (null when it never connected). */
export function callReceipt(t: { ms: PathTime; turnBytes: number }, outgoing: boolean): CallReceipt | null {
  const path = mainPath(t.ms);
  const ms = sumMs(t.ms);
  if (!path || ms < 1000) return null;
  return { ms, path: path === 'server' ? 'turn' : path, turnBytes: Math.max(0, t.turnBytes), outgoing };
}

/**
 * "12 min · direct · free" or "12 min · encrypted relay · 0.14 GB of your relay data". A call
 * counts against the person who placed it (owner decision), so the other end hears whose it is.
 */
export function callReceiptText(r: CallReceipt): string {
  const d = fmtDuration(r.ms);
  if (r.path === 'lan') return `${d} · Home Wi-Fi · free`;
  if (r.path === 'direct') return `${d} · direct · free`;
  if (!r.outgoing) return `${d} · encrypted relay · counts toward the caller’s relay data`;
  if (r.turnBytes > 0) return `${d} · encrypted relay · ${fmtGb(r.turnBytes)} of your relay data`;
  return `${d} · encrypted relay · uses your relay data`;
}

/**
 * "Last night: 10 h · all direct · free". With any of it through our relay or server, "free"
 * is said only of the direct part: "Last night: 10 h · 98% direct (free) · 12 min through our relay".
 */
export function nightReceiptText(label: string, t: PathTime): string {
  const total = sumMs(t);
  const d = fmtDuration(total);
  const paid = t.turn + t.server;
  const free = t.lan + t.direct;
  if (!(paid > 0)) {
    const how = t.direct === 0 ? 'all on Home Wi-Fi' : t.lan === 0 ? 'all direct' : 'all on Home Wi-Fi or direct';
    return `${label}: ${d} · ${how} · free`;
  }
  const parts: string[] = [];
  // Floored, so it never reads 100% while some of it went through us.
  const pct = Math.floor((free / total) * 100);
  if (pct > 0) parts.push(`${pct}% ${t.direct === 0 ? 'Home Wi-Fi' : 'direct'} (free)`);
  if (t.turn > 0) parts.push(`${fmtDuration(t.turn)} through our relay`);
  if (t.server > 0) parts.push(`${fmtDuration(t.server)} through our server`);
  return `${label}: ${d} · ${parts.join(' · ')}`;
}

/** The recap's Delivery line for a broadcast (≈: worked out from the quality and the viewer curve). */
export function deliveryLine(d: { durMs: number; peakViewers: number; storedBytes: number; deliveredBytes: number }): string {
  const parts = [fmtDuration(d.durMs), `peak ${d.peakViewers} viewer${d.peakViewers === 1 ? '' : 's'}`];
  if (d.storedBytes > 0) parts.push(`≈ ${fmtGb(d.storedBytes)} stored for ${replayHours} h`);
  if (d.deliveredBytes > 0) parts.push(`≈ ${fmtGb(d.deliveredBytes)} delivered`);
  return parts.join(' · ');
}
export const DELIVERY_WHO_PAYS = 'Through our servers · free for you';

/** The recap's line for a meeting this device hosted (guest links, added up). */
export function meetingDeliveryLine(m: { ms: PathTime; guests: number }): string {
  const t = m.ms;
  const guests = `${m.guests} guest${m.guests === 1 ? '' : 's'}`;
  const paid = t.turn + t.server;
  if (!(sumMs(t) > 0)) return `${guests} · direct between you and your guests`;
  if (!(paid > 0)) return `${guests} · ${fmtDuration(sumMs(t))} on camera · all direct · free`;
  return `${guests} · ${fmtDuration(sumMs(t))} on camera · ${fmtDuration(paid)} through our relay`;
}

/* --------------------------------------------- the Usage card (§4.5–§4.6) */

export const USAGE = {
  title: (month: string) => `Usage · ${monthName(month)}`,
  resets: (month: string) => `resets ${resetDay(month)}`,
  freeHead: 'Free · on your devices and direct links',
  serversHead: 'Through our servers',
  empty: 'Nothing went through our servers this month — everything stayed on your devices. That’s the goal.',
  nothingYet: 'Nothing yet this month.',
  nothingReported: 'Nothing reported yet this month.',
  loading: 'Loading this month’s usage…',
  offline: 'Couldn’t load this month’s usage right now — it loads again when you come back here.',
  signedOut: 'Sign in to see your calls and 7-day copies here. What this device saved and watched is below.',
  homeWifi: 'nothing left your home',
  direct: 'device to device, end-to-end encrypted',
  drive: 'yours to keep',
  device: 'on this device',
  relayNoCount: 'Direct and Home Wi-Fi don’t count',
  serverPicture: `up to ${FAIR_USE.serverPictureHoursPerNurseryDay} h a day · sound and alerts are never limited`,
  thisDevice: 'this device',
  estimated: '≈ estimated from minutes until apps report exact relay data',
  nurseryNote: 'Everyone who watches this nursery. Home Wi-Fi, Direct and relay come from each viewer’s app; time through our server is measured by our server.',
  accountNote: 'Calls count against the person who placed them; each nursery’s baby monitor counts against that nursery (see its Nursery settings).',
  openNursery: 'This month’s usage · what was free · what went through our servers',
  parentsOnly: 'Only the nursery’s parents see its usage.',
} as const;

/** Tips to stay free — at most one is shown (§4.6). */
export const TIPS = {
  sameWifi: 'Put the camera phone on the same Wi-Fi as your phone — Home Wi-Fi uses no internet at all, and keeps working if it drops.',
  drive: 'Save recordings to Google Drive instead of a 7-day copy — it’s free, and the file is yours to keep.',
  audioOnly: 'Just listening? Choose Audio only — no picture is sent, so a relay has much less to carry. Sound and alerts are the same.',
  relayNight: (dur: string) => `Last night’s picture went through our server for ${dur}. Check that the camera phone is on Wi-Fi, not mobile data.`,
  callsWifi: 'Calls between phones on the same Wi-Fi go straight between them — no relay, no data.',
} as const;

/* ----------------------------------------- What this costs DreamStream */

export const COST = {
  summary: 'What this costs DreamStream (est.)',
  /** Next to the summary: the estimate itself (approxUsd). */
  headline: (approx: string) => `${approx} this month at list price`,
  notCharged: 'You aren’t charged. This is what the same use would cost us at list price, before the free allowance our plan includes — most of it fits inside that.',
  checked: `List prices checked ${STREAM_UNIT_PRICES.checkedOn}. Estimates, not a bill.`,
  recapHeadline: (approx: string) => `${approx} at list price`,
} as const;

/* ------------------------------------------- fair-use notices (§4.7, B7) */

export type AllowanceLevel = 'ok' | 'warn' | 'full';

/** 80% → 'warn', 100% → 'full' (FAIR_USE.noticeAt). */
export function allowanceLevel(used: number, limit: number): AllowanceLevel {
  if (!(limit > 0)) return 'ok';
  const share = used / limit;
  return share >= FAIR_USE.noticeAt[1] ? 'full' : share >= FAIR_USE.noticeAt[0] ? 'warn' : 'ok';
}

/**
 * What the monitor does once a nursery's relay data is used up (owner decision 2026-10-22):
 * the picture stays on direct and Home Wi-Fi, never moves silently to the not-yet-end-to-end
 * server relay, and sound and alerts carry on. Said only where the room actually does it.
 */
export const RELAY_OUT_MONITOR = 'Relay data is used up, so on networks that block direct video the picture pauses — Home Wi-Fi and direct pictures carry on, and sound and alerts are unchanged.';

/**
 * The relay-data notice. Honest about what happens: Direct and Home Wi-Fi never count, and
 * the baby monitor's sound and alerts are never limited. `pictureFallback`: the room has said
 * the relayed picture steps down at 100% (only then is that claimed).
 */
export function relayNotice(
  level: AllowanceLevel,
  usedBytes: number,
  limitGb: number,
  month: string,
  scope: 'account' | 'nursery',
  opts: { pictureFallback?: boolean } = {},
): string | null {
  if (level === 'ok') return null;
  const whose = scope === 'nursery' ? 'this nursery’s' : 'your';
  if (level === 'warn') {
    return `${scope === 'nursery' ? 'This nursery has' : 'You’ve'} used ${fmtGb(usedBytes)} of ${whose} ${limitGb} GB of relay data this month. Direct and Home Wi-Fi don’t count. Resets ${resetDay(month)}.`;
  }
  const head = `${scope === 'nursery' ? 'This nursery has' : 'You’ve'} used this month’s ${limitGb} GB of relay data.`;
  if (scope === 'nursery' && opts.pictureFallback) return `${head} ${RELAY_OUT_MONITOR} Resets ${resetDay(month)}.`;
  return `${head} Direct and Home Wi-Fi don’t count${scope === 'nursery' ? ', and the baby monitor’s sound and alerts are never limited' : ''}. Resets ${resetDay(month)}.`;
}

/** The 7-day copies notice (10 GB rolling: space frees up as copies expire, not on the 1st). */
export function cloudCopyNotice(level: AllowanceLevel, usedBytes: number, limitBytes: number): string | null {
  if (level === 'ok') return null;
  const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  const limit = `${Math.round(limitBytes / 1024 ** 3)} GB`;
  if (level === 'warn') return `${gb(usedBytes)} of your ${limit} of 7-day copies is in use. Google Drive and this device are free, and the file is yours to keep.`;
  return `Your ${limit} of 7-day copies is full. Save to Google Drive (free, yours to keep) or this device — space frees up as older copies expire after 7 days.`;
}
