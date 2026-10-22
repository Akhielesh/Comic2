// The signed-in person's access to every studio, from the server — the same answer
// DreamStream and Stream Studio both show (GET /api/account/studios).
import type { AccountAccess } from '../shared/studioAccess';
import { buildApiUrl } from './clientConfig';
import { supabase } from './supabase';

export type { AccountAccess, StudioAccess, StudioId, StudioStatus } from '../shared/studioAccess';

let inflight: Promise<AccountAccess | null> | null = null;

async function load(): Promise<AccountAccess | null> {
  try {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    if (!token) return null;
    const res = await fetch(buildApiUrl('/api/account/studios'), { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return (await res.json()) as AccountAccess;
  } catch {
    return null;
  }
}

/** Views that mount together (a settings page and its "Your studios" card) share one request. */
export function fetchAccountAccess(): Promise<AccountAccess | null> {
  inflight ??= load().finally(() => {
    inflight = null;
  });
  return inflight;
}

const listeners = new Set<() => void>();

/** Something on the account changed (e.g. its name): every open view re-reads the answer. */
export function invalidateAccountAccess(): void {
  for (const l of listeners) l();
}

export function onAccountAccessChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
