// Which account this device's account-scoped local data belongs to (BYOK keys, settings,
// model choices, chat history, Stream Studio's copy). The login sync merges local data INTO
// the signed-in account's cloud snapshot, so a session for a DIFFERENT account must never
// inherit it: a sign-in link carrying someone else's tokens would otherwise upload this
// device's keys into that other account.
//
// The marker is set once a signed-in account owns the local data, cleared on every sign-out,
// and adopted at boot from an already-stored session (installs from before the marker
// existed) before any session can change.
//
// Data written before ownership tags existed (chat sessions and projects without an
// `ownerUserId`) belongs to ONE account: the one whose session was stored here when the tags
// arrived (adopted at boot). It is recorded once and never handed to a later account. A device
// with no stored session leaves it unclaimed — whoever signs in first there may not be its owner
// (a shared computer, or a sign-in link the visitor was talked into confirming); chat sync gives
// each account back the rows its cloud copy proves are its own (chatStorage.syncFromCloud).

export const LOCAL_OWNER_KEY = 'ds.localDataOwner';
/** The account that owns this device's untagged (pre-ownership) data. Set once. */
export const UNOWNED_DATA_OWNER_KEY = 'ds.unownedDataOwner';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const storage = (): Storage | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

// When localStorage refuses a write (quota full, blocked storage), the owner lives in this tab's
// memory instead — never a stale stored value: the old one is removed first, so cloud sync and
// chat tagging keep following the account that is actually signed in.
let memoryOwner: { value: string | null } | null = null;

export const getLocalOwner = (): string | null => {
  if (memoryOwner) return memoryOwner.value;
  try {
    const value = storage()?.getItem(LOCAL_OWNER_KEY) ?? null;
    return value && UUID_RE.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
};

export const setLocalOwner = (userId: string): void => {
  if (!UUID_RE.test(userId)) return;
  const id = userId.toLowerCase();
  memoryOwner = null;
  try {
    storage()?.setItem(LOCAL_OWNER_KEY, id);
  } catch {
    try {
      storage()?.removeItem(LOCAL_OWNER_KEY);
    } catch {
      /* storage unavailable */
    }
    memoryOwner = { value: id };
  }
};

export const clearLocalOwner = (): void => {
  memoryOwner = null;
  try {
    storage()?.removeItem(LOCAL_OWNER_KEY);
  } catch {
    memoryOwner = { value: null };
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

/** The account that owns this device's untagged data, or null while nobody has claimed it. */
export const getUnownedDataOwner = (): string | null => {
  try {
    const value = storage()?.getItem(UNOWNED_DATA_OWNER_KEY) ?? null;
    return value && UUID_RE.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** Give this device's untagged data to `userId` — only if no account has claimed it yet. */
export const claimUnownedData = (userId: string): void => {
  if (!UUID_RE.test(userId) || getUnownedDataOwner()) return;
  try {
    storage()?.setItem(UNOWNED_DATA_OWNER_KEY, userId.toLowerCase());
  } catch {
    /* storage unavailable */
  }
};

/** Boot: an install from before the marker existed adopts its stored session's account. */
export const adoptStoredSessionOwner = (storedSession: string | null | undefined): void => {
  if (getLocalOwner()) return;
  const id = userIdFromStoredSession(storedSession);
  if (!id) return;
  setLocalOwner(id);
  claimUnownedData(id);
};

/**
 * True when local data belongs to another account than `userId` and must be purged before
 * the login sync runs (never merged into this account).
 */
export const ownedByAnotherAccount = (userId: string): boolean => {
  const owner = getLocalOwner();
  return !!owner && owner !== userId.toLowerCase();
};

/** True when `userId` is the account that owns this device's local data right now. */
export const isLocalOwner = (userId: string | null | undefined): boolean => {
  const owner = getLocalOwner();
  return !!owner && !!userId && owner === userId.toLowerCase();
};
