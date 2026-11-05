// Sign-up's "is this username free?" (authz-data-6).
//
// Asks public.username_available (server/sql/username_available_2026_11.sql), which answers yes or
// no and never returns an email — unlike resolve_email_from_username, which sign-up used to call
// and which hands anyone the address behind a username. Sign-in is unchanged here: whether it keeps
// accepting a username is the owner's decision (SECURITY-PLAN O9).

import { supabase } from './supabase';

/** 'unchecked': the function isn't deployed yet; the unique username index still refuses a taken name. */
export type UsernameAvailability = 'available' | 'taken' | 'unchecked';

type RpcError = { code?: string; message?: string } | null | undefined;

/** PostgREST's "no such function" (PGRST202), or Postgres's own (42883). */
const isMissingFunction = (error: RpcError): boolean => {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  return (
    code === 'PGRST202' ||
    code === '42883' ||
    (message.includes('username_available') && (message.includes('does not exist') || message.includes('could not find')))
  );
};

/**
 * Throws on any other error, as the old check did: a failing pre-check should say so rather
 * than let someone fill in the whole form for a name that is taken.
 */
export const checkUsernameAvailable = async (username: string): Promise<UsernameAvailability> => {
  const { data, error } = await supabase.rpc('username_available', { p_username: username });
  if (error) {
    if (!isMissingFunction(error)) throw error;
    console.warn('username_available RPC missing; relying on DB uniqueness enforcement.');
    return 'unchecked';
  }
  if (data === true) return 'available';
  if (data === false) return 'taken';
  return 'unchecked';
};
