
import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { getAuthRedirectUrl, supabase } from '../services/supabase';
import { decryptKey, encryptKey } from '../services/crypto';
import { clearFluxKey, setFluxKey, setOpenRouterKey } from '../services/appSettings';
import { clearAllKeys, addKey, listKeysByProvider, PROVIDER_META, type ApiKeyProvider } from '../services/apiKeys';
import { registerDevice } from '../services/deviceSessions';

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

    useEffect(() => {
        // Check active session
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setUser(session?.user ?? null);
            setLoading(false);
            if (session?.user) {
                void syncKeys(session.user.id);
                void registerDevice(session.user.id);
            }
        });

        // Listen for changes (login, logout, refresh)
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            setSession(session);
            setUser(session?.user ?? null);
            setLoading(false);
            if (session?.user && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
                void syncKeys(session.user.id);
                void registerDevice(session.user.id);
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

    const syncKeys = async (userId: string) => {
        const { data } = await supabase.from('user_api_keys').select('*').eq('user_id', userId);
        if (!data) return;

        for (const row of data) {
            try {
                const decrypted = await decryptKey(row.encrypted_key, row.iv);
                if (!decrypted) continue;

                const provider = row.provider as ApiKeyProvider;

                // Restore legacy single-key slots so existing code paths keep working.
                if (provider === 'gemini') {
                    localStorage.setItem('dreamstream_api_key', decrypted);
                } else if (provider === 'pixazo') {
                    setFluxKey(decrypted);
                } else if (provider === 'openrouter') {
                    setOpenRouterKey(decrypted);
                }

                // Restore to the multi-key store (dreamstream_api_keys_v2) if this
                // provider has no entry there yet — prevents duplicates on repeated logins.
                if (provider in PROVIDER_META && listKeysByProvider(provider).length === 0) {
                    addKey({
                        provider,
                        key: decrypted,
                        label: `${PROVIDER_META[provider as ApiKeyProvider]?.label ?? provider} key`
                    });
                }
            } catch (err) {
                console.error("Failed to decrypt key for", row.provider, err);
            }
        }
    };

    return (
        <AuthContext.Provider value={{ user, session, loading, signOut, signOutAll, signOutOthers, resendVerificationEmail, changePassword }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
