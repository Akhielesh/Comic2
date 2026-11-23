import { useEffect, useRef } from 'react';
import { isPrivatePath } from '../../shared/comic/imagePaths';
import { PRIVATE_RENEW_BEFORE_MS, type UrlEntry } from './signedAssets';

/** Renew while reading, and on return from a sleeping tab. One timer and one batched request per cycle. */
export function usePrivateUrlRenewal(entries: Record<string, UrlEntry>, renew: (paths: string[]) => void, expired: () => void) {
  const callbacks = useRef({ renew, expired });
  callbacks.current = { renew, expired };
  const attempts = useRef(new Map<string, number>());
  useEffect(() => {
    const links = Object.entries(entries).filter(([path]) => isPrivatePath(path));
    if (!links.length) return;
    let timer: ReturnType<typeof setTimeout>;
    const active = new Set(links.map(([path]) => path));
    for (const path of attempts.current.keys()) if (!active.has(path)) attempts.current.delete(path);
    const masked = new Set<string>();
    function schedule() {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      const due: string[] = [];
      let next = Infinity;
      let changed = false;
      for (const [path, { expiresAt }] of links) {
        const renewAt = Math.max(expiresAt - PRIVATE_RENEW_BEFORE_MS, (attempts.current.get(path) ?? -Infinity) + 15_000);
        if (renewAt <= now) due.push(path);
        else next = Math.min(next, renewAt);
        if (expiresAt > now) next = Math.min(next, expiresAt);
        else if (!masked.has(path)) { masked.add(path); changed = true; }
      }
      if (changed) callbacks.current.expired();
      if (due.length) {
        for (const path of due) attempts.current.set(path, now);
        callbacks.current.renew(due);
        next = Math.min(next, now + 15_000);
      }
      if (Number.isFinite(next)) timer = setTimeout(schedule, Math.max(1, next - now));
    }
    schedule();
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('online', schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('online', schedule);
    };
  }, [entries]);
}
