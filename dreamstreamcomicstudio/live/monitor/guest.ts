/**
 * Guest passes: family and sitters join a nursery with the share link and
 * the passcode a parent set — no account needed. The pass is a token the
 * nursery's room issued; it's kept on this device only and sent in the
 * socket's first frame (never in a URL).
 */

import { WORKER_BASE } from '../config';
import type { MonRole } from './protocol';

export interface GuestPass {
  token: string;
  name: string;
  role: Extract<MonRole, 'viewer' | 'caregiver'>;
  /** When the pass ends (epoch ms). */
  until: number;
  nursery: { name: string; baby: string | null };
}

const key = (nid: string) => `ds-monitor-guest-${nid}`;

/**
 * Why a passcode isn't good enough, or null — the same rule the nursery's
 * room enforces (live-worker/src/monitorGuests.ts; a test keeps them equal).
 */
export function passcodeProblem(pass: string, avoid: (string | null | undefined)[] = []): string | null {
  const p = pass.normalize('NFKC');
  if (p.length < 8) return 'Use at least 8 characters.';
  if (p.length > 128) return 'Use 128 characters or fewer.';
  if (/^(.)\1+$/.test(p)) return 'Don’t repeat one character.';
  const lower = p.toLowerCase();
  const alnum = lower.replace(/[^a-z0-9]/g, '');
  const runs = ['01234567890', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm'];
  const isRun = alnum.length >= 6 && runs.some((r) => r.includes(alnum) || [...r].reverse().join('').includes(alnum));
  if (isRun || /^(password|passcode|passw0rd|babymonitor|letmein|iloveyou|welcome|monitor|qwerty)/.test(alnum)) return 'That one is too easy to guess.';
  for (const w of avoid) {
    const n = (w || '').trim().toLowerCase();
    if (n.length >= 3 && lower.replace(/[^a-z]/g, '').includes(n.replace(/[^a-z]/g, '')) && lower.replace(/[^a-z]/g, '').length - n.replace(/[^a-z]/g, '').length < 4) {
      return 'Don’t build it from the baby’s or nursery’s name.';
    }
  }
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (p.length < 12 && kinds < 2) return 'Mix letters and numbers, or use 12+ characters (a short phrase works well).';
  return null;
}

const WORDS = [
  'amber', 'apple', 'aspen', 'bamboo', 'basil', 'birch', 'bloom', 'breeze', 'brook', 'canyon', 'cedar', 'cherry', 'cinder', 'clover', 'cobalt',
  'comet', 'coral', 'cotton', 'crystal', 'daisy', 'delta', 'dune', 'ember', 'falcon', 'fern', 'fjord', 'forest', 'garnet', 'glacier', 'harbor',
  'hazel', 'heron', 'indigo', 'island', 'ivory', 'jasper', 'juniper', 'lagoon', 'lantern', 'lemon', 'linen', 'lotus', 'maple', 'marble',
  'meadow', 'mesa', 'mint', 'nectar', 'nimbus', 'oasis', 'ocean', 'olive', 'onyx', 'orchid', 'otter', 'pebble', 'pepper', 'pine', 'plum',
  'prairie', 'quartz', 'raven', 'reef', 'river', 'robin', 'saffron', 'sage', 'sequoia', 'sierra', 'slate', 'sparrow', 'spruce', 'summit',
  'sunset', 'thistle', 'thunder', 'tulip', 'tundra', 'velvet', 'violet', 'walnut', 'willow', 'winter', 'zephyr',
];

/** A memorable passphrase: three words and two digits (~59 million combinations; the link locks after 5 wrong tries and turns off after 20). */
export function suggestPasscode(): string {
  const r = crypto.getRandomValues(new Uint32Array(4));
  const w = (i: number) => WORDS[r[i] % WORDS.length];
  return `${w(0)}-${w(1)}-${w(2)}-${String(r[3] % 100).padStart(2, '0')}`;
}

export function loadGuest(nid: string): GuestPass | null {
  try {
    const g = JSON.parse(localStorage.getItem(key(nid)) || 'null') as GuestPass | null;
    if (!g?.token) return null;
    if (g.until && g.until < Date.now()) {
      localStorage.removeItem(key(nid));
      return null;
    }
    return g;
  } catch {
    return null;
  }
}

export function saveGuest(nid: string, g: GuestPass): void {
  try {
    localStorage.setItem(key(nid), JSON.stringify(g));
  } catch { /* storage unavailable: the pass lasts this visit only */ }
}

export function clearGuest(nid: string): void {
  try {
    localStorage.removeItem(key(nid));
  } catch { /* storage unavailable */ }
}

/** The join link a parent shares (the code is the link's secret part). */
export function shareLink(nid: string, code: string): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'https://dreamstreamstudio.ai';
  return `${origin}/live#/monitor/join/${nid}/${code}`;
}

/** `member`: the signed-in account already belongs to this nursery — no guest pass needed. */
export type JoinError = 'bad_link' | 'expired' | 'off' | 'locked' | 'wrong' | 'full' | 'slow_down' | 'name' | 'member' | 'network';

/**
 * Join with the link + passcode. Signed in? Pass your own access token: the
 * room asks Supabase who you are, sends a member straight to watching, and
 * lists anyone else with an account for the parents to make a member.
 */
export async function joinAsGuest(
  nid: string,
  o: { code: string; pass: string; name: string; dev: string },
  token?: string | null,
): Promise<{ ok: true; pass: GuestPass; account: boolean } | { ok: false; reason: JoinError; retryAt?: number | null; left?: number | null }> {
  let res: Response;
  try {
    res = await fetch(`${WORKER_BASE}/api/monitor/${nid}/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(o),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  const body = (await res.json().catch(() => null)) as
    | { ok: true; token: string; guest: { name: string; role: 'viewer' | 'caregiver'; until: number }; nursery: { name: string; baby: string | null }; account?: boolean }
    | { ok: false; reason: JoinError; retryAt?: number | null; left?: number | null }
    | null;
  if (!body) return { ok: false, reason: 'network' };
  if (body.ok === false) return { ok: false, reason: body.reason, retryAt: body.retryAt, left: body.left };
  const pass: GuestPass = { token: body.token, name: body.guest.name, role: body.guest.role, until: body.guest.until, nursery: body.nursery };
  saveGuest(nid, pass);
  return { ok: true, pass, account: body.account === true };
}

/** Plain words for a failed join. */
export function joinErrorText(r: { reason: JoinError; retryAt?: number | null; left?: number | null }): string {
  const at = r.retryAt ? new Date(r.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  switch (r.reason) {
    case 'wrong':
      return r.left != null && r.left <= 2
        ? `That passcode isn’t right — ${r.left} more ${r.left === 1 ? 'try' : 'tries'} before the link locks for 15 minutes.`
        : 'That passcode isn’t right. Check with the parent who shared the link.';
    case 'locked':
      return `Too many wrong passcodes — the link is locked${at ? ` until ${at}` : ' for 15 minutes'}. The parents have been told.`;
    case 'slow_down':
      return `Too many tries from this network — wait${at ? ` until ${at}` : ' a few minutes'} and try again.`;
    case 'off':
      return 'This link has been turned off. Ask the parent for a new link and passcode.';
    case 'expired':
      return 'This link has expired. Ask the parent for a new one.';
    case 'full':
      return 'This link has reached its guest limit. Ask a parent to remove a guest or make a new link.';
    case 'name':
      return 'Add your name so the family knows who’s watching.';
    case 'member':
      return 'You’re already in this nursery — opening it with your account.';
    case 'network':
      return 'Couldn’t reach the nursery — check your connection and try again.';
    default:
      return 'This link isn’t valid. Check you opened the whole link.';
  }
}
