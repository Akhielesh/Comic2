
import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { getAuthRedirectUrl, supabase } from '../services/supabase';
import { decryptKey } from '../services/crypto';
import { clearFluxKey, setFluxKey } from '../services/appSettings';
import { clearAllKeys } from '../services/apiKeys';

type AuthContextType = {
    user: User | null;
    session: Session | null;
    loading: boolean;
    signOut: () => Promise<void>;
    signOutAll: () => Promise<void>;
    resendVerificationEmail: () => Promise<{ success: boolean; message: string }>;
    changePassword: (newPassword: string) => Promise<{ success: boolean; message: string }>;
};

const AuthContext = createContext<AuthContextType>({
    user: null,
    session: null,
    loading: true,
    signOut: async () => { },
    signOutAll: async () => { },
    resendVerificationEmail: async () => ({ success: false, message: 'Unavailable' }),
    changePassword: async () => ({ success: false, message: 'Unavailable' })
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
    const [user, setUser] = useState<User | null>(null);
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Check active session
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setUser(session?.user ?? null);
            setLoading(false);
            if (session?.user) {
                void syncKeys(session.user.id);
            }
        });

        // Listen for changes (login, logout, refresh)
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setUser(session?.user ?? null);
            setLoading(false);
            if (session?.user) {
                void syncKeys(session.user.id);
            }
        });

        return () => subscription.unsubscribe();
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

    const syncKeys = async (userId: string) => {
        const { data } = await supabase.from('user_api_keys').select('*').eq('user_id', userId);
        if (!data) return;

        for (const row of data) {
            try {
                const decrypted = await decryptKey(row.encrypted_key, row.iv);
                if (decrypted) {
                    if (row.provider === 'gemini') {
                        localStorage.setItem('dreamstream_api_key', decrypted);
                    } else if (row.provider === 'flux') {
                        setFluxKey(decrypted);
                    }
                }
            } catch (err) {
                console.error("Failed to decrypt key for", row.provider, err);
            }
        }
    };

    return (
        <AuthContext.Provider value={{ user, session, loading, signOut, signOutAll, resendVerificationEmail, changePassword }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
