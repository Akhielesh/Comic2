// One display name across every studio (DreamStream, Stream Studio, the baby monitor and
// calls). Saved through the server, which writes it everywhere it lives in one go —
// PATCH /api/account/name; see shared/accountName.ts for where that is.
import { NAME_MAX, cleanName } from '../shared/accountName';
import { buildApiUrl } from './clientConfig';
import { invalidateAccountAccess } from './studioAccessApi';
import { supabase } from './supabase';

export { NAME_MAX, cleanName };

/** ok: the saved name, and whether a Stream Studio profile was renamed too. Otherwise a message to show. */
export interface AccountNameResult {
  ok: boolean;
  name?: string;
  stream?: boolean;
  error?: string;
}

const SAVE_FAILED = 'Couldn’t save your name right now — try again.';

export async function updateAccountName(raw: string): Promise<AccountNameResult> {
  const name = cleanName(raw);
  if (!name) return { ok: false, error: `Add your name (1–${NAME_MAX} characters).` };

  let token: string | undefined;
  try {
    token = (await supabase.auth.getSession()).data.session?.access_token;
  } catch { /* treated as signed out */ }
  if (!token) return { ok: false, error: 'Sign in to change your name.' };

  let res: Response;
  try {
    res = await fetch(buildApiUrl('/api/account/name'), {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch {
    return { ok: false, error: 'You seem to be offline — your name wasn’t saved.' };
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; name?: string; stream?: boolean; error?: { message?: string } } | null;
  if (!res.ok || !body?.ok) return { ok: false, error: body?.error?.message || SAVE_FAILED };

  // The session token carries user_metadata: refresh it so whatever reads the name from
  // the session (Stream Studio's first-visit join, Chat Studio) sees the new one now.
  try {
    await supabase.auth.refreshSession();
  } catch { /* the next scheduled refresh picks it up */ }
  invalidateAccountAccess();
  return { ok: true, name: body.name || name, stream: Boolean(body.stream) };
}
