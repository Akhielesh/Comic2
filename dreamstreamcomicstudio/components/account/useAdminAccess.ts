import { useEffect, useState } from 'react';
import { getAdminAccess } from '../../services/billing';
import type { AdminAccessResponse } from '../../shared/types/billing';

export interface AdminAccessState {
  isAdmin: boolean;
  isModerator: boolean;
  /** The server's answer, or null when signed out or the check failed. */
  access: AdminAccessResponse | null;
  /** The /api/admin/me check has settled (success or failure). */
  checked: boolean;
}

const NO_ACCESS: AdminAccessState = { isAdmin: false, isModerator: false, access: null, checked: true };

/**
 * Admin / moderator access for the signed-in user, from the SERVER's admin flag only
 * (/api/admin/me). A failed check means no access: never derive a role from the user's email
 * or any other client-side value (the server enforces every admin route anyway; the client must
 * not even show the console). Keyed on the user id, not the user object: Supabase mints a fresh
 * user object on every token refresh (each tab refocus), which would re-run the check needlessly.
 */
export const useAdminAccess = (userId: string | null | undefined): AdminAccessState => {
  // The answer is stored WITH the account it belongs to, so a render for a different account
  // (before the effect below runs) can never show the previous account's roles.
  const [answer, setAnswer] = useState<{ userId: string; state: AdminAccessState } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    getAdminAccess()
      .then((access) => {
        if (active) {
          setAnswer({ userId, state: { isAdmin: access.isAdmin === true, isModerator: access.isModerator === true, access, checked: true } });
        }
      })
      .catch(() => {
        if (active) setAnswer({ userId, state: NO_ACCESS });
      });
    return () => {
      active = false;
    };
  }, [userId]);

  if (!userId) return NO_ACCESS;
  if (!answer || answer.userId !== userId) return { ...NO_ACCESS, checked: false };
  return answer.state;
};
