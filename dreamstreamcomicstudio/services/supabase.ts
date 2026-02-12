
import { createClient } from '@supabase/supabase-js';

// These will be populated by the user in .env.local
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
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
    safeStorageSet(window.localStorage, AUTH_PERSISTENCE_KEY, mode);
};

const authStorage = {
    getItem: (key: string) => {
        const storage = getModeStorage(getAuthPersistMode());
        return safeStorageGet(storage, key);
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
