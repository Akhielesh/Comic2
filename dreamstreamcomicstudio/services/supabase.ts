
import { createClient } from '@supabase/supabase-js';
import { resolveAuthRedirectUrl } from './productHost';
import { adoptStoredSessionOwner } from './localOwner';

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

// Sessions are PER HOST: the token lives in this origin's storage (storageKey below), so the
// apex and comics.dreamstreamstudio.ai each sign in once. Never move tokens between hosts with a
// `Domain=.dreamstreamstudio.ai` cookie or by copying refresh tokens — other subdomains (the
// retired Code Studio previews) ran user code. On the comics host the callback is always its own
// exact, Supabase-registered URL, never the apex VITE_AUTH_REDIRECT_URL (services/productHost.ts).
export const getAuthRedirectUrl = () => {
    if (typeof window === 'undefined') return resolveAuthRedirectUrl({ explicit: explicitAuthRedirectUrl });
    return resolveAuthRedirectUrl({
        explicit: explicitAuthRedirectUrl,
        hostname: window.location.hostname,
        origin: window.location.origin
    });
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

// Before any session can change: record which account already owns this device's local data
// (installs from before the marker existed), so a session for another account can't inherit it
// (services/localOwner). authStorage's self-healing read finds the session in either storage —
// localStorage ("Remember me") or sessionStorage (not remembered).
adoptStoredSessionOwner(typeof window === 'undefined' ? null : authStorage.getItem(SUPABASE_AUTH_STORAGE_KEY));

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '', {
    auth: {
        persistSession: true,
        storageKey: SUPABASE_AUTH_STORAGE_KEY,
        storage: authStorage,
        // SECURITY: never adopt a session from the address bar on our own. Tokens in a URL sign
        // the browser in, and anyone can make such a link for their own account. The pages our
        // links land on (App's /auth/callback, Stream Studio's consumeAuthReturn) read them
        // explicitly and sign in only when this browser asked to — or after the visitor
        // confirms (services/authLink.ts, services/pendingSignIn.ts).
        detectSessionInUrl: false
    }
});

/**
 * Who an access token belongs to (the "Finish signing in?" step names the account), asked of the
 * auth server. A plain request: nothing is stored, and this browser's own session is never
 * touched — supabase.auth.getUser(jwt) would sign the current session out when the token's
 * session no longer exists, which a crafted link could use to sign someone out.
 * `dead`: the server refused the token (401/403 — expired, or its session is gone). Such a link
 * can't sign in, and trying (setSession) would drop the session this browser has, so callers
 * report it as expired instead. A network failure or timeout is NOT dead — just unknown.
 */
export const lookupAccessTokenEmail = async (accessToken: string, timeoutMs = 8000): Promise<{ email: string | null; dead: boolean }> => {
    const unknown = { email: null, dead: false };
    if (!supabaseUrl || !supabaseAnonKey || !accessToken) return unknown;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await fetch(`${String(supabaseUrl).replace(/\/+$/, '')}/auth/v1/user`, {
            headers: { apikey: supabaseAnonKey, authorization: `Bearer ${accessToken}` },
            signal: controller?.signal
        });
        if (!res.ok) return { email: null, dead: res.status === 401 || res.status === 403 };
        const body = (await res.json().catch(() => null)) as { email?: unknown } | null;
        return { email: typeof body?.email === 'string' && body.email ? body.email : null, dead: false };
    } catch {
        return unknown;
    } finally {
        if (timer) clearTimeout(timer);
    }
};

/**
 * Is `session` the one THIS tab holds? supabase-js announces every auth event to every tab of the
 * origin (BroadcastChannel) without storing the session there. With "Remember me" off each tab
 * keeps its own session in sessionStorage, so a sign-in announced by another tab is not this
 * tab's: acting on it would flip this tab to that account (and purge this one's local data).
 * With "Remember me" on, storage is shared, so a real switch matches and is handled.
 *
 * Compared by access token against the session stored for this tab (either storage, read
 * without the self-healing move). A tab that stores nothing while "Remember me" is off holds
 * no session at all, so an announced one is not its own: false — the tab that asked for a
 * magic link must not adopt the session the tab the link opened in signed in to (it would show
 * that account with no session of its own: an empty dashboard, saves dropped, a reload signed
 * out). When it can't tell — nothing stored with "Remember me" on (shared storage, or storage
 * blocked) or no session to compare — it answers true and callers behave exactly as before.
 * Sign-outs are not sessions and are always honoured by callers.
 */
export const isStoredSession = (session: { access_token?: string | null } | null | undefined): boolean => {
    if (!session?.access_token || typeof window === 'undefined') return true;
    const mode = getAuthPersistMode();
    const raw =
        safeStorageGet(getModeStorage(mode), SUPABASE_AUTH_STORAGE_KEY) ??
        safeStorageGet(getModeStorage(mode === 'local' ? 'session' : 'local'), SUPABASE_AUTH_STORAGE_KEY);
    if (raw == null) return mode !== 'session';
    try {
        const stored = JSON.parse(raw) as { access_token?: unknown; currentSession?: { access_token?: unknown } } | null;
        const token = stored?.access_token ?? stored?.currentSession?.access_token;
        return typeof token !== 'string' || token === session.access_token;
    } catch {
        return true;
    }
};

/**
 * Forget the session THIS tab stores — without signing out. Another tab switched this device to
 * another account ("Remember me" off: each tab keeps its own session in sessionStorage), so this
 * tab must stop acting as its old account (contexts/AuthContext). supabase.auth.signOut would
 * broadcast SIGNED_OUT to every tab and sign the other account out as well; removing the stored
 * session touches only this tab: supabase-js reads the session from storage on every getSession
 * and refresh, so from here on this tab has none (its requests carry no token, a reload lands
 * signed out instead of resuming the old account and taking the device back). Nothing is
 * announced to anyone. Only the per-tab store is cleared: a shared "Remember me" session in
 * localStorage is every tab's, and never differs from an announced one in the first place.
 */
export const forgetTabSession = (): void => {
    if (typeof window === 'undefined') return;
    safeStorageRemove(window.sessionStorage, SUPABASE_AUTH_STORAGE_KEY);
};

/**
 * Drop the session this device stores (both storages) — the local half of a sign-out, for when
 * the auth server could not be told. supabase.auth.signOut keeps the stored session when POST
 * /logout fails with anything but 401/403/404 (offline, a flaky network), fires no SIGNED_OUT,
 * and its refresh timer keeps that session alive: the next refresh tick or reload signs the
 * account straight back in. supabase-js reads the session from storage on every getSession and
 * refresh, so once it is gone this device has none. Nothing is announced to other tabs.
 */
export const dropStoredSession = (): void => {
    if (typeof window === 'undefined') return;
    authStorage.removeItem(SUPABASE_AUTH_STORAGE_KEY);
};

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
