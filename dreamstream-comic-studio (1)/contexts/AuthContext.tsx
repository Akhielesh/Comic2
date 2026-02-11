
import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';
import { decryptKey } from '../services/crypto';
import { setFluxKey } from '../services/appSettings';

type AuthContextType = {
    user: User | null;
    session: Session | null;
    loading: boolean;
    signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
    user: null,
    session: null,
    loading: true,
    signOut: async () => { },
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

    const signOut = async () => {
        // Clear state first to update UI immediately and avoid loops driven by session listener
        setUser(null);
        setSession(null);
        localStorage.removeItem('dreamstream_api_key');
        setFluxKey(null);

        await supabase.auth.signOut();
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
        <AuthContext.Provider value={{ user, session, loading, signOut }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
