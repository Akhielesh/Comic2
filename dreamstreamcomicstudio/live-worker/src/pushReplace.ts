// The subscription a new one replaces (ADR 0006 WS-5; docs/infrastructure/INFRA_MAP.md §2a).
//
// Stream Studio is moving from dreamstreamstudio.ai/live to its own host. A browser that turned
// alerts on at the old address has a push subscription there (the apex origin's service worker);
// turning them on at the new host makes a second one, and every alert would arrive twice. The new
// host learns the old endpoint through a same-site bridge page (live/monitor/push.ts) and sends it
// with the new subscription as `sub.was`. The rooms (MonitorRoom alerts and nursery call rings,
// UserLine direct-call rings) drop that endpoint when they store the new one — only for the same
// account, so `was` can never remove someone else's subscription. Nothing is lost if `was` is
// missing or ignored: once the bridge unsubscribes the old one, its next push answers 410 and the
// room drops it then.
import { isAllowedPushEndpoint } from './webpush';

/** `sub.was` when it names another push endpoint (a real push service, not this one), else null. */
export function replacedEndpoint(sub: unknown, endpoint: string): string | null {
  const was = sub && typeof sub === 'object' ? (sub as { was?: unknown }).was : undefined;
  if (typeof was !== 'string' || was === endpoint || was.length > 1024 || !isAllowedPushEndpoint(was)) return null;
  return was;
}

/**
 * The stored list once `rec` is stored: any earlier record for its endpoint is replaced, and the
 * endpoint it replaces (`was`) goes too — but only a record `sameAccount` says is the caller's.
 * `rec` goes last (the rooms keep the newest when they trim to their cap).
 */
export function storeReplacing<R extends { sub: { endpoint: string } }>(
  all: readonly R[],
  rec: R,
  was: string | null,
  sameAccount: (r: R) => boolean,
): R[] {
  return [...all.filter((r) => r.sub.endpoint !== rec.sub.endpoint && !(was !== null && r.sub.endpoint === was && sameAccount(r))), rec];
}
