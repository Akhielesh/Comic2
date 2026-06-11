
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { getAuthRedirectUrl, isSessionExpiredByInactivity, supabase, touchLastActivity } from '../services/supabase';
import { clearFluxKey, setSettingsChangeListener } from '../services/appSettings';
import { clearAllKeys, setKeysChangeListener } from '../services/apiKeys';
import { registerDevice } from '../services/deviceSessions';
import { syncOnLogin, schedulePush } from '../services/cloudSync';

type AuthContextType = {
    user: User | null;
    session: Session | null;
    loading: boolean;
    signOut: () => Promise<void>;
    signOutAll: () => Promise<void>;
    signOutOthers: () => Promise<{ success: boolean; message: string }>;
    resendVerificationEmail: () => Promise<{ success: boolean; message: string }>;
    changePassword: (newPassword: string) => Promise<{ success: boolean; message: string }>;
};

const AuthContext = createContext<AuthContextType>({
    user: null,
    session: null,
    loading: true,
    signOut: async () => { },
    signOutAll: async () => { },
    signOutOthers: async () => ({ success: false, message: 'Unavailable' }),
    resendVerificationEmail: async () => ({ success: false, message: 'Unavailable' }),
    changePassword: async () => ({ success: false, message: 'Unavailable' })
});

// Supabase fires onAuthStateChange(TOKEN_REFRESHED) on every window refocus with a
// brand-new user/session object even when nothing meaningful changed. Swapping React
// state to those fresh identities re-ran every consumer keyed on `user`/`session`
// (profile reloads, billing refetches, form resets) each time the user switched browser
// tabs. These guards keep the SAME object identity unless something real changed.
const isSameUser = (prev: User | null, next: User | null): boolean => {
    if (prev === next) return true;
    if (!prev || !next) return false;
    return (
        prev.id === next.id &&
        prev.email === next.email &&
        prev.updated_at === next.updated_at &&
        prev.email_confirmed_at === next.email_confirmed_at
    );
};

const isSameSession = (prev: Session | null, next: Session | null): boolean => {
    if (prev === next) return true;
    if (!prev || !next) return false;
    return (
        prev.access_token === next.access_token &&
        prev.expires_at === next.expires_at &&
        isSameUser(prev.user, next.user)
    );
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
    const [user, setUser] = useState<User | null>(null);
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const userIdRef = useRef<string | null>(null);
    const syncedUserRef = useRef<string | null>(null);

    const applyAuthState = (nextSession: Session | null) => {
        setSession((prev) => (isSameSession(prev, nextSession) ? prev : nextSession));
        setUser((prev) => {
            const nextUser = nextSession?.user ?? null;
            return isSameUser(prev, nextUser) ? prev : nextUser;
        });
    };

    useEffect(() => {
        // Mirror every local key/setting change up to the signed-in user's account.
        const pushIfSignedIn = () => {
            if (userIdRef.current) schedulePush(userIdRef.current);
        };
        setKeysChangeListener(pushIfSignedIn);
        setSettingsChangeListener(pushIfSignedIn);

        // Reconcile cloud <-> local exactly once per signed-in user.
        const onSignedIn = (userId: string) => {
            userIdRef.current = userId;
            void registerDevice(userId);
            if (syncedUserRef.current !== userId) {
                syncedUserRef.current = userId;
                void syncOnLogin(userId);
            }
        };

        // Check active session. Sessions idle for 30+ days sign out here
        // (the only automatic sign-out — reloads and new tabs stay seamless).
        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session && isSessionExpiredByInactivity()) {
                applyAuthState(null);
                setLoading(false);
                void supabase.auth.signOut({ scope: 'local' });
                return;
            }
            touchLastActivity();
            applyAuthState(session);
            setLoading(false);
            if (session?.user) onSignedIn(session.user.id);
        });

        // Listen for changes (login, logout, refresh)
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            applyAuthState(session);
            setLoading(false);
            if (session?.user && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
                touchLastActivity(); // any authenticated activity resets the 30-day idle clock
                onSignedIn(session.user.id);
            }
            if (event === 'SIGNED_OUT') {
                userIdRef.current = null;
                syncedUserRef.current = null;
                // Purge on EVERY sign-out path (incl. Stream Studio's and the
                // inactivity policy), not just our own buttons — a shared
                // device must never keep the previous user's keys.
                clearLocalAuthState();
            }
        });

        return () => {
            subscription.unsubscribe();
            setKeysChangeListener(null);
            setSettingsChangeListener(null);
        };
    }, []);

    const clearLocalAuthState = () => {
        setUser(null);
        setSession(null);
        try {
            localStorage.removeItem('dreamstream_api_key');
        } catch {
            // ignore storage access issues
        }
        clearFluxKey();
        // SECURITY: purge ALL BYOK keys + usage from the multi-key store so a shared device
        // never leaks the previous user's secrets, usage, or live provider balance after sign-out.
        clearAllKeys();
    };

    const signOut = async () => {
        clearLocalAuthState();
        await supabase.auth.signOut({ scope: 'local' });
    };

    const signOutAll = async () => {
        clearLocalAuthState();
        await supabase.auth.signOut({ scope: 'global' });
    };

    /** Sign out every session EXCEPT the current device — you stay logged in. */
    const signOutOthers = async (): Promise<{ success: boolean; message: string }> => {
        try {
            const { error } = await supabase.auth.signOut({ scope: 'others' });
            if (error) throw error;
            return { success: true, message: 'All other sessions have been signed out.' };
        } catch (err: any) {
            return { success: false, message: err?.message || 'Failed to sign out other sessions.' };
        }
    };

    const resendVerificationEmail = async (): Promise<{ success: boolean; message: string }> => {
        if (!user?.email) {
            return { success: false, message: 'No account email found for verification.' };
        }

        const { error } = await supabase.auth.resend({
            type: 'signup',
            email: user.email,
            options: {
                emailRedirectTo: getAuthRedirectUrl()
            }
        });

        if (error) return { success: false, message: error.message || 'Failed to resend verification email.' };
        return { success: true, message: 'Verification email sent. Check your inbox.' };
    };

    const changePassword = async (newPassword: string): Promise<{ success: boolean; message: string }> => {
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) return { success: false, message: error.message || 'Failed to update password.' };
        return { success: true, message: 'Password updated successfully.' };
    };

    // Stable context value: without this, every AuthProvider render hands consumers a new
    // object and re-renders the entire tree below it (the methods only depend on `user`).
    const value = React.useMemo(
        () => ({ user, session, loading, signOut, signOutAll, signOutOthers, resendVerificationEmail, changePassword }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [user, session, loading]
    );

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
