
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { getAuthRedirectUrl, supabase } from '../services/supabase';
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

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
    const [user, setUser] = useState<User | null>(null);
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const userIdRef = useRef<string | null>(null);
    const syncedUserRef = useRef<string | null>(null);

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

        // Check active session
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setUser(session?.user ?? null);
            setLoading(false);
            if (session?.user) onSignedIn(session.user.id);
        });

        // Listen for changes (login, logout, refresh)
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            setSession(session);
            setUser(session?.user ?? null);
            setLoading(false);
            if (session?.user && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
                onSignedIn(session.user.id);
            }
            if (event === 'SIGNED_OUT') {
                userIdRef.current = null;
                syncedUserRef.current = null;
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

    return (
        <AuthContext.Provider value={{ user, session, loading, signOut, signOutAll, signOutOthers, resendVerificationEmail, changePassword }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
