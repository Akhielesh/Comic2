
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { forgetTabSession, getAuthRedirectUrl, isSessionExpiredByInactivity, isStoredSession, supabase, touchLastActivity } from '../services/supabase';
import { clearUserScopedSettings, setSettingsChangeListener } from '../services/appSettings';
import { clearAllKeys, setKeysChangeListener } from '../services/apiKeys';
import { setChatDataChangeListener, setChatSessionUser } from '../services/chatStorage';
import { appStatus } from '../services/appStatus';
import { clearModelSelection, MODEL_SELECTION_CHANGED } from '../services/modelSelection';
import { SOURCE_GOVERNANCE_CHANGED, clearGovernanceMap } from '../services/sourceGovernance';
import { registerDevice } from '../services/deviceSessions';
import { cancelScheduledPush, reconcileOnLogin, schedulePush } from '../services/cloudSync';
import { purgeLiveAccountData, takeOverDevice } from '../live/accountPurge';
import { clearLocalOwner, getLocalOwner, setLocalOwner } from '../services/localOwner';
import { clearPendingInviteCode } from '../services/invites';
import { EMAIL_SERVICE_DOWN, requestAuthEmail } from '../services/authEmail';
import { clearSignInIntents } from '../services/pendingSignIn';

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

/**
 * Shown (in the app's status bar) to a tab that stepped aside because another account signed in
 * on this device in another tab — see the "Remember me" off handling in AuthProvider.
 */
export const OTHER_TAB_SIGN_IN_NOTICE =
    'Signed in as another account in another tab. This tab was signed out so the two accounts’ data stay apart — continue in that tab, or sign in again here.';

/**
 * Shown to a signed-out tab that hears another tab sign in while "Remember me" is off (the tab
 * that asked for a magic link, once the link's tab signed in): that session is that tab's alone.
 */
export const SIGNED_IN_IN_OTHER_TAB_NOTICE =
    'Signed in in another tab. With “Remember me” off each tab signs in on its own — continue there, or sign in here.';

/** A login sync whose read of the account snapshot failed is run again once after this pause. */
const LOGIN_SYNC_RETRY_MS = 5_000;

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
    const loginSyncRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const applyAuthState = (nextSession: Session | null) => {
        // Chat rows are tagged by THIS tab's account (not the device-wide owner marker, which
        // another tab can move to a different account while this one keeps running).
        setChatSessionUser(nextSession?.user?.id ?? null);
        setSession((prev) => (isSameSession(prev, nextSession) ? prev : nextSession));
        setUser((prev) => {
            const nextUser = nextSession?.user ?? null;
            return isSameUser(prev, nextUser) ? prev : nextUser;
        });
    };

    useEffect(() => {
        // Mirror every local key/setting change up to the signed-in user's account.
        // schedulePush is a no-op while a pulled snapshot is being applied, so these
        // registrations never echo cloud data back as a fresh push.
        const pushIfSignedIn = () => {
            if (userIdRef.current) schedulePush(userIdRef.current);
        };
        setKeysChangeListener(pushIfSignedIn);
        setSettingsChangeListener(pushIfSignedIn);
        // Chat memory + custom agents, and the chat/comics model selection used to
        // change silently on one device only — sync them like keys.
        setChatDataChangeListener(pushIfSignedIn);
        window.addEventListener(MODEL_SELECTION_CHANGED, pushIfSignedIn);
        // Allowed-sources governance: an explicit OFF must follow the account (the
        // restore path fires this event under the applyingSnapshot guard, so no loop).
        window.addEventListener(SOURCE_GOVERNANCE_CHANGED, pushIfSignedIn);

        // The login sync reads the account's snapshot before anything is written to it. When that
        // read fails (a backend still waking up, a network blip, a row the server can't read) it
        // writes nothing — the account keeps its copy, this device its purged state — and is run
        // again: once after a short pause, then on the next session event (a token refresh) or a
        // reload, since a failed sync leaves `syncedUserRef` unset.
        const runLoginSync = (userId: string, retry: boolean) => {
            syncedUserRef.current = userId;
            void reconcileOnLogin(userId).then((outcome) => {
                if (outcome !== 'failed') return;
                if (syncedUserRef.current === userId) syncedUserRef.current = null;
                if (!retry || userIdRef.current !== userId) return;
                cancelLoginSyncRetry();
                loginSyncRetryRef.current = setTimeout(() => {
                    loginSyncRetryRef.current = null;
                    if (userIdRef.current !== userId || syncedUserRef.current === userId) return;
                    runLoginSync(userId, false);
                }, LOGIN_SYNC_RETRY_MS);
            });
        };

        // Reconcile cloud <-> local exactly once per signed-in user.
        const onSignedIn = (userId: string) => {
            const incoming = userId.toLowerCase();
            const previous = getLocalOwner();
            if (previous !== incoming) {
                // SECURITY: this device's account data isn't the incoming account's. Either another
                // account owns it (a session for someone else appeared without a sign-out: another
                // tab, a link) or NOBODY does — left over from a session that ended without a
                // sign-out (a not-remembered session gone with the browser, before the owner marker
                // existed). Signed-out visitors can't add keys or settings (Settings is a protected
                // view), so ownerless data is always someone's leftovers, and the first account to
                // sign in — possibly through a link the visitor was talked into confirming — must not
                // inherit or upload it. Its owner's cloud copy restores it on their next sign-in.
                // Stop every push aimed at the old data FIRST — the purge fires change events
                // (clearModelSelection → MODEL_SELECTION_CHANGED) and a push queued for the old id
                // would otherwise upload its chat memory / agents with the new session's token —
                // then purge, before the login sync could merge any of it into this account.
                userIdRef.current = null;
                syncedUserRef.current = null;
                cancelLoginSyncRetry();
                cancelScheduledPush();
                purgeMainAccountData();
                if (previous) {
                    // A real switch: a one-time invite captured for the previous account must not be
                    // redeemed by this one. (On a first sign-in it stays: that's the invite flow.)
                    clearPendingInviteCode();
                    // Stream Studio's copy stays only if this account already owns it — anything
                    // else (the previous account's, or data with no owner) goes.
                    takeOverDevice(userId);
                }
            }
            // Untagged chat rows (from before ownership tags) are NOT claimed here: only the account
            // whose session was stored at boot claims them (localOwner.adoptStoredSessionOwner).
            // Anyone else gets back what the cloud says is theirs (chatStorage.syncFromCloud).
            setLocalOwner(incoming);
            userIdRef.current = userId;
            void registerDevice(userId);
            if (syncedUserRef.current !== userId) runLoginSync(userId, true);
        };

        // Sessions idle for 30+ days sign out on this visit (the only automatic sign-out — reloads
        // and new tabs stay seamless). The verdict is taken ONCE, before anything can touch the
        // activity clock; while that sign-out is pending, session events are ignored, so the
        // login sync never starts for a session that is about to go (its pull could land after
        // the sign-out purge and write the account's keys back with no owner).
        let inactivitySignOutPending = isSessionExpiredByInactivity();

        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session && inactivitySignOutPending) {
                applyAuthState(null);
                setLoading(false);
                void supabase.auth
                    .signOut({ scope: 'local' })
                    .catch(() => undefined)
                    .finally(() => {
                        inactivitySignOutPending = false;
                    });
                return;
            }
            inactivitySignOutPending = false;
            touchLastActivity();
            applyAuthState(session);
            setLoading(false);
            if (session?.user) onSignedIn(session.user.id);
        });

        // Listen for changes (login, logout, refresh, recovery, profile updates)
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT') {
                inactivitySignOutPending = false;
                applyAuthState(session);
                setLoading(false);
                userIdRef.current = null;
                syncedUserRef.current = null;
                cancelLoginSyncRetry();
                // Purge on EVERY sign-out path (incl. Stream Studio's and the
                // inactivity policy), not just our own buttons — a shared
                // device must never keep the previous user's keys.
                clearLocalAuthState();
                return;
            }
            if (inactivitySignOutPending) return; // this session is being signed out (see above)
            // supabase-js announces every auth event to every tab without storing the session
            // there. With "Remember me" off each tab keeps its own session, so a session another
            // tab announced is not this tab's: acting on it would flip this tab to that account and
            // purge this one's data (and its own refresh would flip the other tab back). With
            // "Remember me" on, storage is shared, so a real switch matches and is handled.
            if (session && !isStoredSession(session)) {
                // The same account's event (its token refresh, say) is nothing to act on. A
                // DIFFERENT account's means that account took this device over in the other tab:
                // it purged what was here and the device's data is its now. This tab must stop
                // acting as its old account — every key, setting or chat it still wrote would land
                // in the new account's data and go up with its next sync. So it steps aside: no
                // purge (the other tab did it), no supabase sign-out (that would broadcast
                // SIGNED_OUT and sign the other tab out too); its own stored session is forgotten,
                // so neither a reload nor a token refresh brings the old account back here to take
                // the device over again — and the person is told why.
                const current = userIdRef.current;
                if (current && session.user?.id && session.user.id.toLowerCase() !== current.toLowerCase()) {
                    userIdRef.current = null;
                    syncedUserRef.current = null;
                    cancelLoginSyncRetry();
                    cancelScheduledPush();
                    forgetTabSession();
                    applyAuthState(null);
                    setLoading(false);
                    appStatus.report('warn', OTHER_TAB_SIGN_IN_NOTICE, { source: 'auth' });
                } else if (!current && event === 'SIGNED_IN') {
                    // A signed-out tab with "Remember me" off (nothing stored here): another tab
                    // signed in — the tab a magic link opened in, say. That session is that tab's
                    // alone; this one stays signed out, and says why. (Its own sign-ins store the
                    // session before the event, so they match and are applied as ever.)
                    appStatus.report('info', SIGNED_IN_IN_OTHER_TAB_NOTICE, { source: 'auth' });
                }
                return;
            }
            applyAuthState(session);
            setLoading(false);
            if (!session?.user) return;
            if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
                touchLastActivity(); // any authenticated activity resets the 30-day idle clock
            }
            // EVERY event that carries a session takes the ownership step — PASSWORD_RECOVERY
            // (a recovery link), USER_UPDATED, MFA_CHALLENGE_VERIFIED included — so a session for
            // another account can never inherit this device's data without the purge.
            onSignedIn(session.user.id);
        });

        return () => {
            subscription.unsubscribe();
            cancelLoginSyncRetry();
            setKeysChangeListener(null);
            setSettingsChangeListener(null);
            setChatDataChangeListener(null);
            window.removeEventListener(MODEL_SELECTION_CHANGED, pushIfSignedIn);
            window.removeEventListener(SOURCE_GOVERNANCE_CHANGED, pushIfSignedIn);
        };
    }, []);

    const clearLocalAuthState = () => {
        setUser(null);
        setSession(null);
        purgeLocalAccountData();
    };

    // Hoisted: the sign-in handler in the effect above calls these.
    /** Drop a login-sync retry still waiting (a sign-out, a switch: it was for the old account). */
    function cancelLoginSyncRetry() {
        if (loginSyncRetryRef.current) clearTimeout(loginSyncRetryRef.current);
        loginSyncRetryRef.current = null;
    }

    /** The main app's account-scoped data on this device (keys, settings, model choices). */
    function purgeMainAccountData() {
        // A push still queued for the account being purged must never run.
        cancelScheduledPush();
        // SECURITY: purge ALL BYOK keys + usage from the multi-key store so a shared device
        // never leaks the previous user's secrets, usage, or live provider balance after
        // sign-out (clearAllKeys also wipes every legacy single-key slot, incl. flux).
        clearAllKeys();
        // Account-scoped preferences stored under global localStorage keys must go too —
        // otherwise the next sign-in inherits them AND the login merge uploads them into
        // that other account's cloud snapshot.
        clearUserScopedSettings();
        clearModelSelection();
        // The provider on/off choices are synced with the account like the rest.
        clearGovernanceMap();
        // Retired Code Studio's model pin (ADR 0005); still cleared so no old copy lingers.
        try { localStorage.removeItem('dreamstream_studio_model'); } catch { /* storage unavailable */ }
        // Chat history (IndexedDB) is scoped by owner instead of wiped: the next account never
        // sees or pushes it, and it is back when its owner signs in (services/chatStorage).
    }

    /** Sign-out: everything account-scoped goes, Stream Studio's copy too, and the owner marker. */
    function purgeLocalAccountData() {
        purgeMainAccountData();
        // Nothing here waits for an emailed link any more: the next link asks, whoever it is for.
        clearSignInIntents();
        // Stream Studio (/live) keeps its own copy of the name, events, nursery data and
        // an alert subscription — wipe those too, so it never shows the last person.
        purgeLiveAccountData();
        clearLocalOwner();
    }

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

        // Sent by our backend (signed in + own address ⇒ no captcha needed).
        const viaApi = await requestAuthEmail(
            'resend',
            { email: user.email, app: 'main' },
            { accessToken: session?.access_token }
        );
        if (viaApi.status === 'ok') return { success: true, message: 'Verification email sent. Check your inbox.' };
        if (viaApi.status === 'error') {
            return { success: false, message: viaApi.message || 'Failed to resend verification email.' };
        }

        // Never Supabase's own mailer: every auth email comes from dreamstreamstudio.ai.
        return { success: false, message: EMAIL_SERVICE_DOWN };
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
