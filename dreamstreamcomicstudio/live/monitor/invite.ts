/**
 * Invite — one sheet for "let someone watch": add a person who has an account
 * (by name, suggested from your other nurseries first), or share a link +
 * passcode (with a QR code) for anyone without one. Opened from anywhere with
 * `openInvite(nid)`, like the sign-in sheet; mounted once by the app shell.
 *
 * The share link lives in the nursery's room. On the watch screen the sheet
 * borrows that screen's socket (a "share channel" it registers); anywhere
 * else it opens a short-lived parent-only 'admin' socket while it's open.
 */

import { accessToken } from '../account';
import { announceMembersChanged, listNurseries, listPeople, monitorError, openMonitorSocket, type Nursery } from './client';
import type { MonRole, ShareInfo, ViewerPresence } from './protocol';

export type InviteTab = 'add' | 'link';

/* ------------------------------------------------------------- opening */

type Opener = (nid: string, tab: InviteTab | undefined, from: HTMLElement | null) => void;
let opener: Opener | null = null;

export function registerInviteOpener(fn: Opener | null): void {
  opener = fn;
}

/** Open the Invite sheet for a nursery (focus returns to whatever opened it). */
export function openInvite(nid: string, tab?: InviteTab): void {
  const from = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  opener?.(nid, tab, from);
}

/* ------------------------------------------------ people list changed */

const peopleFns = new Set<(nid: string) => void>();

/** Someone was added, changed or promoted — lists of people re-read. */
export function onPeopleChanged(fn: (nid: string) => void): () => void {
  peopleFns.add(fn);
  return () => void peopleFns.delete(fn);
}

export function peopleChanged(nid: string): void {
  peopleFns.forEach((f) => f(nid));
}

/* ------------------------------------------------------- share channel */

export interface ShareChannelState {
  connected: boolean;
  share: ShareInfo | null;
  err: string | null;
  me: { role: MonRole; name: string; guest: boolean } | null;
  nursery: { name: string; baby: string | null } | null;
  /** Who is watching right now (only known on the watch screen). */
  viewers: ViewerPresence[] | null;
}

const EMPTY: ShareChannelState = { connected: false, share: null, err: null, me: null, nursery: null, viewers: null };

/** The room's share-link state plus a way to send to it — a small external store. */
export class ShareChannel {
  private st: ShareChannelState = EMPTY;
  private fns = new Set<() => void>();

  constructor(
    public send: (msg: Record<string, unknown>) => void = () => undefined,
    /** Guests: end this device's guest pass. */
    public leave?: () => void,
  ) {}

  set(patch: Partial<ShareChannelState>): void {
    this.st = { ...this.st, ...patch };
    this.fns.forEach((f) => f());
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  };

  readonly snapshot = (): ShareChannelState => this.st;

  /** Release whatever the channel holds open. */
  close(): void {
    /* the watch screen owns its socket */
  }
}

const channels = new Map<string, ShareChannel>();
const channelFns = new Set<() => void>();

/** The watch screen offers its socket to the sheet. Returns the unregister. */
export function registerShareChannel(nid: string, ch: ShareChannel): () => void {
  channels.set(nid, ch);
  channelFns.forEach((f) => f());
  return () => {
    if (channels.get(nid) === ch) channels.delete(nid);
    channelFns.forEach((f) => f());
  };
}

export function shareChannelFor(nid: string): ShareChannel | null {
  return channels.get(nid) ?? null;
}

export function onShareChannels(fn: () => void): () => void {
  channelFns.add(fn);
  return () => void channelFns.delete(fn);
}

/** A parent's own connection for the sheet when no watch screen is open (close it when done). */
export function adminChannel(nid: string): ShareChannel {
  const ch = new ShareChannel();
  const sock = openMonitorSocket(
    nid,
    'admin',
    (m) => {
      if (m.t === 'hello') ch.set({ connected: true, err: null, me: { role: m.you.role, name: m.you.name, guest: false }, nursery: { name: m.nursery.name, baby: m.nursery.baby } });
      else if (m.t === 'share') ch.set({ share: m.share, err: null });
      else if (m.t === 'share_err') ch.set({ err: m.msg });
      else if (m.t === 'error') ch.set({ err: m.msg });
    },
    () => undefined,
    (s, detail) => ch.set({ connected: s === 'connected', ...(s === 'closed' && detail ? { err: detail } : {}) }),
  );
  ch.send = (msg) => sock.send(msg);
  ch.close = () => sock.close();
  return ch;
}

/**
 * Tell the room whose access changed: removed people are cut off, only the
 * people named reconnect (adding Grandma doesn't restart everyone's picture),
 * and a guest with an account who was just made a member switches over.
 * Falls back to the one-shot admin connection when the channel isn't up.
 */
export async function announcePeople(nid: string, ch: ShareChannel | null, uids: string[]): Promise<void> {
  const token = await accessToken();
  if (ch?.snapshot().connected && token) ch.send({ t: 'members_changed', token, uids });
  else await announceMembersChanged(nid);
}

/* ------------------------------------------------------------- people */

export interface KnownPerson {
  user_id: string;
  display_name: string;
  /** The other nurseries you share with them. */
  from: string[];
}

/**
 * People you already share another nursery with — the safest, fastest way to
 * add someone (no searching the whole directory, no wrong "Sarah").
 */
export async function knownPeople(nid: string, nurseries?: Nursery[]): Promise<KnownPerson[]> {
  let list = nurseries;
  if (!list) {
    const r = await listNurseries();
    list = r.ok ? (r.nurseries ?? []) : [];
  }
  const others = list.filter((n) => n.id !== nid);
  const all = await Promise.all(others.map(async (n) => ({ n, people: (await listPeople(n.id)).people ?? [] })));
  const map = new Map<string, KnownPerson>();
  for (const { n, people } of all) {
    for (const p of people) {
      if (p.is_me) continue;
      const k = map.get(p.user_id) ?? { user_id: p.user_id, display_name: p.display_name, from: [] };
      if (!k.from.includes(n.name)) k.from.push(n.name);
      map.set(p.user_id, k);
    }
  }
  return [...map.values()].sort((a, b) => b.from.length - a.from.length || a.display_name.localeCompare(b.display_name));
}

/** Plain words for a failed add (the codes come from monitor_set_member). */
export function addMemberError(code: string | undefined, name: string): string {
  switch (code) {
    case 'not_member':
      return `${name} hasn’t finished setting up Stream Studio yet — share a link instead.`;
    case 'limit_reached':
      return 'This nursery has 20 people — the most it can have. Remove someone, or share a link instead.';
    case 'forbidden':
      return 'Only a parent of this nursery can add people.';
    case 'bad_role':
      return 'Pick Viewer, Caregiver or Parent.';
    default:
      return monitorError(code);
  }
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/* --------------------------------------------------------- messages */

const origin = () => (typeof location !== 'undefined' ? location.origin : 'https://dreamstreamstudio.ai');

/** Where a member watches (not secret: anyone else just sees sign-in or "not a member"). */
export function memberWatchLink(nid: string): string {
  return `${origin()}/live#/monitor/${nid}/watch`;
}

/** "Let them know" after adding someone with an account. */
export function addedMessage(nid: string, baby: string, nurseryName: string): { title: string; text: string; url: string } {
  return {
    title: `${nurseryName} · baby monitor`,
    text: `I added you to ${baby}’s baby monitor on Stream Studio — sign in with your account to watch:`,
    url: memberWatchLink(nid),
  };
}

/** What goes with the share link. Never the passcode — that travels separately. */
export function linkMessage(url: string, baby: string, nurseryName: string): { title: string; text: string; url: string } {
  return {
    title: `${nurseryName} · baby monitor`,
    text: `Watch ${baby} on our baby monitor. I’ll send you the passcode separately.`,
    url,
  };
}

/**
 * The phone's share sheet, or the clipboard where there's none (most
 * desktops). `copy` is what lands on the clipboard in that case.
 */
export async function shareOrCopy(data: { title: string; text: string; url: string }, copy: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
      /* not allowed here: fall back to copying */
    }
  }
  try {
    await navigator.clipboard.writeText(copy);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/* ------------------------------------------------------- formatting */

export const ago = (t: number, now = Date.now()) => {
  const m = Math.round((now - t) / 60_000);
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** "Fri 31 Oct, 9:14 pm" — when a link or pass ends. */
export const endsAt = (t: number) =>
  `${new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

/** "in 6 days" / "in 5 h" / "within the hour". */
export const endsIn = (t: number, now = Date.now()) => {
  const h = Math.round((t - now) / 3_600_000);
  return h < 1 ? 'within the hour' : h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
};

/** One line for the watch screen and settings: "Link on · 2 guests · ends in 6 days". */
export function shareSummary(share: ShareInfo | null): string {
  if (!share?.on) return 'No share link — family without an account can watch with a link + passcode';
  const n = share.guests.length;
  const parts = ['Link on', n ? `${n} guest${n === 1 ? '' : 's'}` : 'nobody has joined yet', share.expires_at ? `ends ${endsIn(share.expires_at)}` : 'until you turn it off'];
  if (share.locked_until) parts.splice(1, 0, 'locked after wrong passcodes');
  return parts.join(' · ');
}
