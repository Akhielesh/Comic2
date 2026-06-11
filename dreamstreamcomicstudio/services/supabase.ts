
import { createClient } from '@supabase/supabase-js';

// These will be populated by the user in .env.local
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const explicitAuthRedirectUrl = import.meta.env.VITE_AUTH_REDIRECT_URL;
const AUTH_PERSISTENCE_KEY = 'dreamstream_auth_persist';
const SUPABASE_AUTH_STORAGE_KEY = 'dreamstream_auth_token';

export type AuthPersistMode = 'local' | 'session';

const safeStorageGet = (storage: Storage | undefined, key: string) => {
    if (!storage) return null;
    try {
        return storage.getItem(key);
    } catch {
        return null;
    }
};

const safeStorageSet = (storage: Storage | undefined, key: string, value: string) => {
    if (!storage) return;
    try {
        storage.setItem(key, value);
    } catch {
        // ignore storage access issues
    }
};

const safeStorageRemove = (storage: Storage | undefined, key: string) => {
    if (!storage) return;
    try {
        storage.removeItem(key);
    } catch {
        // ignore storage access issues
    }
};

const getModeStorage = (mode: AuthPersistMode) => {
    if (typeof window === 'undefined') return undefined;
    return mode === 'session' ? window.sessionStorage : window.localStorage;
};

export const getAuthPersistMode = (): AuthPersistMode => {
    if (typeof window === 'undefined') return 'local';
    const stored = safeStorageGet(window.localStorage, AUTH_PERSISTENCE_KEY);
    return stored === 'session' ? 'session' : 'local';
};

export const setAuthPersistMode = (mode: AuthPersistMode) => {
    if (typeof window === 'undefined') return;
    const prev = getAuthPersistMode();
    safeStorageSet(window.localStorage, AUTH_PERSISTENCE_KEY, mode);
    // CRITICAL: migrate the live token to the new home. Flipping the preference
    // without moving the token meant getItem looked in the NEW storage, found
    // nothing, and every reload booted the user out while their real session
    // rotted in the old storage.
    if (prev !== mode) {
        const from = getModeStorage(prev);
        const to = getModeStorage(mode);
        const token = safeStorageGet(from, SUPABASE_AUTH_STORAGE_KEY);
        if (token != null) {
            safeStorageSet(to, SUPABASE_AUTH_STORAGE_KEY, token);
            safeStorageRemove(from, SUPABASE_AUTH_STORAGE_KEY);
        }
    }
};

export const getAuthRedirectUrl = () => {
    if (explicitAuthRedirectUrl && explicitAuthRedirectUrl.trim()) {
        return explicitAuthRedirectUrl.trim();
    }
    if (typeof window === 'undefined') return '/auth/callback';
    return `${window.location.origin}/auth/callback`;
};

const authStorage = {
    getItem: (key: string) => {
        // Self-healing read: if the preferred storage is empty but the OTHER one
        // holds a session (pref flipped by an older build, partial sign-out,
        // multi-tab races), adopt it instead of silently logging the user out.
        // Staying signed in beats losing a session every time.
        const mode = getAuthPersistMode();
        const primary = getModeStorage(mode);
        const found = safeStorageGet(primary, key);
        if (found != null) return found;
        const secondary = getModeStorage(mode === 'local' ? 'session' : 'local');
        const rescued = safeStorageGet(secondary, key);
        if (rescued != null) {
            safeStorageSet(primary, key, rescued);
            safeStorageRemove(secondary, key);
        }
        return rescued;
    },
    setItem: (key: string, value: string) => {
        const mode = getAuthPersistMode();
        const primary = getModeStorage(mode);
        const secondary = getModeStorage(mode === 'local' ? 'session' : 'local');
        safeStorageSet(primary, key, value);
        safeStorageRemove(secondary, key);
    },
    removeItem: (key: string) => {
        safeStorageRemove(getModeStorage('local'), key);
        safeStorageRemove(getModeStorage('session'), key);
    }
};

if (!supabaseUrl || !supabaseAnonKey) {
    // We check for these to provide a helpful error, but we don't crash immediately 
    // to allow the app to render the "Setup Required" or Login screen effectively.
    console.warn('Missing Supabase URL or Anon Key. Authentication will not work.');
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '', {
    auth: {
        persistSession: true,
        storageKey: SUPABASE_AUTH_STORAGE_KEY,
        storage: authStorage
    }
});

/* ----------------------- session inactivity policy ----------------------- */

const LAST_ACTIVITY_KEY = 'dreamstream_last_active_at';
/** Sessions idle longer than this are signed out on next visit. */
export const INACTIVITY_SIGNOUT_MS = 30 * 24 * 60 * 60 * 1000;

/** Stamp "the user was here" — call on app boot and on auth events. */
export const touchLastActivity = () => {
    if (typeof window === 'undefined') return;
    safeStorageSet(window.localStorage, LAST_ACTIVITY_KEY, String(Date.now()));
};

/**
 * True when the stored session sat unused for 30+ days — the caller should
 * sign out (seamless login until then; explicit sign-out always wins).
 * A missing stamp (first run on an old install) just starts the clock now.
 */
export const isSessionExpiredByInactivity = (): boolean => {
    if (typeof window === 'undefined') return false;
    const raw = safeStorageGet(window.localStorage, LAST_ACTIVITY_KEY);
    if (!raw) {
        touchLastActivity();
        return false;
    }
    const last = Number(raw);
    return Number.isFinite(last) && Date.now() - last > INACTIVITY_SIGNOUT_MS;
};
