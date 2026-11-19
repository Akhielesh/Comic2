import React, { useEffect, useRef, useState } from 'react';
import { UserPrivateProfile, UserProfile } from '../types';
import { supabase } from '../services/supabase';
import {
    getPrivateProfile,
    getUserProfile,
    saveAvatarImage,
    savePublicContactMessage,
    syncMarketingConsentLegacy,
    updateUserProfile,
    upsertPrivateProfile
} from '../services/db';
import { getSettingsState, setSettingsState as persistSettingsState } from '../services/appSettings';
import { cn } from '../lib/utils';
import { Button, Checkbox, FIELD_LABEL, IconButton, Input, Skeleton, Textarea, buttonClasses, useReducedMotion, useScrolledPast } from './ds';
import {
    ACCENT_SOFT_BG,
    DENSITY,
    FADE_IN,
    FIELD,
    FOCUS_RING,
    HEADER_GLASS,
    HEADING,
    MUTED,
    OVERLAY,
    OVERLINE,
    RADIUS_CONTROL,
    RADIUS_PANEL,
    RADIUS_ROUND,
    RISE_IN,
    SCRIM,
    SECTION_CARD,
    SECTION_TITLE,
    SHADOW_SOFT,
    STATUS_CHIP,
    STATUS_CHIP_TONE,
    STATUS_EDGE,
    STATUS_INK,
    STATUS_SURFACE,
    STICKY_HEADER,
    TEXT_2XL,
    TEXT_XL,
    TONE_TEXT,
    WRAP_TEXT,
    Z
} from './chat/studioDesign';
import { SUPPORT_EMAIL } from './legal/contacts';
import { ApiConfiguration } from './ApiConfiguration';
import { motion } from 'framer-motion';
import { AlertTriangle, Bell, Loader2, CheckCircle2, ChevronLeft, FileText, KeyRound, LifeBuoy, LogOut, Mail, Monitor, Save, Shield, ShieldCheck, Trash2, Upload, User as UserIcon, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { patchUrlParams, persistUiState, resolveInitialUiState } from '../services/viewState';
import { listDevices, removeDevice, currentDeviceId, type UserDevice } from '../services/deviceSessions';
import { isImageModelAllowedForPlan } from '../services/imageModels';
import { TEXT_MODEL } from '../services/modelPolicy';
import type { BillingSummaryResponse } from '../shared/types/billing';
import { getBillingSummary } from '../services/billing';
import { useAdminAccess } from './account/useAdminAccess';
import { buildModelEntitlements } from '../services/modelEntitlements';
import { isFreeOnly, setFreeOnly, onFreeOnlyChanged } from '../services/freeOnlyMode';
import { AdminConsole } from './admin/AdminConsole';
import { isSettingsTab, type SettingsTab } from './settingsTabs';
import { InviteFriends } from './InviteFriends';
import { RedeemInvite } from './RedeemInvite';
import { StudiosAccess } from './account/StudiosAccess';
import { AppearanceSegmented } from './account/AppearanceControl';
import { rememberProfileRow } from './account/AccountContext';
import { isComicsHost } from '../services/productHost';
import { NAME_MAX, cleanName, updateAccountName } from '../services/accountName';

/** Security and session buttons sit in narrow cards: their labels wrap onto a second line instead of being cut. */
const WRAP_BUTTON = 'h-auto min-h-9 whitespace-normal py-2 text-left';
const WRAP_LABEL = 'min-w-0 whitespace-normal';
import { fetchAccountAccess } from '../services/studioAccessApi';
import { resolveName, splitName } from '../shared/accountName';

// The photo button fills a round overflow-hidden frame, so the shared ring (drawn 2 px outside the element) would be
// clipped away entirely. This one is drawn 4 px inside the button, where the frame cannot clip it.
const AVATAR_FOCUS_RING = FOCUS_RING.replace('focus-visible:outline-offset-2', 'focus-visible:outline-offset-[-4px]');

// The Atlas settings language: opaque section cards (SECTION_CARD), body-face semibold titles, labelled fields on the
// FIELD recipe, and status in the one vocabulary (STATUS_*), always with its icon and its words.
const CARD = cn(SECTION_CARD, 'space-y-4 p-5');
const CARD_HEADING = SECTION_TITLE;
const LABEL = cn('block', FIELD_LABEL);
const HINT = cn('mt-1 text-[length:var(--ds-text-sm)]', MUTED, WRAP_TEXT);
const NOTE = cn('flex items-start gap-2 border px-3 py-2 text-[length:var(--ds-text-base)]', RADIUS_CONTROL, WRAP_TEXT);
/** A plain text button (Send another, Refresh): ink, underlined, 44 px under a coarse pointer, the focus ring. */
const TEXT_BUTTON = cn('inline-flex items-center px-1 text-[length:var(--ds-text-base)] font-medium text-[var(--ds-ink)] underline underline-offset-2 disabled:opacity-50', RADIUS_CONTROL, DENSITY.coarse, FOCUS_RING);

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
            <div className={cn('flex flex-col items-center justify-center py-20 text-center', FADE_IN)}>
                <div className={cn('mb-4 grid size-16 place-items-center rounded-full border', STATUS_SURFACE.healthy, STATUS_INK.healthy)}>
                    <Mail size={28} aria-hidden="true" />
                </div>
                <h3 className={cn(TEXT_XL, 'font-semibold text-[var(--ds-ink)]')}>Message Sent!</h3>
                <p className={cn('mt-2', MUTED)}>A representative will be in touch shortly.</p>
                <button onClick={() => setSent(false)} className={cn('mt-8', TEXT_BUTTON)}>Send another</button>
            </div>
        );
    }

    return (
        <div className={cn('max-w-xl', FADE_IN)}>
            <h3 className={cn(CARD_HEADING, 'mb-2')}>Contact Support</h3>
            <p className={cn('mb-6', MUTED)}>
                Share bugs, billing issues, or feature requests. We usually reply within 1-2 business days.
            </p>
            <div className={cn('mb-6 border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-4 text-[length:var(--ds-text-base)]', RADIUS_CONTROL)}>
                <p className="mb-1 font-semibold text-[var(--ds-ink)]">Basic Contact Info</p>
                <p className={cn(MUTED, WRAP_TEXT)}>Support Email: <a href={`mailto:${SUPPORT_EMAIL}`} className={cn('text-[var(--ds-ink)] underline underline-offset-2', RADIUS_CONTROL, FOCUS_RING)}>{SUPPORT_EMAIL}</a></p>
                <p className={MUTED}>Business Hours: Mon-Fri, 9:00 AM - 6:00 PM</p>
            </div>
            <form onSubmit={send} className="space-y-4">
                <div>
                    <label htmlFor="contact-email" className={LABEL}>Your Email</label>
                    <Input
                        id="contact-email"
                        type="email"
                        required
                        value={contactEmail}
                        onChange={e => setContactEmail(e.target.value)}
                        className="mt-1.5"
                    />
                </div>
                <div>
                    <label htmlFor="contact-phone" className={LABEL}>Phone Number (Optional)</label>
                    <Input
                        id="contact-phone"
                        type="tel"
                        value={phone}
                        onChange={e => setPhone(e.target.value)}
                        className="mt-1.5"
                    />
                </div>
                <div>
                    <label htmlFor="contact-message" className={LABEL}>Message (300 words max)</label>
                    <Textarea
                        id="contact-message"
                        required
                        rows={6}
                        value={msg}
                        onChange={e => setMsg(e.target.value)}
                        className="mt-1.5 resize-y"
                    />
                    <div className={cn('mt-1 text-right text-[length:var(--ds-text-sm)] tabular-nums', words > 300 ? `font-semibold ${TONE_TEXT.danger}` : MUTED)}>
                        {words}/300 words
                    </div>
                </div>
                {sendError && <div className={cn('flex items-start gap-1.5 text-[length:var(--ds-text-sm)] font-medium', TONE_TEXT.danger, WRAP_TEXT)}><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{sendError}</div>}
                <Button type="submit" disabled={words > 300}><Mail size={16} /> Send Message</Button>
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
    const avatarInputRef = useRef<HTMLInputElement>(null);
    const [loading, setLoading] = useState(true);
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [privateProfile, setPrivateProfile] = useState<UserPrivateProfile | null>(null);
    const [privateProfileWarning, setPrivateProfileWarning] = useState<string | null>(null);

    // Admin / moderator come only from the server's admin flag (/api/admin/me); a failed check
    // means no access. `accessChecked`: whether the probe has settled (success OR failure). The
    // admin tab renders a "checking access" state until then, so the console never mounts with a
    // not-yet-true isAdmin and silently downgrades a deep-linked admin-only section.
    const { isAdmin, isModerator, access: adminAccess, checked: accessChecked } = useAdminAccess(user?.id);
    const [settingsState, setSettingsState] = useState(() => getSettingsState());
    // Billing summary is only fetched to derive model entitlements (default text/image
    // models) for the API & Models tab — there is no plan/billing UI anymore.
    const [billingSummary, setBillingSummary] = useState<BillingSummaryResponse | null>(null);

    const [username, setUsername] = useState('');
    const [avatarUrl, setAvatarUrl] = useState('');
    // One display name for every studio (saved through the server — services/accountName.ts).
    const [displayName, setDisplayName] = useState('');
    const [savedName, setSavedName] = useState('');
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
            // The account menu shows the handle and photo it remembered; this read is the fresher one.
            if (publicProfile) rememberProfileRow(user.id, publicProfile);

            // First + last for now; the account's one name (what every studio shows) replaces it below.
            const localName = resolveName({ first: privateData?.first_name, last: privateData?.last_name }) || '';
            setDisplayName(localName);
            setSavedName(localName);
            void fetchAccountAccess().then((access) => {
                const name = access?.account.name;
                if (!active || !name) return;
                setSavedName(name);
                setDisplayName((current) => (current === localName ? name : current));
            });
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
        // Picking the same file again must fire onChange again (a retry after a failed upload).
        e.target.value = '';
        const reader = new FileReader();
        reader.onloadend = async () => {
            try {
                const path = await saveAvatarImage(reader.result as string);
                const { data } = supabase.storage.from('comic-assets').getPublicUrl(path);
                setAvatarUrl(normalizeText(data.publicUrl));
            } catch (err) {
                const reason = err instanceof Error && err.message ? ` ${err.message}` : '';
                alert(`Upload failed.${reason}`);
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
            const name = cleanName(displayName);
            const normalizedPhone = normalizeText(phoneNumber);
            const normalizedAvatar = normalizeText(avatarUrl);
            const normalizedDob = normalizeText(dob);

            if (!normalizedUsername) throw new Error("Username is required.");
            if (!USERNAME_REGEX.test(normalizedUsername)) {
                throw new Error("Username must be 3-20 chars and use only letters, numbers, or underscore.");
            }
            if (!name) throw new Error("Name is required.");

            const mustProvideDob = requireDobCompletion || !privateProfile?.dob;
            if (mustProvideDob && !normalizedDob) throw new Error("Date of birth is required.");
            validateDob(normalizedDob);

            await updateUserProfile(user.id, {
                username: normalizedUsername,
                avatar_url: normalizedAvatar
            });
            // Saved: the account menu shows the new handle and photo at once, not after a reload.
            rememberProfileRow(user.id, { username: normalizedUsername, avatar_url: normalizedAvatar });
            // The name is saved separately below (it lives in more than one place).
            await upsertPrivateProfile(user.id, {
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
                first_name: prev?.first_name || null,
                last_name: prev?.last_name || null,
                phone_number: normalizedPhone || null,
                dob: normalizedDob || null,
                email_pref_product_updates: emailPrefProductUpdates,
                email_pref_marketing: emailPrefMarketing
            }));
            onDobCompletionStatusChange?.(!normalizedDob);

            if (name !== savedName) {
                const saved = await updateAccountName(name);
                if (!saved.ok) {
                    setProfileMessage({ type: 'error', text: `Everything else was saved, but not your name: ${saved.error}` });
                    return;
                }
                const finalName = saved.name || name;
                const { first, last } = splitName(finalName);
                setSavedName(finalName);
                setDisplayName(finalName);
                setPrivateProfile(prev => (prev ? { ...prev, first_name: first, last_name: last } : prev));
            } else {
                setDisplayName(name);
            }
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
        const state = message.type === 'success' ? 'healthy' : 'error';
        const icon = message.type === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />;
        return (
            <div className={cn(NOTE, 'font-medium', STATUS_SURFACE[state], STATUS_INK[state])}>
                {icon} {message.text}
            </div>
        );
    };

    // The sign-in email cannot be edited here, so it is read-only text (role=textbox, aria-readonly), not a disabled
    // input: an input cannot wrap (an ordinary 30-character address was cut on phones) and a disabled one cannot be
    // focused, scrolled or selected, so the hidden part could not be reached at all.
    const renderProfile = () => (
        <div className={cn('max-w-2xl space-y-8', FADE_IN)}>
            {requireDobCompletion && (
                <div className={cn(NOTE, 'font-medium', STATUS_SURFACE.attention, TONE_TEXT.warning)}>
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> Please add your date of birth to complete your account profile.
                </div>
            )}
            {privateProfileWarning && (
                <div className={cn(NOTE, 'font-medium', STATUS_SURFACE.attention, TONE_TEXT.warning)}>
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {privateProfileWarning}
                </div>
            )}
            {renderMessage(profileMessage)}

            {/* Phones: the photo sits above the fields, so every field gets the card's full width (an email beside a
                128 px photo was cut at 390 px). From sm the photo and the fields share one row again. */}
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-8">
                <div className="relative group shrink-0">
                    <div className="size-32 overflow-hidden rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)]">
                        {avatarUrl ? (
                            <button
                                type="button"
                                onClick={() => setPreviewAvatar(avatarUrl)}
                                aria-label="View profile photo"
                                className={`block w-full h-full cursor-zoom-in ${AVATAR_FOCUS_RING}`}
                            >
                                <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                            </button>
                        ) : (
                            <div className={cn('flex h-full w-full items-center justify-center', MUTED)}>
                                <UserIcon size={48} />
                            </div>
                        )}
                    </div>
                    {/* A real button opens the hidden file input: a <label> around a display:none input has no name and
                        no keyboard can reach it. */}
                    <button
                        type="button"
                        onClick={() => avatarInputRef.current?.click()}
                        aria-label={avatarUrl ? 'Change profile photo' : 'Upload a profile photo'}
                        title={avatarUrl ? 'Change profile photo' : 'Upload a profile photo'}
                        className={cn(buttonClasses({ variant: 'outline', size: 'icon' }), 'absolute bottom-0 right-0 size-11 shadow-[shadow:var(--ds-shadow-panel)]', RADIUS_ROUND)}
                    >
                        <Upload size={16} aria-hidden />
                    </button>
                    <input ref={avatarInputRef} type="file" className="hidden" tabIndex={-1} aria-hidden accept="image/*" onChange={handleAvatarUpload} />
                </div>

                <div className="w-full min-w-0 flex-1 space-y-4">
                    <div>
                        <label htmlFor="account-username" className={LABEL}>Username *</label>
                        <Input
                            id="account-username"
                            type="text"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            autoComplete="username"
                            aria-describedby="account-username-hint"
                            className="mt-1.5"
                        />
                        <p id="account-username-hint" className={HINT}>3-20 chars, letters/numbers/underscore only.</p>
                    </div>
                    <div>
                        <span id="account-email-label" className={LABEL}>Email</span>
                        <div
                            id="account-email"
                            role="textbox"
                            aria-readonly="true"
                            aria-labelledby="account-email-label"
                            tabIndex={0}
                            className={cn(FIELD, 'mt-1.5 min-h-10 w-full select-text bg-[var(--ds-well)] px-3 py-2 text-base md:text-[length:var(--ds-text-base)]', WRAP_TEXT, FOCUS_RING)}
                        >
                            {user?.email || ''}
                        </div>
                    </div>
                    <div>
                        <label htmlFor="account-display-name" className={LABEL}>Name *</label>
                        <Input
                            id="account-display-name"
                            type="text"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            maxLength={NAME_MAX}
                            autoComplete="name"
                            className="mt-1.5"
                        />
                        <p className={HINT}>
                            Shown in every studio — in Stream Studio, family and nursery members see it too.
                            {username ? ` @${normalizeText(username)}` : ' Your @username'} stays your sign-in and comic handle.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label htmlFor="account-phone" className={LABEL}>Phone Number</label>
                            <Input
                                id="account-phone"
                                type="tel"
                                value={phoneNumber}
                                onChange={(e) => setPhoneNumber(e.target.value)}
                                autoComplete="tel"
                                className="mt-1.5"
                                placeholder="Optional"
                            />
                        </div>
                        <div>
                            <label htmlFor="account-dob" className={LABEL}>Date of Birth {requireDobCompletion ? '*' : ''}</label>
                            <Input
                                id="account-dob"
                                type="date"
                                value={dob}
                                onChange={(e) => setDob(e.target.value)}
                                max={new Date().toISOString().slice(0, 10)}
                                required={requireDobCompletion}
                                className={cn('mt-1.5', requireDobCompletion && !dob && 'border-[var(--ds-warning)] bg-[color:color-mix(in_srgb,var(--ds-warning)_8%,var(--ds-canvas))] hover:border-[var(--ds-warning)]')}
                            />
                        </div>
                    </div>
                </div>
            </div>

            <div className="border-t border-[var(--ds-hairline)] pt-8">
                <Button onClick={handleSaveProfile} disabled={isSavingProfile}>
                    <Save size={16} /> {isSavingProfile ? "Saving..." : "Save Changes"}
                </Button>
            </div>

            <StudiosAccess />

            <div className={SECTION_CARD}>
                <div className="border-b border-[var(--ds-hairline)] px-4 py-3 text-[length:var(--ds-text-lg)] font-semibold leading-6 text-[var(--ds-ink)]">Invite Friends</div>
                <InviteFriends />
            </div>
        </div>
    );

    const renderPreferences = () => (
        <div className={cn('max-w-2xl space-y-6', FADE_IN)}>
            {/* The same choice as the account menu's (navtheme NT-2c); it applies at once, with no Save. */}
            <div className={CARD}>
                <h3 className={CARD_HEADING}>Appearance</h3>
                <p className={cn('text-[length:var(--ds-text-base)]', MUTED)}>
                    {isComicsHost() ? 'Light, Dark, Paper or System (follows your device), for Comic Studio in this browser.' : 'Light, Dark or System (follows your device), in this browser.'}
                </p>
                <AppearanceSegmented paper={isComicsHost()} />
            </div>
            {privateProfileWarning && (
                <div className={cn(NOTE, 'font-medium', STATUS_SURFACE.attention, TONE_TEXT.warning)}>
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {privateProfileWarning}
                </div>
            )}
            {renderMessage(preferencesMessage)}

            <div className={CARD}>
                <h3 className={CARD_HEADING}>Generation Cost</h3>
                <p className={cn('text-[length:var(--ds-text-base)]', MUTED)}>
                    When Free-Only mode is on, generation will never silently fall back to a paid model. If no genuinely-free
                    model can serve a step, that step is blocked with a clear message — your provider key is never charged
                    behind your back. <strong>Note:</strong> image models listed as free per image that bill per token (like
                    Gemini "Nano Banana") are NOT considered free.
                </p>
                <Checkbox
                    checked={freeOnly}
                    onChange={(e) => setFreeOnly(e.target.checked)}
                    label={<span className="font-semibold">Free-Only Mode {freeOnly && <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE.healthy, 'ml-2 align-middle')}>On</span>}</span>}
                    description={<>On by default — "free" means free. Blocks (with an explanation) instead of silently using a paid model. Turn this off to opt into paid fallback. Text uses :free models; images route to NVIDIA's free image tier when an nvapi- key is configured.</>}
                />
            </div>

            <div className={CARD}>
                <h3 className={CARD_HEADING}>Email Preferences</h3>
                <p className={cn('text-[length:var(--ds-text-base)]', MUTED)}>Control product and marketing communication from DreamStream.</p>

                <div className="flex flex-col gap-3">
                    <Checkbox
                        checked={emailPrefProductUpdates}
                        onChange={(e) => setEmailPrefProductUpdates(e.target.checked)}
                        label={<span className="font-semibold">Product Updates</span>}
                        description="Release notes, feature updates, and product education."
                    />
                    <Checkbox
                        checked={emailPrefMarketing}
                        onChange={(e) => setEmailPrefMarketing(e.target.checked)}
                        label={<span className="font-semibold">Marketing Promotions</span>}
                        description="Promotional campaigns, offers, and announcements."
                    />
                </div>

                <div className={cn('border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3 text-[length:var(--ds-text-base)]', RADIUS_CONTROL, MUTED)}>
                    <p className="font-semibold text-[var(--ds-ink)]">Security Emails</p>
                    <p>Always enabled for account safety (verification, recovery, and critical account activity).</p>
                </div>
            </div>

            <Button onClick={handleSavePreferences} disabled={isSavingPreferences}>
                <Save size={16} /> {isSavingPreferences ? 'Saving...' : 'Save Preferences'}
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
            <div className={cn('max-w-2xl space-y-6', FADE_IN)}>
                {renderMessage(securityMessage)}

                <div className={CARD}>
                    <h3 className={CARD_HEADING}>Email Verification</h3>
                    <div className={cn(STATUS_CHIP, STATUS_CHIP_TONE[isVerified ? 'healthy' : 'attention'], 'px-3 py-1 text-[length:var(--ds-text-sm)]')}>
                        {isVerified ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                        {isVerified ? 'Verified' : 'Unverified'}
                    </div>
                    {!isVerified && (
                        <div>
                            <Button onClick={handleResendVerification} disabled={securityBusy} className={WRAP_BUTTON}>
                                <Mail size={16} /> <span className={WRAP_LABEL}>{securityBusy ? 'Sending...' : 'Resend Verification Email'}</span>
                            </Button>
                        </div>
                    )}
                </div>

                <div className={CARD}>
                    <h3 className={CARD_HEADING}>Change Password</h3>
                    <form onSubmit={handleChangePassword} className="space-y-4">
                        <div>
                            <label htmlFor="account-new-password" className={LABEL}>New Password</label>
                            <Input
                                id="account-new-password"
                                type="password"
                                autoComplete="new-password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                className="mt-1.5"
                                placeholder="At least 8 characters"
                                required
                            />
                        </div>
                        <div>
                            <label htmlFor="account-confirm-password" className={LABEL}>Confirm Password</label>
                            <Input
                                id="account-confirm-password"
                                type="password"
                                autoComplete="new-password"
                                value={confirmNewPassword}
                                onChange={(e) => setConfirmNewPassword(e.target.value)}
                                className="mt-1.5"
                                placeholder="Re-enter password"
                                required
                            />
                        </div>
                        <Button type="submit" disabled={securityBusy}>
                            <Shield size={16} /> {securityBusy ? 'Updating...' : 'Update Password'}
                        </Button>
                    </form>
                </div>

                {/* Device / Session list */}
                <div className={CARD}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className={cn(CARD_HEADING, 'flex items-center gap-2')}>
                            <Monitor size={18} aria-hidden="true" /> Active Devices
                        </h3>
                        <Button variant="outline" size="sm" onClick={() => void loadDevices()} disabled={devicesLoading}>
                            {devicesLoading ? 'Loading…' : 'Refresh'}
                        </Button>
                    </div>
                    <p className={cn('text-[length:var(--ds-text-sm)]', MUTED)}>Every browser or device that has signed into your account.</p>

                    {devicesError && (
                        <div className={cn(NOTE, 'font-medium', STATUS_SURFACE.error, STATUS_INK.error)}>
                            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {devicesError}
                        </div>
                    )}

                    {devicesLoading && (
                        <div className={cn('flex items-center gap-2 text-[length:var(--ds-text-base)]', MUTED)}><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> Loading devices…</div>
                    )}

                    {!devicesLoading && devices.length === 0 && !devicesError && (
                        <div className={cn('text-[length:var(--ds-text-base)]', MUTED)}>No devices recorded yet — they appear here after signing in.</div>
                    )}

                    <div className="space-y-2">
                        {devices.map((device) => {
                            const isCurrent = device.device_id === thisDeviceId;
                            return (
                                <div key={device.id} className={cn('flex items-center gap-3 border px-4 py-3', RADIUS_CONTROL, isCurrent ? `${ACCENT_SOFT_BG} border-[color:color-mix(in_srgb,var(--ds-ink)_25%,transparent)]` : 'border-[var(--ds-hairline)] bg-[var(--ds-canvas)]')}>
                                    <Monitor size={18} className={cn('shrink-0', isCurrent ? 'text-[var(--ds-ink)]' : MUTED)} aria-hidden="true" />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--ds-text-base)] font-semibold text-[var(--ds-ink)]">
                                            <span className={WRAP_TEXT}>{device.device_name}</span>
                                            {isCurrent && (
                                                <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE.active)}>
                                                    This device
                                                </span>
                                            )}
                                        </div>
                                        <div className={cn('text-[11px] tabular-nums', MUTED, WRAP_TEXT)}>
                                            Last seen {formatLastSeen(device.last_seen)} · First seen {new Date(device.created_at).toLocaleDateString()}
                                        </div>
                                    </div>
                                    {!isCurrent && (
                                        <IconButton
                                            label="Remove from list"
                                            variant="outline"
                                            onClick={() => void handleRemoveDevice(device.id)}
                                            className={cn('shrink-0', TONE_TEXT.danger)}
                                        >
                                            <Trash2 size={14} />
                                        </IconButton>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Session Control */}
                {/* The one destructive card: a neutral card that borders in the error edge; the danger lives on its
                    words and on the one destructive button. */}
                <div className={cn(CARD, STATUS_EDGE.error)}>
                    <h3 className={cn(CARD_HEADING, 'flex items-center gap-2')}><AlertTriangle size={18} className={cn('shrink-0', STATUS_INK.error)} aria-hidden="true" /> Session Control</h3>

                    {renderMessage(sessionActionMsg)}

                    <div className="space-y-3">
                        <div className={cn('space-y-2 border border-[var(--ds-hairline)] bg-[var(--ds-canvas)] p-4', RADIUS_CONTROL)}>
                            <p className="text-[length:var(--ds-text-base)] font-semibold text-[var(--ds-ink)]">Sign out other devices</p>
                            <p className={cn('text-[length:var(--ds-text-sm)]', MUTED)}>Invalidates all sessions except this one. You stay logged in.</p>
                            <Button
                                onClick={() => void handleSignOutOthers()}
                                disabled={sessionBusy}
                                variant="outline"
                                className={WRAP_BUTTON}
                            >
                                <LogOut size={16} /> <span className={WRAP_LABEL}>{sessionBusy ? 'Working…' : 'Sign Out Other Devices'}</span>
                            </Button>
                        </div>

                        <div className={cn('space-y-2 border bg-[var(--ds-canvas)] p-4', RADIUS_CONTROL, STATUS_EDGE.error)}>
                            <p className={cn('text-[length:var(--ds-text-base)] font-semibold', TONE_TEXT.danger)}>Sign out everywhere</p>
                            <p className={cn('text-[length:var(--ds-text-sm)]', MUTED)}>Invalidates ALL sessions including this one. You will be logged out now.</p>
                            <Button
                                onClick={() => void handleSignOutAll()}
                                disabled={sessionBusy}
                                variant="destructive"
                                className={WRAP_BUTTON}
                            >
                                <LogOut size={16} /> <span className={WRAP_LABEL}>{sessionBusy ? 'Signing out…' : 'Sign Out Everywhere'}</span>
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
                <div className={cn('border border-dashed border-[var(--ds-hairline)] px-6 py-12 text-center', RADIUS_PANEL)}>
                    <Shield size={28} className={cn('mx-auto', MUTED)} aria-hidden="true" />
                    <p className="mt-3 text-[length:var(--ds-text-lg)] font-semibold text-[var(--ds-ink)]">No admin access</p>
                    <p className={cn('mt-1 text-[length:var(--ds-text-base)]', MUTED)}>This area is for platform admins and moderators.</p>
                </div>
            ) : (
                <div className={cn('flex items-center justify-center gap-2 py-16 text-[length:var(--ds-text-base)] font-medium', MUTED)}>
                    <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> Checking access…
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
        <div className={cn('max-w-3xl space-y-6', FADE_IN)}>
            <div className={cn('h-[400px] overflow-y-auto border border-[var(--ds-hairline)] bg-[var(--ds-canvas)] p-6 text-[length:var(--ds-text-sm)] leading-relaxed text-[var(--ds-ink)]', RADIUS_PANEL, WRAP_TEXT)}>
                <h3 className={cn(CARD_HEADING, 'mb-4')}>Privacy Policy</h3>
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

                <hr className="my-6 border-[var(--ds-hairline)]" />

                <h3 className={cn(CARD_HEADING, 'mb-4')}>Terms of Service</h3>
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

    const showAdminChip = isAdmin || isModerator;
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
                { id: 'admin', label: 'Admin Console', icon: <Shield size={17} />, show: showAdminChip }
            ]
        }
    ];

    const tabMeta: Record<SettingsTab, { title: string; description: string }> = {
        profile: { title: 'Profile', description: 'Your public identity and personal details.' },
        security: { title: 'Security', description: 'Verification, password, and signed-in devices.' },
        preferences: { title: 'Preferences', description: 'Appearance, generation cost policy and email.' },
        settings: { title: 'API & Models', description: 'Bring-your-own keys, allowed sources, MCP servers, and default models.' },
        contact: { title: 'Contact', description: 'Reach the DreamStream team.' },
        legal: { title: 'Legal', description: 'Privacy policy and terms of service.' },
        admin: { title: 'Admin Console', description: 'Platform operations: users, moderation, email, analytics.' }
    };

    const isFirstLoad = loading && !profile;
    const reducedMotion = useReducedMotion();
    // The sticky header frosts (HEADER_GLASS) only once the page scrolls under it.
    const headerScrolled = useScrolledPast(4);

    // Phones: the section row scrolls sideways, so bring the current chip into view (a deep link to Legal or
    // Contact, a reload on a later tab). Only the row scrolls, never the page; from md the list is a column.
    const navRowRef = useRef<HTMLElement>(null);
    useEffect(() => {
        const row = navRowRef.current;
        if (!row) return;
        const reveal = () => {
            if (row.scrollWidth <= row.clientWidth) return;
            const chip = row.querySelector<HTMLElement>('[aria-current="page"]');
            if (!chip) return;
            row.scrollLeft = Math.max(0, chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2);
        };
        reveal();
        // The row only scrolls below md: crossing the breakpoint (a rotation, a narrowed window) re-centres it.
        const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 768px)') : null;
        mq?.addEventListener?.('change', reveal);
        return () => mq?.removeEventListener?.('change', reveal);
        // showAdminChip: the Admin chip only appears once admin access resolves after mount, so a deep link to
        // ?tab=admin has no current chip on the first run.
    }, [activeTab, showAdminChip]);

    return (
        <div className="min-h-screen bg-[var(--ds-sidebar)] pb-20 text-[var(--ds-ink)]">
            <div className={STICKY_HEADER} data-scrolled={headerScrolled ? 'true' : 'false'}>
                <div aria-hidden="true" className={HEADER_GLASS} />
                <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <IconButton label="Back" title={null} variant="outline" size="lg" onClick={onClose}>
                            <ChevronLeft size={18} />
                        </IconButton>
                        <div className="min-w-0">
                            <h1 className={cn(HEADING, TEXT_XL, 'leading-tight')}>Settings</h1>
                            <p className={cn('truncate text-[11px]', MUTED)}>{tabMeta[activeTab].description}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <div className={cn('hidden items-center gap-2 border border-[var(--ds-hairline)] bg-[var(--ds-surface)] py-1 pl-1 pr-3 sm:flex', RADIUS_ROUND)}>
                            <div className="flex size-7 items-center justify-center overflow-hidden rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)] text-[length:var(--ds-text-sm)] font-semibold">
                                {avatarUrl
                                    ? <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                                    : (savedName || username || user?.email || '?').slice(0, 1).toUpperCase()}
                            </div>
                            <span className="max-w-[14rem] truncate text-xs font-semibold">{savedName || username || user?.email}</span>
                            {savedName && username && savedName !== username && (
                                <span className={cn('max-w-[8rem] truncate text-[11px]', MUTED)}>@{username}</span>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 md:py-8 grid grid-cols-1 md:grid-cols-4 gap-6 md:gap-8">
                {/* Under md the section list is ONE sideways-scrolling row of chips (group names hidden), so the first
                    setting is on the first screen of a phone instead of below a 600 px list. From md it is the column. */}
                <nav
                    ref={navRowRef}
                    className="relative min-w-0 -mx-4 px-4 sm:-mx-6 sm:px-6 md:mx-0 md:px-0 flex gap-2 overflow-x-auto overscroll-x-contain py-1 md:block md:space-y-5 md:overflow-visible md:py-0 md:sticky md:top-24 self-start"
                    aria-label="Settings sections"
                >
                    {navGroups.map((group) => {
                        const items = group.items.filter((item) => item.show !== false);
                        if (items.length === 0) return null;
                        return (
                            <div key={group.label} className="contents md:block">
                                <div className={cn('hidden px-4 pb-1.5 md:block', OVERLINE)}>{group.label}</div>
                                <div className="contents md:block md:space-y-1">
                                    {items.map((item) => {
                                        const active = activeTab === item.id;
                                        return (
                                            <button
                                                key={item.id}
                                                onClick={() => setActiveTab(item.id)}
                                                aria-current={active ? 'page' : undefined}
                                                className={cn(
                                                    'relative flex min-h-11 shrink-0 items-center gap-3 px-4 py-2.5 text-[length:var(--ds-text-base)] font-medium transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] md:w-full',
                                                    RADIUS_CONTROL,
                                                    FOCUS_RING,
                                                    active ? 'text-[var(--ds-ink)]' : `${MUTED} hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]`
                                                )}
                                            >
                                                {active && (
                                                    <motion.span
                                                        layoutId="settings-nav-pill"
                                                        className={cn('absolute inset-0 border border-[var(--ds-hairline)]', RADIUS_CONTROL, ACCENT_SOFT_BG)}
                                                        transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 38 }}
                                                    />
                                                )}
                                                <span className="relative flex items-center gap-3">{item.icon} {item.label}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}

                    <div className="contents md:block md:pt-2 md:border-t md:border-[var(--ds-hairline)]">
                        <button
                            onClick={async () => {
                                await signOut();
                                onSignedOut?.();
                            }}
                            className={cn('flex min-h-11 shrink-0 items-center gap-3 px-4 py-2.5 text-[length:var(--ds-text-base)] font-medium transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] hover:bg-[var(--ds-hover)] md:w-full', RADIUS_CONTROL, FOCUS_RING, TONE_TEXT.danger)}
                        >
                            <LogOut size={17} /> Sign Out
                        </button>
                    </div>
                </nav>

                <div className={cn('min-w-0 min-h-[600px] border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-5 md:col-span-3 md:p-8', RADIUS_PANEL, SHADOW_SOFT)}>
                    {isFirstLoad ? (
                        <div className="space-y-4" aria-label="Loading settings">
                            <Skeleton className="h-8 w-48 max-w-full" />
                            <Skeleton shape="text" className="w-72 max-w-full" />
                            <Skeleton className="h-40" />
                            <Skeleton className="h-24" />
                        </div>
                    ) : (
                        <>
                            {/* The section rises in on the shared entrance (tokens; still under reduced motion). */}
                            <div key={activeTab} className={RISE_IN}>
                                <h2 className={cn(HEADING, TEXT_2XL, 'mb-6')}>{tabMeta[activeTab].title}</h2>
                                {activeTab === 'profile' && renderProfile()}
                                {activeTab === 'settings' && renderSettings()}
                                {activeTab === 'preferences' && renderPreferences()}
                                {activeTab === 'security' && renderSecurity()}
                                {activeTab === 'legal' && renderLegal()}
                                {activeTab === 'contact' && <ContactSection />}
                                {activeTab === 'admin' && renderAdmin()}
                            </div>
                        </>
                    )}
                </div>
            </div>

            {previewAvatar && (
                <div className={cn('fixed inset-0 flex items-center justify-center p-4', Z.dialog, SCRIM)} onClick={() => setPreviewAvatar(null)}>
                    <div className={cn(OVERLAY, 'relative w-full max-w-lg p-2')}>
                        <IconButton
                            label="Close photo preview"
                            title={null}
                            variant="outline"
                            size="lg"
                            onClick={() => setPreviewAvatar(null)}
                            className={cn('absolute -right-3 -top-3 shadow-[shadow:var(--ds-shadow-overlay)]', RADIUS_ROUND)}
                        >
                            <X size={18} />
                        </IconButton>
                        <img src={previewAvatar} alt="Avatar Full" className={cn('h-auto w-full', RADIUS_CONTROL)} />
                    </div>
                </div>
            )}
        </div>
    );
};
