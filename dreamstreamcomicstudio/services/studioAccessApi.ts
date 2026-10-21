// The signed-in person's access to every studio, from the server — the same answer
// DreamStream and Stream Studio both show (GET /api/account/studios).
import type { AccountAccess } from '../shared/studioAccess';
import { buildApiUrl } from './clientConfig';
import { supabase } from './supabase';

export type { AccountAccess, StudioAccess, StudioId, StudioStatus } from '../shared/studioAccess';

export async function fetchAccountAccess(): Promise<AccountAccess | null> {
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
