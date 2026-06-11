import React, { useEffect, useRef, useState } from 'react';
import { UserPrivateProfile, UserProfile } from '../types';
import { supabase } from '../services/supabase';
import {
    getPrivateProfile,
    getUserProfile,
    saveImage,
    savePublicContactMessage,
    syncMarketingConsentLegacy,
    updateUserProfile,
    upsertPrivateProfile
} from '../services/db';
import { getSettingsState, setSettingsState as persistSettingsState } from '../services/appSettings';
import { Button } from './Button';
import { ApiConfiguration } from './ApiConfiguration';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Bell, CheckCircle2, ChevronLeft, FileText, KeyRound, LifeBuoy, LogOut, Mail, Monitor, Save, Shield, ShieldCheck, Trash2, Upload, User as UserIcon, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { patchUrlParams, persistUiState, resolveInitialUiState } from '../services/viewState';
import { listDevices, removeDevice, currentDeviceId, type UserDevice } from '../services/deviceSessions';
import { isImageModelAllowedForPlan } from '../services/imageModels';
import { TEXT_MODEL } from '../services/modelPolicy';
import type {
    AdminAccessResponse,
    BillingSummaryResponse
} from '../shared/types/billing';
import { getAdminAccess, getBillingSummary } from '../services/billing';
import { buildModelEntitlements } from '../services/modelEntitlements';
import { isFreeOnly, setFreeOnly, onFreeOnlyChanged } from '../services/freeOnlyMode';
import { AdminConsole } from './admin/AdminConsole';
import { isSettingsTab, type SettingsTab } from './settingsTabs';
import { InviteFriends } from './InviteFriends';
import { RedeemInvite } from './RedeemInvite';

interface AccountSettingsProps {
    onClose: () => void;
    initialTab?: SettingsTab;
    /** Bumped by App on every explicit tab navigation, so re-requesting the SAME tab
     *  (e.g. header → Profile while the user sits on Billing) still applies. */
    initialTabRequestId?: number;
    onSignedOut?: () => void;
    requireDobCompletion?: boolean;
    onDobCompletionStatusChange?: (needsCompletion: boolean) => void;
    openPasswordReset?: boolean;
    onPasswordResetHandled?: () => void;
    onNavigate?: (view: string) => void;
}

type MessageState = { type: 'success' | 'error'; text: string } | null;

const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;
const normalizeText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const ContactSection = () => {
    const { user } = useAuth();
    const [msg, setMsg] = useState('');
    const [contactEmail, setContactEmail] = useState(user?.email || '');
    const [phone, setPhone] = useState('');
    const [sent, setSent] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const words = normalizeText(msg) ? normalizeText(msg).split(/\s+/).length : 0;

    const send = async (e: React.FormEvent) => {
        e.preventDefault();
        setSendError(null);
        if (words > 300) return;
        const normalizedEmail = normalizeText(contactEmail);
        const normalizedMessage = normalizeText(msg);
        const normalizedPhone = normalizeText(phone);
        if (!normalizedEmail || !normalizedMessage) {
            setSendError('Email and message are required.');
            return;
        }
        const finalMessage = normalizedPhone ? `[Phone: ${normalizedPhone}]\n\n${normalizedMessage}` : normalizedMessage;
        const saved = await savePublicContactMessage(normalizedEmail, finalMessage);
        if (saved) {
            setSent(true);
        } else {
            setSendError('Unable to send message right now. Please try again.');
        }
    };

    if (sent) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
                <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-4 border-4 border-black">
                    <Mail size={40} />
                </div>
                <h3 className="font-display text-2xl">Message Sent!</h3>
                <p className="font-comic text-slate-600 mt-2">A representative will be in touch shortly.</p>
                <button onClick={() => setSent(false)} className="mt-8 text-sm font-bold underline">Send another</button>
            </div>
        );
    }

    return (
        <div className="max-w-xl animate-fade-in">
            <h3 className="font-display text-2xl mb-2">Contact Support</h3>
            <p className="text-slate-500 mb-6 font-comic">
                Share bugs, billing issues, or feature requests. We usually reply within 1-2 business days.
            </p>
            <div className="mb-6 p-4 bg-slate-50 border-2 border-slate-200 rounded-lg text-sm">
                <p className="font-bold mb-1">Basic Contact Info</p>
                <p className="text-slate-600">Support Email: support@dreamstream.com</p>
                <p className="text-slate-600">Business Hours: Mon-Fri, 9:00 AM - 6:00 PM</p>
            </div>
            <form onSubmit={send} className="space-y-4">
                <div>
                    <label className="font-bold text-xs uppercase">Your Email</label>
                    <input
                        type="email"
                        required
                        value={contactEmail}
                        onChange={e => setContactEmail(e.target.value)}
                        className="w-full mt-1 border-2 border-black rounded-lg px-4 py-2 font-mono"
                    />
                </div>
                <div>
                    <label className="font-bold text-xs uppercase">Phone Number (Optional)</label>
                    <input
                        type="tel"
                        value={phone}
                        onChange={e => setPhone(e.target.value)}
                        className="w-full mt-1 border-2 border-black rounded-lg px-4 py-2 font-mono"
                    />
                </div>
                <div>
                    <label className="font-bold text-xs uppercase">Message (300 words max)</label>
                    <textarea
                        required
                        rows={6}
                        value={msg}
                        onChange={e => setMsg(e.target.value)}
                        className="w-full mt-1 border-2 border-black rounded-lg px-4 py-2 font-mono"
                    />
                    <div className={`text-right text-xs mt-1 ${words > 300 ? 'text-red-500 font-bold' : 'text-slate-400'}`}>
                        {words}/300 words
                    </div>
                </div>
                {sendError && <div className="text-xs font-bold text-red-600">{sendError}</div>}
                <Button type="submit" icon={<Mail size={16} />} disabled={words > 300}>Send Message</Button>
            </form>
        </div>
    );
};

export const AccountSettings: React.FC<AccountSettingsProps> = ({
    onClose,
    initialTab = 'profile',
    initialTabRequestId = 0,
    onSignedOut,
    requireDobCompletion = false,
    onDobCompletionStatusChange,
    openPasswordReset = false,
    onPasswordResetHandled,
    onNavigate
}) => {
    const { user, signOut, signOutAll, signOutOthers, resendVerificationEmail, changePassword } = useAuth();
    // Tab continuity: a reload (or Chrome discarding this tab in the background) restores
    // the exact settings tab from ?tab= / session memory instead of bouncing to Profile.
    const [activeTab, setActiveTab] = useState<SettingsTab>(() =>
        resolveInitialUiState<SettingsTab>('settings.tab', 'tab', (v): v is SettingsTab => isSettingsTab(v), initialTab)
    );
    const [previewAvatar, setPreviewAvatar] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [privateProfile, setPrivateProfile] = useState<UserPrivateProfile | null>(null);
    const [privateProfileWarning, setPrivateProfileWarning] = useState<string | null>(null);

    const [isAdmin, setIsAdmin] = useState(false);
    const [isModerator, setIsModerator] = useState(false);
    const [adminAccess, setAdminAccess] = useState<AdminAccessResponse | null>(null);
    // Whether the /api/admin/me probe has settled (success OR failure). The admin tab
    // renders a "checking access" state until then, so the console never mounts with a
    // not-yet-true isAdmin and silently downgrades a deep-linked admin-only section.
    const [accessChecked, setAccessChecked] = useState(false);
    const [settingsState, setSettingsState] = useState(() => getSettingsState());
    // Billing summary is only fetched to derive model entitlements (default text/image
    // models) for the API & Models tab — there is no plan/billing UI anymore.
    const [billingSummary, setBillingSummary] = useState<BillingSummaryResponse | null>(null);

    const [username, setUsername] = useState('');
    const [avatarUrl, setAvatarUrl] = useState('');
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [dob, setDob] = useState('');
    const [emailPrefProductUpdates, setEmailPrefProductUpdates] = useState(true);
    const [emailPrefMarketing, setEmailPrefMarketing] = useState(false);
    const [freeOnly, setFreeOnlyState] = useState<boolean>(() => isFreeOnly());
    useEffect(() => onFreeOnlyChanged((on) => setFreeOnlyState(on)), []);

    const [isSavingProfile, setIsSavingProfile] = useState(false);
    const [isSavingPreferences, setIsSavingPreferences] = useState(false);
    const [profileMessage, setProfileMessage] = useState<MessageState>(null);
    const [preferencesMessage, setPreferencesMessage] = useState<MessageState>(null);
    const [securityMessage, setSecurityMessage] = useState<MessageState>(null);
    const [securityBusy, setSecurityBusy] = useState(false);
    const [devices, setDevices] = useState<UserDevice[]>([]);
    const [devicesLoading, setDevicesLoading] = useState(false);
    const [devicesError, setDevicesError] = useState<string | null>(null);
    const [sessionActionMsg, setSessionActionMsg] = useState<MessageState>(null);
    const [sessionBusy, setSessionBusy] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmNewPassword, setConfirmNewPassword] = useState('');

    // Respond to in-app navigation (e.g. header → "Billing") after mount. Driven by the
    // request id, not the tab value, so re-requesting the same tab still applies; the
    // previous-value compare (not a boolean "first run" flag) keeps this correct under
    // StrictMode's mount→unmount→mount, where refs persist and a flag would mis-fire and
    // clobber the tab just restored from URL/session memory.
    const seenTabRequestRef = useRef(initialTabRequestId);
    useEffect(() => {
        if (seenTabRequestRef.current !== initialTabRequestId) {
            seenTabRequestRef.current = initialTabRequestId;
            setActiveTab(initialTab);
        }
    }, [initialTabRequestId, initialTab]);

    // Keep both continuity layers in sync with the live tab; drop the URL param on exit
    // so other views don't carry a stale ?tab= around (session memory is kept on purpose —
    // reopening Settings later in this browser tab returns to where the user left off).
    useEffect(() => {
        persistUiState('settings.tab', 'tab', activeTab);
    }, [activeTab]);
    useEffect(() => () => patchUrlParams({ tab: null }), []);

    useEffect(() => {
        if (!openPasswordReset) return;
        setActiveTab('security');
        setSecurityMessage({ type: 'success', text: 'Recovery link verified. Set a new password below.' });
        onPasswordResetHandled?.();
    }, [openPasswordReset, onPasswordResetHandled]);

    useEffect(() => {
        if (!user) {
            setIsAdmin(false);
            setIsModerator(false);
            setAdminAccess(null);
            setAccessChecked(true);
            return;
        }

        setAccessChecked(false);
        let active = true;
        const loadAccess = async () => {
            try {
                const access = await getAdminAccess();
                if (!active) return;
                setAdminAccess(access);
                setIsAdmin(access.isAdmin);
                setIsModerator(access.isModerator);
            } catch {
                if (!active) return;
                const fallbackAdmin = user.email === 'admin@test.com';
                setIsAdmin(fallbackAdmin);
                setIsModerator(fallbackAdmin);
                setAdminAccess(null);
            } finally {
                if (active) setAccessChecked(true);
            }
        };

        void loadAccess();
        return () => {
            active = false;
        };
        // Keyed on the user id, not the user object: Supabase mints a fresh user object on
        // every token refresh (each tab refocus), which used to re-run this needlessly.
    }, [user?.id]);

    useEffect(() => {
        if (activeTab !== 'settings' || !user) return;
        let alive = true;

        const loadEntitlements = async () => {
            try {
                const summary = await getBillingSummary();
                if (alive) setBillingSummary(summary);
            } catch {
                // Entitlement clamping simply stays on defaults when the summary is unavailable.
            }
        };

        void loadEntitlements();
        return () => {
            alive = false;
        };
    }, [activeTab, user?.id]);

    useEffect(() => {
        if (!billingSummary) return;
        const entitlements = buildModelEntitlements(billingSummary);
        const requestedTextModel = settingsState.defaultTextModel || settingsState.defaultTextModelKey || TEXT_MODEL;
        const nextSettings = { ...settingsState };
        let changed = false;

        if (!isImageModelAllowedForPlan(settingsState.defaultImageModel || '', entitlements.planTier)) {
            nextSettings.defaultImageModel = entitlements.defaultImageModelId;
            changed = true;
        }
        if (!entitlements.allowedTextModelIds.includes(requestedTextModel)) {
            nextSettings.defaultTextModel = entitlements.defaultTextModelId;
            nextSettings.defaultTextModelKey = entitlements.defaultTextModelId;
            changed = true;
        }

        if (changed) {
            setSettingsState(nextSettings);
            persistSettingsState(nextSettings);
        }
    }, [billingSummary, settingsState]);

    // Latest callback without making it an effect dependency — App may re-render for any
    // reason, and re-running the profile loader used to blank the whole settings page and
    // wipe in-progress form edits every time.
    const onDobCompletionStatusChangeRef = useRef(onDobCompletionStatusChange);
    onDobCompletionStatusChangeRef.current = onDobCompletionStatusChange;

    useEffect(() => {
        if (!user?.id) return;

        let active = true;
        const loadProfiles = async () => {
            setLoading(true);
            setPrivateProfileWarning(null);

            let publicProfile: UserProfile | null = null;
            let privateData: UserPrivateProfile | null = null;
            let privateLoadFailed = false;

            try {
                publicProfile = await getUserProfile(user.id);
            } catch (err) {
                console.error('Failed to load public profile', err);
            }

            try {
                privateData = await getPrivateProfile(user.id);
            } catch (err) {
                privateLoadFailed = true;
                console.warn('Failed to load private profile', err);
                if (active) {
                    setPrivateProfileWarning('Private profile data is unavailable right now. Public profile editing still works.');
                }
            }

            if (!active) return;

            setProfile(publicProfile);
            setPrivateProfile(privateData);

            setUsername(publicProfile?.username || '');
            setAvatarUrl(normalizeText(publicProfile?.avatar_url));

            setFirstName(privateData?.first_name || '');
            setLastName(privateData?.last_name || '');
            setPhoneNumber(privateData?.phone_number || '');
            setDob(privateData?.dob || '');

            setEmailPrefProductUpdates(privateData?.email_pref_product_updates ?? true);
            setEmailPrefMarketing(privateData?.email_pref_marketing ?? Boolean(publicProfile?.marketing_consent));
            // Only report DOB status from a SUCCESSFUL fetch — reporting "incomplete" on a
            // transient failure would re-arm App's settings-redirect nag for users whose
            // DOB is actually saved (mirrors the same guard in App's own check).
            if (!privateLoadFailed) {
                onDobCompletionStatusChangeRef.current?.(!privateData?.dob);
            }
            setLoading(false);
        };

        void loadProfiles();
        return () => {
            active = false;
        };
    }, [user?.id]);

    const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onloadend = async () => {
            try {
                const path = await saveImage(reader.result as string);
                const { data } = supabase.storage.from('comic-assets').getPublicUrl(path);
                setAvatarUrl(normalizeText(data.publicUrl));
            } catch (err) {
                alert("Upload failed");
            }
        };
        reader.readAsDataURL(file);
    };

    const validateDob = (value: string) => {
        if (!value) return;
        const parsed = new Date(`${value}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) {
            throw new Error("Date of birth must be valid.");
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (parsed > today) {
            throw new Error("Date of birth cannot be in the future.");
        }
    };

    const handleSaveProfile = async () => {
        if (!user) return;
        setProfileMessage(null);
        setIsSavingProfile(true);
        try {
            const normalizedUsername = normalizeText(username);
            const normalizedFirstName = normalizeText(firstName);
            const normalizedLastName = normalizeText(lastName);
            const normalizedPhone = normalizeText(phoneNumber);
            const normalizedAvatar = normalizeText(avatarUrl);
            const normalizedDob = normalizeText(dob);

            if (!normalizedUsername) throw new Error("Username is required.");
            if (!USERNAME_REGEX.test(normalizedUsername)) {
                throw new Error("Username must be 3-20 chars and use only letters, numbers, or underscore.");
            }
            if (!normalizedFirstName) throw new Error("First name is required.");

            const mustProvideDob = requireDobCompletion || !privateProfile?.dob;
            if (mustProvideDob && !normalizedDob) throw new Error("Date of birth is required.");
            validateDob(normalizedDob);

            await updateUserProfile(user.id, {
                username: normalizedUsername,
                avatar_url: normalizedAvatar
            });
            await upsertPrivateProfile(user.id, {
                first_name: normalizedFirstName,
                last_name: normalizedLastName || null,
                phone_number: normalizedPhone || null,
                dob: normalizedDob || null,
                email_pref_product_updates: emailPrefProductUpdates,
                email_pref_marketing: emailPrefMarketing
            });
            await syncMarketingConsentLegacy(user.id, emailPrefMarketing);

            setProfile(prev => prev ? {
                ...prev,
                username: normalizedUsername,
                avatar_url: normalizedAvatar,
                marketing_consent: emailPrefMarketing
            } : prev);
            setPrivateProfile(prev => ({
                id: user.id,
                created_at: prev?.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString(),
                first_name: normalizedFirstName,
                last_name: normalizedLastName || null,
                phone_number: normalizedPhone || null,
                dob: normalizedDob || null,
                email_pref_product_updates: emailPrefProductUpdates,
                email_pref_marketing: emailPrefMarketing
            }));

            onDobCompletionStatusChange?.(!normalizedDob);
            setProfileMessage({ type: 'success', text: 'Profile updated successfully.' });
        } catch (err: any) {
            setProfileMessage({ type: 'error', text: err?.message || 'Failed to update profile.' });
        } finally {
            setIsSavingProfile(false);
        }
    };

    const handleSavePreferences = async () => {
        if (!user) return;
        setPreferencesMessage(null);
        setIsSavingPreferences(true);

        try {
            await upsertPrivateProfile(user.id, {
                email_pref_product_updates: emailPrefProductUpdates,
                email_pref_marketing: emailPrefMarketing
            });
            await syncMarketingConsentLegacy(user.id, emailPrefMarketing);

            setProfile(prev => prev ? { ...prev, marketing_consent: emailPrefMarketing } : prev);
            setPrivateProfile(prev => ({
                id: user.id,
                created_at: prev?.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString(),
                first_name: prev?.first_name || null,
                last_name: prev?.last_name || null,
                phone_number: prev?.phone_number || null,
                dob: prev?.dob || null,
                email_pref_product_updates: emailPrefProductUpdates,
                email_pref_marketing: emailPrefMarketing
            }));

            setPreferencesMessage({ type: 'success', text: 'Email preferences saved.' });
        } catch (err: any) {
            setPreferencesMessage({ type: 'error', text: err?.message || 'Failed to save preferences.' });
        } finally {
            setIsSavingPreferences(false);
        }
    };

    const handleResendVerification = async () => {
        setSecurityMessage(null);
        setSecurityBusy(true);
        try {
            const result = await resendVerificationEmail();
            setSecurityMessage({ type: result.success ? 'success' : 'error', text: result.message });
        } finally {
            setSecurityBusy(false);
        }
    };

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setSecurityMessage(null);

        const candidate = normalizeText(newPassword);
        if (candidate.length < 8) {
            setSecurityMessage({ type: 'error', text: 'Password must be at least 8 characters.' });
            return;
        }
        if (!/[A-Za-z]/.test(candidate) || !/[0-9]/.test(candidate)) {
            setSecurityMessage({ type: 'error', text: 'Password must include letters and numbers.' });
            return;
        }
        if (candidate !== normalizeText(confirmNewPassword)) {
            setSecurityMessage({ type: 'error', text: 'Passwords do not match.' });
            return;
        }

        setSecurityBusy(true);
        try {
            const result = await changePassword(candidate);
            setSecurityMessage({ type: result.success ? 'success' : 'error', text: result.message });
            if (result.success) {
                setNewPassword('');
                setConfirmNewPassword('');
            }
        } finally {
            setSecurityBusy(false);
        }
    };

    const handleSignOutAll = async () => {
        if (!window.confirm('Sign out from ALL devices including this one? You will be logged out immediately.')) return;
        setSessionBusy(true);
        try {
            await signOutAll();
            onSignedOut?.();
        } catch (err: any) {
            setSessionActionMsg({ type: 'error', text: err?.message || 'Sign out failed.' });
        } finally {
            setSessionBusy(false);
        }
    };

    const handleSignOutOthers = async () => {
        if (!window.confirm('Sign out all other devices? You will stay logged in on this device.')) return;
        setSessionBusy(true);
        setSessionActionMsg(null);
        try {
            const result = await signOutOthers();
            setSessionActionMsg({ type: result.success ? 'success' : 'error', text: result.message });
            if (result.success) void loadDevices();
        } catch (err: any) {
            setSessionActionMsg({ type: 'error', text: err?.message || 'Sign out failed.' });
        } finally {
            setSessionBusy(false);
        }
    };

    const loadDevices = async () => {
        setDevicesLoading(true);
        setDevicesError(null);
        try {
            const list = await listDevices();
            setDevices(list);
        } catch (err: any) {
            setDevicesError(err?.message || 'Could not load devices.');
        } finally {
            setDevicesLoading(false);
        }
    };

    const handleRemoveDevice = async (id: string) => {
        await removeDevice(id);
        setDevices((prev) => prev.filter((d) => d.id !== id));
    };

    const renderMessage = (message: MessageState) => {
        if (!message) return null;
        const tone = message.type === 'success'
            ? 'border-green-500 bg-green-50 text-green-700'
            : 'border-red-500 bg-red-50 text-red-700';
        const icon = message.type === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />;
        return (
            <div className={`border-2 rounded-lg px-3 py-2 text-sm font-semibold flex items-center gap-2 ${tone}`}>
                {icon} {message.text}
            </div>
        );
    };

    const renderProfile = () => (
        <div className="space-y-8 animate-fade-in max-w-2xl">
            {requireDobCompletion && (
                <div className="border-2 border-amber-500 bg-amber-50 text-amber-800 rounded-xl px-4 py-3 text-sm font-semibold">
                    Please add your date of birth to complete your account profile.
                </div>
            )}
            {privateProfileWarning && (
                <div className="border-2 border-amber-500 bg-amber-50 text-amber-800 rounded-xl px-4 py-3 text-sm font-semibold flex items-start gap-2">
                    <AlertTriangle size={16} className="mt-0.5" /> {privateProfileWarning}
                </div>
            )}
            {renderMessage(profileMessage)}

            <div className="flex items-start gap-8">
                <div className="relative group">
                    <div
                        className="w-32 h-32 rounded-full border-4 border-black overflow-hidden bg-slate-200 cursor-pointer"
                        onClick={() => avatarUrl && setPreviewAvatar(avatarUrl)}
                    >
                        {avatarUrl ? (
                            <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-400">
                                <UserIcon size={48} />
                            </div>
                        )}
                    </div>
                    <label className="absolute bottom-0 right-0 bg-brand-yellow border-2 border-black p-2 rounded-full cursor-pointer hover:bg-yellow-300 shadow-comic transition-transform hover:scale-105 z-10">
                        <Upload size={16} />
                        <input type="file" className="hidden" accept="image/*" onChange={handleAvatarUpload} />
                    </label>
                </div>

                <div className="flex-1 space-y-4">
                    <div>
                        <label className="font-display text-lg">Username *</label>
                        <input
                            type="text"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            className="w-full mt-1 border-2 border-black rounded-xl px-4 py-2 font-mono"
                            placeholder="Super_hero"
                        />
                        <p className="text-xs text-slate-500 mt-1">3-20 chars, letters/numbers/underscore only.</p>
                    </div>
                    <div>
                        <label className="font-display text-lg">Email</label>
                        <input
                            type="text"
                            value={user?.email || ''}
                            disabled
                            className="w-full mt-1 border-2 border-black rounded-xl px-4 py-2 font-mono bg-slate-100 text-slate-500 cursor-not-allowed"
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="font-display text-lg">First Name *</label>
                            <input
                                type="text"
                                value={firstName}
                                onChange={(e) => setFirstName(e.target.value)}
                                className="w-full mt-1 border-2 border-black rounded-xl px-4 py-2 font-mono"
                                placeholder="Super"
                            />
                        </div>
                        <div>
                            <label className="font-display text-lg">Last Name</label>
                            <input
                                type="text"
                                value={lastName}
                                onChange={(e) => setLastName(e.target.value)}
                                className="w-full mt-1 border-2 border-black rounded-xl px-4 py-2 font-mono"
                                placeholder="Hero"
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="font-display text-lg">Phone Number</label>
                            <input
                                type="tel"
                                value={phoneNumber}
                                onChange={(e) => setPhoneNumber(e.target.value)}
                                className="w-full mt-1 border-2 border-black rounded-xl px-4 py-2 font-mono"
                                placeholder="+1 555 123 4567"
                            />
                        </div>
                        <div>
                            <label className="font-display text-lg">Date of Birth {requireDobCompletion ? '*' : ''}</label>
                            <input
                                type="date"
                                value={dob}
                                onChange={(e) => setDob(e.target.value)}
                                max={new Date().toISOString().slice(0, 10)}
                                required={requireDobCompletion}
                                className={`w-full mt-1 border-2 rounded-xl px-4 py-2 font-mono ${requireDobCompletion && !dob ? 'bg-amber-50 border-amber-500' : 'border-black'}`}
                            />
                        </div>
                    </div>
                </div>
            </div>

            <div className="pt-8 border-t-2 border-slate-200">
                <Button onClick={handleSaveProfile} disabled={isSavingProfile} icon={<Save size={18} />}>
                    {isSavingProfile ? "Saving..." : "Save Changes"}
                </Button>
            </div>

            <div className="border-2 border-black rounded-xl bg-white">
                <div className="px-4 py-3 font-display text-lg border-b-2 border-black">Invite Friends</div>
                <InviteFriends />
            </div>
        </div>
    );

    const renderPreferences = () => (
        <div className="space-y-6 animate-fade-in max-w-2xl">
            {privateProfileWarning && (
                <div className="border-2 border-amber-500 bg-amber-50 text-amber-800 rounded-xl px-4 py-3 text-sm font-semibold flex items-start gap-2">
                    <AlertTriangle size={16} className="mt-0.5" /> {privateProfileWarning}
                </div>
            )}
            {renderMessage(preferencesMessage)}

            <div className="border-2 border-black rounded-xl p-5 space-y-4">
                <h3 className="font-display text-2xl">Generation Cost</h3>
                <p className="text-sm text-slate-600">
                    When Free-Only mode is on, generation will never silently fall back to a paid model. If no genuinely-free
                    model can serve a step, that step is blocked with a clear message — your provider key is never charged
                    behind your back. <strong>Note:</strong> "$0 per image" models that bill per token (like Gemini "Nano
                    Banana") are NOT considered free.
                </p>
                <label className="flex items-start gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={freeOnly}
                        onChange={(e) => setFreeOnly(e.target.checked)}
                        className="mt-1 accent-black"
                    />
                    <div>
                        <p className="font-bold">Free-Only Mode {freeOnly && <span className="ml-2 text-xs uppercase bg-green-500 text-white px-2 py-0.5 rounded">On</span>}</p>
                        <p className="text-sm text-slate-500">On by default — "free" means free. Blocks (with an explanation) instead of silently using a paid model. Turn this off to opt into paid fallback. Text uses :free models; images route to NVIDIA's free image tier when an nvapi- key is configured.</p>
                    </div>
                </label>
            </div>

            <div className="border-2 border-black rounded-xl p-5 space-y-4">
                <h3 className="font-display text-2xl">Email Preferences</h3>
                <p className="text-sm text-slate-600">Control product and marketing communication from DreamStream.</p>

                <label className="flex items-start gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={emailPrefProductUpdates}
                        onChange={(e) => setEmailPrefProductUpdates(e.target.checked)}
                        className="mt-1 accent-black"
                    />
                    <div>
                        <p className="font-bold">Product Updates</p>
                        <p className="text-sm text-slate-500">Release notes, feature updates, and product education.</p>
                    </div>
                </label>

                <label className="flex items-start gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={emailPrefMarketing}
                        onChange={(e) => setEmailPrefMarketing(e.target.checked)}
                        className="mt-1 accent-black"
                    />
                    <div>
                        <p className="font-bold">Marketing Promotions</p>
                        <p className="text-sm text-slate-500">Promotional campaigns, offers, and announcements.</p>
                    </div>
                </label>

                <div className="border-2 border-slate-200 bg-slate-50 rounded-lg p-3 text-sm text-slate-600">
                    <p className="font-bold text-slate-800">Security Emails</p>
                    <p>Always enabled for account safety (verification, recovery, and critical account activity).</p>
                </div>
            </div>

            <Button onClick={handleSavePreferences} disabled={isSavingPreferences} icon={<Save size={16} />}>
                {isSavingPreferences ? 'Saving...' : 'Save Preferences'}
            </Button>
        </div>
    );

    const renderSecurity = () => {
        const isVerified = Boolean(user?.email_confirmed_at);
        const thisDeviceId = currentDeviceId();

        // Load devices when this tab first renders
        if (activeTab === 'security' && !devicesLoading && devices.length === 0 && !devicesError) {
            void loadDevices();
        }

        const formatLastSeen = (iso: string) => {
            const d = new Date(iso);
            const now = Date.now();
            const diffMs = now - d.getTime();
            const mins = Math.floor(diffMs / 60000);
            if (mins < 2) return 'Just now';
            if (mins < 60) return `${mins}m ago`;
            const hrs = Math.floor(mins / 60);
            if (hrs < 24) return `${hrs}h ago`;
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        };

        return (
            <div className="space-y-6 animate-fade-in max-w-2xl">
                {renderMessage(securityMessage)}

                <div className="border-2 border-black rounded-xl p-5 space-y-4">
                    <h3 className="font-display text-2xl">Email Verification</h3>
                    <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm font-bold ${isVerified ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                        {isVerified ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                        {isVerified ? 'Verified' : 'Unverified'}
                    </div>
                    {!isVerified && (
                        <Button onClick={handleResendVerification} disabled={securityBusy} icon={<Mail size={16} />}>
                            {securityBusy ? 'Sending...' : 'Resend Verification Email'}
                        </Button>
                    )}
                </div>

                <div className="border-2 border-black rounded-xl p-5 space-y-4">
                    <h3 className="font-display text-2xl">Change Password</h3>
                    <form onSubmit={handleChangePassword} className="space-y-4">
                        <div>
                            <label className="font-bold text-xs uppercase">New Password</label>
                            <input
                                type="password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                className="w-full mt-1 border-2 border-black rounded-lg px-4 py-2 font-mono"
                                placeholder="At least 8 characters"
                                required
                            />
                        </div>
                        <div>
                            <label className="font-bold text-xs uppercase">Confirm Password</label>
                            <input
                                type="password"
                                value={confirmNewPassword}
                                onChange={(e) => setConfirmNewPassword(e.target.value)}
                                className="w-full mt-1 border-2 border-black rounded-lg px-4 py-2 font-mono"
                                placeholder="Re-enter password"
                                required
                            />
                        </div>
                        <Button type="submit" disabled={securityBusy} icon={<Shield size={16} />}>
                            {securityBusy ? 'Updating...' : 'Update Password'}
                        </Button>
                    </form>
                </div>

                {/* Device / Session list */}
                <div className="border-2 border-black rounded-xl p-5 space-y-4">
                    <div className="flex items-center justify-between">
                        <h3 className="font-display text-2xl flex items-center gap-2">
                            <Monitor size={20} /> Active Devices
                        </h3>
                        <button onClick={() => void loadDevices()} disabled={devicesLoading} className="text-xs font-bold text-brand-blue hover:underline disabled:opacity-40">
                            {devicesLoading ? 'Loading…' : 'Refresh'}
                        </button>
                    </div>
                    <p className="text-xs text-slate-500">Every browser or device that has signed into your account.</p>

                    {devicesError && (
                        <div className="text-sm text-red-600 font-semibold border-2 border-red-300 bg-red-50 rounded-lg px-3 py-2">
                            {devicesError}
                        </div>
                    )}

                    {devicesLoading && (
                        <div className="text-sm text-slate-500 font-mono animate-pulse">Loading devices…</div>
                    )}

                    {!devicesLoading && devices.length === 0 && !devicesError && (
                        <div className="text-sm text-slate-400 font-mono">No devices recorded yet — they appear here after signing in.</div>
                    )}

                    <div className="space-y-2">
                        {devices.map((device) => {
                            const isCurrent = device.device_id === thisDeviceId;
                            return (
                                <div key={device.id} className={`flex items-center gap-3 border-2 rounded-xl px-4 py-3 ${isCurrent ? 'border-brand-blue bg-brand-blue/5' : 'border-black bg-white'}`}>
                                    <Monitor size={18} className={isCurrent ? 'text-brand-blue' : 'text-slate-400'} />
                                    <div className="flex-1 min-w-0">
                                        <div className="font-bold text-sm flex items-center gap-2">
                                            {device.device_name}
                                            {isCurrent && (
                                                <span className="text-[10px] font-bold uppercase bg-brand-blue text-white px-1.5 py-0.5 rounded border border-black">
                                                    This device
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-[11px] text-slate-500 font-mono">
                                            Last seen {formatLastSeen(device.last_seen)} · First seen {new Date(device.created_at).toLocaleDateString()}
                                        </div>
                                    </div>
                                    {!isCurrent && (
                                        <button
                                            onClick={() => void handleRemoveDevice(device.id)}
                                            title="Remove from list"
                                            className="p-1.5 border-2 border-black rounded hover:bg-red-100 text-red-500"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Session Control */}
                <div className="border-2 border-red-400 bg-red-50 rounded-xl p-5 space-y-4">
                    <h3 className="font-display text-2xl text-red-700">Session Control</h3>

                    {sessionActionMsg && (
                        <div className={`border-2 rounded-lg px-3 py-2 text-sm font-semibold flex items-center gap-2 ${sessionActionMsg.type === 'success' ? 'border-green-500 bg-green-50 text-green-700' : 'border-red-500 bg-red-50 text-red-700'}`}>
                            {sessionActionMsg.type === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                            {sessionActionMsg.text}
                        </div>
                    )}

                    <div className="space-y-3">
                        <div className="bg-white border-2 border-red-200 rounded-xl p-4 space-y-2">
                            <p className="font-bold text-sm text-slate-800">Sign out other devices</p>
                            <p className="text-xs text-slate-500">Invalidates all sessions except this one. You stay logged in.</p>
                            <Button
                                onClick={() => void handleSignOutOthers()}
                                disabled={sessionBusy}
                                variant="secondary"
                                icon={<LogOut size={16} />}
                            >
                                {sessionBusy ? 'Working…' : 'Sign Out Other Devices'}
                            </Button>
                        </div>

                        <div className="bg-white border-2 border-red-300 rounded-xl p-4 space-y-2">
                            <p className="font-bold text-sm text-red-700">Sign out everywhere</p>
                            <p className="text-xs text-slate-500">Invalidates ALL sessions including this one. You will be logged out now.</p>
                            <Button
                                onClick={() => void handleSignOutAll()}
                                disabled={sessionBusy}
                                className="bg-red-600 hover:bg-red-700 text-white border-red-800"
                                icon={<LogOut size={16} />}
                            >
                                {sessionBusy ? 'Signing out…' : 'Sign Out Everywhere'}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderAdmin = () => {
        // Gate hard: the console (and its admin API polling) must never mount for users
        // without access — a deep-linked ?tab=admin or stale session memory used to give
        // any signed-in user the console shell with a perpetual 403 error banner.
        if (!isAdmin && !isModerator) {
            return accessChecked ? (
                <div className="border-2 border-dashed border-slate-300 rounded-xl px-6 py-12 text-center">
                    <Shield size={28} className="mx-auto text-slate-300" />
                    <p className="font-display text-xl mt-3">No admin access</p>
                    <p className="text-sm text-slate-500 mt-1">This area is for platform admins and moderators.</p>
                </div>
            ) : (
                <div className="flex items-center justify-center gap-2 py-16 text-slate-500 text-sm font-bold">
                    <span className="w-4 h-4 border-2 border-slate-300 border-t-black rounded-full animate-spin" /> Checking access…
                </div>
            );
        }
        return (
            <AdminConsole
                isAdmin={isAdmin}
                isModerator={isModerator}
                adminAccess={adminAccess}
                onNavigate={onNavigate}
            />
        );
    };

    const renderLegal = () => (
        <div className="space-y-6 animate-fade-in max-w-3xl">
            <div className="bg-white border-2 border-black rounded-xl p-6 h-[400px] overflow-y-auto font-mono text-xs leading-relaxed">
                <h3 className="font-bold text-lg mb-4 underline">Privacy Policy</h3>
                <p><strong>Last Updated: Feb 11, 2026</strong></p>
                <p className="mt-2">DreamStream processes account, project, and operational data to run comic generation and community features.</p>
                <p className="mt-4 font-bold">1. Data We Process</p>
                <p>Account/profile data, consent values, project scripts/prompts/images, artifacts/logs, comments/follows/reviews, token usage ledger events, and support messages.</p>
                <p className="mt-4 font-bold">2. Where Data Is Processed</p>
                <p>Supabase (auth/db/storage), Google Gemini APIs (text/image/vision), Pixazo Flux endpoint (image generation), and Stripe for subscriptions, credit packs, and payment methods.</p>
                <p className="mt-4 font-bold">3. Device Storage</p>
                <p>LocalStorage/IndexedDB may keep key settings, guest projects, test runs/images, reader state, and local notifications.</p>
                <p className="mt-4 font-bold">4. Visibility and Retention</p>
                <p>Projects remain private unless you publish them. We retain operational/security records as needed for legal and service integrity.</p>

                <hr className="my-6 border-slate-200" />

                <h3 className="font-bold text-lg mb-4 underline">Terms of Service</h3>
                <p><strong>Effective Date: Feb 11, 2026</strong></p>
                <p className="mt-4 font-bold">1. Your Responsibilities</p>
                <p>You are responsible for account security, key handling, rights clearance, and lawful use of generated output.</p>
                <p className="mt-4 font-bold">2. Plans and BYOK</p>
                <p>Token-based limits apply by plan tier. If you supply your own provider key, provider-side charges remain your responsibility.</p>
                <p className="mt-4 font-bold">3. Prohibited Use</p>
                <p>No unlawful, abusive, infringing, deceptive, or infrastructure-harmful activity.</p>
                <p className="mt-4 font-bold">4. Enforcement and Availability</p>
                <p>We may remove content or suspend accounts for policy/legal/security reasons. Features and integrations may change over time.</p>
                <p className="mt-4 font-bold">5. Disclaimers</p>
                <p>Service and AI output are provided as-is; outputs are not guaranteed accurate/original and must be reviewed before publication.</p>
            </div>
        </div>
    );

    const renderSettings = () => (
        <div className="space-y-6 max-w-3xl">
            <RedeemInvite />
            <ApiConfiguration />
        </div>
    );

    const navGroups: Array<{ label: string; items: Array<{ id: SettingsTab; label: string; icon: React.ReactNode; show?: boolean }> }> = [
        {
            label: 'Account',
            items: [
                { id: 'profile', label: 'Profile', icon: <UserIcon size={17} /> },
                { id: 'security', label: 'Security', icon: <ShieldCheck size={17} /> },
                { id: 'preferences', label: 'Preferences', icon: <Bell size={17} /> }
            ]
        },
        {
            label: 'Workspace',
            items: [
                { id: 'settings', label: 'API & Models', icon: <KeyRound size={17} /> }
            ]
        },
        {
            label: 'Support',
            items: [
                { id: 'contact', label: 'Contact', icon: <LifeBuoy size={17} /> },
                { id: 'legal', label: 'Legal', icon: <FileText size={17} /> }
            ]
        },
        {
            label: 'Platform',
            items: [
                { id: 'admin', label: 'Admin Console', icon: <Shield size={17} />, show: isAdmin || isModerator }
            ]
        }
    ];

    const tabMeta: Record<SettingsTab, { title: string; description: string }> = {
        profile: { title: 'Profile', description: 'Your public identity and personal details.' },
        security: { title: 'Security', description: 'Verification, password, and signed-in devices.' },
        preferences: { title: 'Preferences', description: 'Generation cost policy and email preferences.' },
        settings: { title: 'API & Models', description: 'Bring-your-own keys, allowed sources, MCP servers, and default models.' },
        contact: { title: 'Contact', description: 'Reach the DreamStream team.' },
        legal: { title: 'Legal', description: 'Privacy policy and terms of service.' },
        admin: { title: 'Admin Console', description: 'Platform operations: users, moderation, email, analytics.' }
    };

    const isFirstLoad = loading && !profile;

    return (
        <div className="min-h-screen bg-slate-50 pb-20">
            <div className="bg-white/95 backdrop-blur border-b-4 border-black sticky top-0 z-30">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <button
                            onClick={onClose}
                            aria-label="Back"
                            className="w-9 h-9 shrink-0 border-2 border-black rounded-lg bg-white hover:bg-brand-yellow transition-colors flex items-center justify-center shadow-comic hover:shadow-comic-hover hover:translate-y-[1px]"
                        >
                            <ChevronLeft size={18} />
                        </button>
                        <div className="min-w-0">
                            <h1 className="font-display text-2xl leading-none">Settings</h1>
                            <p className="text-[11px] text-slate-500 truncate">{tabMeta[activeTab].description}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="hidden sm:flex items-center gap-2 border-2 border-black rounded-full pl-1 pr-3 py-1 bg-white">
                            <div className="w-7 h-7 rounded-full border-2 border-black bg-brand-yellow flex items-center justify-center font-display text-sm overflow-hidden">
                                {avatarUrl
                                    ? <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                                    : (username || user?.email || '?').slice(0, 1).toUpperCase()}
                            </div>
                            <span className="text-xs font-bold max-w-[14rem] truncate">{username || user?.email}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 md:py-8 grid grid-cols-1 md:grid-cols-4 gap-6 md:gap-8">
                <nav className="space-y-5 md:sticky md:top-24 self-start" aria-label="Settings sections">
                    {navGroups.map((group) => {
                        const items = group.items.filter((item) => item.show !== false);
                        if (items.length === 0) return null;
                        return (
                            <div key={group.label}>
                                <div className="px-4 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">{group.label}</div>
                                <div className="space-y-1">
                                    {items.map((item) => {
                                        const active = activeTab === item.id;
                                        return (
                                            <button
                                                key={item.id}
                                                onClick={() => setActiveTab(item.id)}
                                                aria-current={active ? 'page' : undefined}
                                                className={`relative w-full flex items-center gap-3 px-4 py-2.5 rounded-xl font-bold text-sm transition-colors ${active ? 'text-white' : 'text-slate-500 hover:text-black hover:bg-slate-200/70'}`}
                                            >
                                                {active && (
                                                    <motion.span
                                                        layoutId="settings-nav-pill"
                                                        className="absolute inset-0 rounded-xl bg-black shadow-comic"
                                                        transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                                                    />
                                                )}
                                                <span className="relative z-10 flex items-center gap-3">{item.icon} {item.label}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}

                    <div className="pt-2 border-t-2 border-slate-200">
                        <button
                            onClick={async () => {
                                await signOut();
                                onSignedOut?.();
                            }}
                            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl font-bold text-sm text-red-600 hover:bg-red-50 transition-colors"
                        >
                            <LogOut size={17} /> Sign Out
                        </button>
                    </div>
                </nav>

                <div className="md:col-span-3 bg-white border-4 border-black rounded-2xl p-5 md:p-8 shadow-comic min-h-[600px]">
                    {isFirstLoad ? (
                        <div className="space-y-4 animate-pulse" aria-label="Loading settings">
                            <div className="h-8 w-48 bg-slate-200 rounded-lg" />
                            <div className="h-4 w-72 bg-slate-100 rounded" />
                            <div className="h-40 bg-slate-100 rounded-2xl" />
                            <div className="h-24 bg-slate-100 rounded-2xl" />
                        </div>
                    ) : (
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={activeTab}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -8 }}
                                transition={{ duration: 0.18, ease: 'easeOut' }}
                            >
                                <h2 className="font-display text-3xl mb-6">{tabMeta[activeTab].title}</h2>
                                {activeTab === 'profile' && renderProfile()}
                                {activeTab === 'settings' && renderSettings()}
                                {activeTab === 'preferences' && renderPreferences()}
                                {activeTab === 'security' && renderSecurity()}
                                {activeTab === 'legal' && renderLegal()}
                                {activeTab === 'contact' && <ContactSection />}
                                {activeTab === 'admin' && renderAdmin()}
                            </motion.div>
                        </AnimatePresence>
                    )}
                </div>
            </div>

            {previewAvatar && (
                <div className="fixed inset-0 z-[250] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setPreviewAvatar(null)}>
                    <div className="bg-white p-2 rounded-2xl border-4 border-black shadow-2xl max-w-lg w-full relative">
                        <button
                            onClick={() => setPreviewAvatar(null)}
                            className="absolute -top-4 -right-4 bg-red-500 text-white p-2 rounded-full border-2 border-black hover:bg-red-600 transition-colors"
                        >
                            <X size={20} />
                        </button>
                        <img src={previewAvatar} alt="Avatar Full" className="w-full h-auto rounded-xl" />
                    </div>
                </div>
            )}
        </div>
    );
};
