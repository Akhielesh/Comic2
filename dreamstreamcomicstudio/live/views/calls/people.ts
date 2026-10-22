// Who's who in Calls: your family (everyone sharing a nursery with you, and
// as whom), how a search result is badged, who a recent call was with and how
// to call them back, and when to check before calling someone new.
import type { NurseryPerson } from '../../monitor/client';
import type { CallRecord, PersonRec } from '../../calls/types';

export interface FamilyMember {
  uid: string;
  name: string;
  /** Their label in that nursery ("Grandma"). */
  label: string | null;
  /** The nursery to call them through. */
  nid: string;
  /** "Aria’s family". */
  where: string;
}

/** Everyone in your nurseries (the first nursery you share wins), never you. */
export function familyMap(nurseries: { id: string; name: string; baby_name: string | null }[], people: Record<string, NurseryPerson[]>): Map<string, FamilyMember> {
  const out = new Map<string, FamilyMember>();
  for (const n of nurseries) {
    for (const p of people[n.id] ?? []) {
      if (p.is_me || out.has(p.user_id)) continue;
      out.set(p.user_id, { uid: p.user_id, name: p.display_name, label: p.label, nid: n.id, where: n.baby_name ? `${n.baby_name}’s family` : n.name });
    }
  }
  return out;
}

/** How a search result reads: in one of your families, or someone else on Stream Studio. */
export function badgeFor(uid: string, family: Map<string, FamilyMember>): { family: boolean; text: string } {
  const f = family.get(uid);
  return f ? { family: true, text: `In ${f.where}` } : { family: false, text: 'Stream Studio member' };
}

/** Who a recent call was with (as you know them), and who to ring to call back. */
export function recentPeople(r: CallRecord, me: string | null, nameOf: (uid: string) => string | null): { names: string[]; back: { uid: string; name: string }[] } {
  const out = r.from.uid === me;
  const name = (uid: string, fallback?: string) => nameOf(uid) ?? r.joined.find((j) => j.uid === uid)?.name ?? fallback ?? 'Someone';
  if (out) {
    const back = r.invited.map((u) => ({ uid: u, name: name(u) }));
    return { names: [...new Set(back.map((b) => b.name))], back };
  }
  const caller = { uid: r.from.uid, name: nameOf(r.from.uid) ?? (r.from.label || r.from.name) };
  const others = r.joined.filter((j) => j.uid !== r.from.uid && j.uid !== me).map((j) => name(j.uid, j.name));
  return { names: [...new Set([caller.name, ...others])], back: [caller] };
}

/**
 * Calling someone outside your family for the first time: check first ("Sam
 * isn't in your nurseries — they'll see your name"). Two people can share a
 * name, so this catches a mis-dial before it rings a stranger.
 */
export function needsConfirm(uid: string, ctx: { family: Map<string, FamilyMember>; favs: PersonRec[]; log: CallRecord[]; me: string | null; confirmed: Set<string> }): boolean {
  if (ctx.family.has(uid) || ctx.confirmed.has(uid) || ctx.favs.some((f) => f.uid === uid)) return false;
  // Already talked (either way) — not a first call.
  return !ctx.log.some((r) => (r.from.uid === uid && r.invited.includes(ctx.me ?? '')) || (r.from.uid === ctx.me && r.invited.includes(uid)) || r.joined.some((j) => j.uid === uid));
}

const OK_KEY = 'ds-calls-ok';

export function loadConfirmed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OK_KEY) || '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function saveConfirmed(uid: string): void {
  try {
    const all = [...loadConfirmed(), uid].slice(-200);
    localStorage.setItem(OK_KEY, JSON.stringify([...new Set(all)]));
  } catch { /* storage unavailable */ }
}
