// Which account this device's account-scoped local data belongs to (BYOK keys, settings,
// model choices, chat memory, Stream Studio's copy). The login sync merges local data INTO
// the signed-in account's cloud snapshot, so a session for a DIFFERENT account must never
// inherit it: a sign-in link carrying someone else's tokens (supabase-js adopts tokens from
// the URL) would otherwise upload this device's keys into that other account.
//
// The marker is set once a signed-in account owns the local data, cleared on every sign-out,
// and adopted at boot from an already-stored session (installs from before the marker
// existed) BEFORE supabase-js reads any tokens out of the URL.

export const LOCAL_OWNER_KEY = 'ds.localDataOwner';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const storage = (): Storage | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export const getLocalOwner = (): string | null => {
  try {
    const value = storage()?.getItem(LOCAL_OWNER_KEY) ?? null;
    return value && UUID_RE.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
};

export const setLocalOwner = (userId: string): void => {
  if (!UUID_RE.test(userId)) return;
  try {
    storage()?.setItem(LOCAL_OWNER_KEY, userId.toLowerCase());
  } catch {
    /* storage unavailable */
  }
};

export const clearLocalOwner = (): void => {
  try {
    storage()?.removeItem(LOCAL_OWNER_KEY);
  } catch {
    /* storage unavailable */
  }
};

/** The user id inside a stored supabase-js session (JSON), or null. */
export const userIdFromStoredSession = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { user?: { id?: unknown }; currentSession?: { user?: { id?: unknown } } } | null;
    const id = parsed?.user?.id ?? parsed?.currentSession?.user?.id;
    return typeof id === 'string' && UUID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** Boot: an install from before the marker existed adopts its stored session's account. */
export const adoptStoredSessionOwner = (storedSession: string | null | undefined): void => {
  if (getLocalOwner()) return;
  const id = userIdFromStoredSession(storedSession);
  if (id) setLocalOwner(id);
};

/**
 * True when local data belongs to another account than `userId` and must be purged before
 * the login sync runs (never merged into this account).
 */
export const ownedByAnotherAccount = (userId: string): boolean => {
  const owner = getLocalOwner();
  return !!owner && owner !== userId.toLowerCase();
};

/**
 * supabase-js `detectSessionInUrl`: read tokens out of the URL only where our own sign-in
 * links land — the auth callback, the Site URL fallback (/), and Stream Studio's app path
 * (/live on the main host, / on its own host). Every other page (share links, readers,
 * settings…) ignores tokens in its URL.
 */
export const shouldDetectSessionInUrl = (url: URL): boolean => {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return path === '/' || path === '/auth/callback' || path === '/live' || path === '/live.html';
};
