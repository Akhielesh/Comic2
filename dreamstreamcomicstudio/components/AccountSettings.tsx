import React, { useEffect, useState } from 'react';
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
import { getAllModelKeys, getSettingsState, setSettingsState as persistSettingsState } from '../services/appSettings';
import { Button } from './Button';
import { KeyManager } from './KeyManager';
import { AlertTriangle, CheckCircle2, CreditCard, LogOut, Mail, Save, Settings, Shield, Upload, User as UserIcon, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSearchParams } from 'react-router-dom';
import { IMAGE_MODELS } from '../services/imageModels';
import { TEXT_MODEL, TEXT_MODELS } from '../services/modelPolicy';
import type {
    AdminCouponAssignment,
    AdminCouponDefinition,
    AdminCouponRedemptionEvent,
    BillingInterval,
    BillingPlanDefinition,
    BillingPlanPricing,
    BillingSummaryResponse,
    CreditPackId,
    PurchasablePlanTier
} from '../shared/types/billing';
import {
    addCredits,
    assignAdminCouponDefinition,
    cancelSubscription,
    confirmCheckoutSession,
    createAdminCouponDefinition,
    createBillingPortal,
    createCheckoutSession,
    getBillingSummary,
    getPricingCatalog,
    listAdminCoupons,
    redeemCoupon,
    reactivateSubscription,
    revokeAdminCouponAssignment,
    setupPaymentMethod,
    updateAutoReload
} from '../services/billing';

type SettingsTab = 'profile' | 'settings' | 'billing' | 'legal' | 'contact' | 'admin' | 'preferences' | 'security';

interface AccountSettingsProps {
    onClose: () => void;
    initialTab?: SettingsTab;
    onSignedOut?: () => void;
    requireDobCompletion?: boolean;
    onDobCompletionStatusChange?: (needsCompletion: boolean) => void;
    openPasswordReset?: boolean;
    onPasswordResetHandled?: () => void;
}

type MessageState = { type: 'success' | 'error'; text: string } | null;
type BillingIntervalOption = BillingInterval;

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
    onSignedOut,
    requireDobCompletion = false,
    onDobCompletionStatusChange,
    openPasswordReset = false,
    onPasswordResetHandled
}) => {
    const { user, signOut, signOutAll, resendVerificationEmail, changePassword } = useAuth();
    const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
    const [searchParams] = useSearchParams();
    const [previewAvatar, setPreviewAvatar] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [privateProfile, setPrivateProfile] = useState<UserPrivateProfile | null>(null);
    const [privateProfileWarning, setPrivateProfileWarning] = useState<string | null>(null);

    const [couponCode, setCouponCode] = useState('');
    const [redeemMsg, setRedeemMsg] = useState<MessageState>(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [settingsState, setSettingsState] = useState(() => getSettingsState());
    const [billingSummary, setBillingSummary] = useState<BillingSummaryResponse | null>(null);
    const [planPricing, setPlanPricing] = useState<BillingPlanPricing[]>([]);
    const [catalogPlans, setCatalogPlans] = useState<BillingPlanDefinition[]>([]);
    const [billingLoading, setBillingLoading] = useState(false);
    const [billingActionMessage, setBillingActionMessage] = useState<MessageState>(null);
    const [billingBusy, setBillingBusy] = useState(false);
    const [selectedBillingInterval, setSelectedBillingInterval] = useState<BillingIntervalOption>('month');

    const [adminCouponDefinitions, setAdminCouponDefinitions] = useState<AdminCouponDefinition[]>([]);
    const [adminCouponAssignments, setAdminCouponAssignments] = useState<AdminCouponAssignment[]>([]);
    const [adminCouponEvents, setAdminCouponEvents] = useState<AdminCouponRedemptionEvent[]>([]);
    const [adminActionMessage, setAdminActionMessage] = useState<MessageState>(null);
    const [adminBusy, setAdminBusy] = useState(false);
    const [newCouponCode, setNewCouponCode] = useState('');
    const [newCouponStartsAt, setNewCouponStartsAt] = useState('');
    const [newCouponEndsAt, setNewCouponEndsAt] = useState('');
    const [newCouponPlanOverride, setNewCouponPlanOverride] = useState('');
    const [newCouponIncludedOverride, setNewCouponIncludedOverride] = useState('');
    const [newCouponDailyOverride, setNewCouponDailyOverride] = useState('');
    const [newCouponIncludedBonus, setNewCouponIncludedBonus] = useState('');
    const [newCouponDailyBonus, setNewCouponDailyBonus] = useState('');
    const [newCouponBonusCt, setNewCouponBonusCt] = useState('');
    const [newCouponOverageOverride, setNewCouponOverageOverride] = useState('');
    const [assignCouponDefinitionId, setAssignCouponDefinitionId] = useState('');
    const [assignTargetUserId, setAssignTargetUserId] = useState('');
    const [assignTargetEmail, setAssignTargetEmail] = useState('');
    const [assignStartsAt, setAssignStartsAt] = useState('');
    const [assignEndsAt, setAssignEndsAt] = useState('');

    const [username, setUsername] = useState('');
    const [avatarUrl, setAvatarUrl] = useState('');
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [dob, setDob] = useState('');
    const [emailPrefProductUpdates, setEmailPrefProductUpdates] = useState(true);
    const [emailPrefMarketing, setEmailPrefMarketing] = useState(false);

    const [isSavingProfile, setIsSavingProfile] = useState(false);
    const [isSavingPreferences, setIsSavingPreferences] = useState(false);
    const [profileMessage, setProfileMessage] = useState<MessageState>(null);
    const [preferencesMessage, setPreferencesMessage] = useState<MessageState>(null);
    const [securityMessage, setSecurityMessage] = useState<MessageState>(null);
    const [securityBusy, setSecurityBusy] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmNewPassword, setConfirmNewPassword] = useState('');

    useEffect(() => {
        const billing = searchParams.get('billing');
        const billingType = searchParams.get('type');
        const sessionId = searchParams.get('session_id');
        if (billing === 'success') {
            const detail = billingType === 'credits' ? 'Credits purchase completed.' : 'Subscription updated successfully.';
            const sync = async () => {
                try {
                    if (sessionId) {
                        await confirmCheckoutSession(sessionId);
                    }
                    await refreshBillingSummary();
                    setBillingActionMessage({ type: 'success', text: detail });
                } catch (err: any) {
                    setBillingActionMessage({ type: 'error', text: err?.message || 'Checkout completed, but sync is still pending.' });
                }
            };
            void sync();
        }
        if (billing === 'cancelled') {
            const detail = billingType === 'credits'
                ? 'Credits checkout was cancelled.'
                : 'Subscription checkout was cancelled.';
            setBillingActionMessage({ type: 'error', text: detail });
        }
    }, [searchParams]);

    useEffect(() => {
        setActiveTab(initialTab);
    }, [initialTab]);

    useEffect(() => {
        if (!openPasswordReset) return;
        setActiveTab('security');
        setSecurityMessage({ type: 'success', text: 'Recovery link verified. Set a new password below.' });
        onPasswordResetHandled?.();
    }, [openPasswordReset, onPasswordResetHandled]);

    useEffect(() => {
        if (!user) return;
        setIsAdmin(user.email === 'admin@test.com');
    }, [user]);

    useEffect(() => {
        if (activeTab !== 'admin' || user?.email !== 'admin@test.com') return;
        let alive = true;

        const loadAdminData = async () => {
            try {
                const state = await listAdminCoupons(200);
                if (!alive) return;
                setAdminCouponDefinitions(state.definitions);
                setAdminCouponAssignments(state.assignments);
                setAdminCouponEvents(state.events);
            } catch (err: any) {
                if (!alive) return;
                setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to load coupon admin data.' });
            }
        };

        void loadAdminData();
        return () => {
            alive = false;
        };
    }, [activeTab, user?.email]);

    useEffect(() => {
        if (activeTab !== 'billing' || !user) return;
        let alive = true;

        const loadBilling = async () => {
            setBillingLoading(true);
            try {
                const [summary, catalog] = await Promise.all([
                    getBillingSummary(),
                    getPricingCatalog()
                ]);
                if (!alive) return;
                setBillingSummary(summary);
                setPlanPricing(catalog.planPricing || []);
                setCatalogPlans(catalog.plans || []);
            } catch (err: any) {
                if (!alive) return;
                setBillingActionMessage({ type: 'error', text: err?.message || 'Failed to load billing summary.' });
            } finally {
                if (alive) setBillingLoading(false);
            }
        };

        void loadBilling();
        return () => {
            alive = false;
        };
    }, [activeTab, user]);

    useEffect(() => {
        if (!user) return;

        let active = true;
        const loadProfiles = async () => {
            setLoading(true);
            setPrivateProfileWarning(null);

            let publicProfile: UserProfile | null = null;
            let privateData: UserPrivateProfile | null = null;

            try {
                publicProfile = await getUserProfile(user.id);
            } catch (err) {
                console.error('Failed to load public profile', err);
            }

            try {
                privateData = await getPrivateProfile(user.id);
            } catch (err) {
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
            onDobCompletionStatusChange?.(!privateData?.dob);
            setLoading(false);
        };

        void loadProfiles();
        return () => {
            active = false;
        };
    }, [user, onDobCompletionStatusChange]);

    const handleRedeem = async () => {
        if (!couponCode) return;
        setBillingBusy(true);
        setRedeemMsg(null);
        try {
            const res = await redeemCoupon(couponCode.trim());
            setRedeemMsg({ type: res.success ? 'success' : 'error', text: res.message });
            if (res.summary) {
                setBillingSummary(res.summary);
            } else {
                await refreshBillingSummary();
            }
            if (isAdmin && activeTab === 'admin') {
                const state = await listAdminCoupons(200);
                setAdminCouponDefinitions(state.definitions);
                setAdminCouponAssignments(state.assignments);
                setAdminCouponEvents(state.events);
            }
        } catch (err: any) {
            setRedeemMsg({ type: 'error', text: err?.message || 'Unable to redeem coupon.' });
        } finally {
            setBillingBusy(false);
        }
    };

    const parseOptionalNumber = (value: string) => {
        const normalized = value.trim();
        if (!normalized) return undefined;
        const parsed = Number(normalized);
        if (!Number.isFinite(parsed) || parsed < 0) {
            throw new Error('Coupon numeric fields must be non-negative numbers.');
        }
        return Math.floor(parsed);
    };

    const loadAdminCouponState = async () => {
        const state = await listAdminCoupons(200);
        setAdminCouponDefinitions(state.definitions);
        setAdminCouponAssignments(state.assignments);
        setAdminCouponEvents(state.events);
    };

    const handleCreateAdminCoupon = async () => {
        setAdminActionMessage(null);
        setAdminBusy(true);
        try {
            const policy: Record<string, unknown> = {};
            if (newCouponPlanOverride.trim()) policy.planTierOverride = newCouponPlanOverride.trim();
            const includedOverride = parseOptionalNumber(newCouponIncludedOverride);
            const dailyOverride = parseOptionalNumber(newCouponDailyOverride);
            const includedBonus = parseOptionalNumber(newCouponIncludedBonus);
            const dailyBonus = parseOptionalNumber(newCouponDailyBonus);
            const bonusCt = parseOptionalNumber(newCouponBonusCt);

            if (includedOverride !== undefined) policy.includedMonthlyCtOverride = includedOverride;
            if (dailyOverride !== undefined) policy.dailyGuardrailCtOverride = dailyOverride;
            if (includedBonus !== undefined) policy.includedMonthlyCtBonus = includedBonus;
            if (dailyBonus !== undefined) policy.dailyGuardrailCtBonus = dailyBonus;
            if (bonusCt !== undefined) policy.bonusCt = bonusCt;
            if (newCouponOverageOverride === 'true') policy.overageEnabledOverride = true;
            if (newCouponOverageOverride === 'false') policy.overageEnabledOverride = false;

            const created = await createAdminCouponDefinition({
                code: newCouponCode.trim().toUpperCase(),
                startsAt: newCouponStartsAt,
                endsAt: newCouponEndsAt,
                policy
            });
            setAdminActionMessage({ type: 'success', text: `Coupon ${created.code} created.` });
            if (!assignCouponDefinitionId) {
                setAssignCouponDefinitionId(created.id);
            }
            await loadAdminCouponState();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to create coupon.' });
        } finally {
            setAdminBusy(false);
        }
    };

    const handleAssignAdminCoupon = async () => {
        setAdminActionMessage(null);
        setAdminBusy(true);
        try {
            const assignment = await assignAdminCouponDefinition({
                couponDefinitionId: assignCouponDefinitionId,
                userId: assignTargetUserId.trim() || undefined,
                email: assignTargetEmail.trim() || undefined,
                startsAt: assignStartsAt,
                endsAt: assignEndsAt
            });
            setAdminActionMessage({ type: 'success', text: `Coupon assigned (${assignment.couponCode}).` });
            await loadAdminCouponState();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to assign coupon.' });
        } finally {
            setAdminBusy(false);
        }
    };

    const handleRevokeAssignment = async (assignmentId: string) => {
        setAdminActionMessage(null);
        setAdminBusy(true);
        try {
            await revokeAdminCouponAssignment(assignmentId, 'revoked_by_admin');
            setAdminActionMessage({ type: 'success', text: 'Coupon assignment revoked.' });
            await loadAdminCouponState();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to revoke assignment.' });
        } finally {
            setAdminBusy(false);
        }
    };

    const refreshBillingSummary = async () => {
        try {
            const [summary, catalog] = await Promise.all([
                getBillingSummary(),
                getPricingCatalog()
            ]);
            setBillingSummary(summary);
            setPlanPricing(catalog.planPricing || []);
            setCatalogPlans(catalog.plans || []);
        } catch {
            // handled by action-specific flows
        }
    };

    const handleUpgradeCheckout = async (planTier: PurchasablePlanTier) => {
        const intervalLabel = selectedBillingInterval === 'year' ? 'annual' : 'monthly';
        const confirmed = window.confirm(`Confirm ${intervalLabel} subscription change to ${planTier.toUpperCase()}? You will be redirected to Stripe Checkout.`);
        if (!confirmed) return;
        setBillingActionMessage(null);
        setBillingBusy(true);
        try {
            const session = await createCheckoutSession(planTier, selectedBillingInterval);
            if (session.url) {
                window.location.href = session.url;
                return;
            }
            setBillingActionMessage({ type: 'error', text: 'Checkout URL was not returned.' });
        } catch (err: any) {
            setBillingActionMessage({ type: 'error', text: err?.message || 'Unable to start checkout.' });
        } finally {
            setBillingBusy(false);
        }
    };

    const handleAddCredits = async (packId: CreditPackId, label: string) => {
        const confirmed = window.confirm(`Confirm purchase for ${label}? You will be redirected to Stripe Checkout.`);
        if (!confirmed) return;
        setBillingActionMessage(null);
        setBillingBusy(true);
        try {
            const session = await addCredits(packId);
            if (session.url) {
                window.location.href = session.url;
                return;
            }
            setBillingActionMessage({ type: 'error', text: 'Checkout URL was not returned.' });
        } catch (err: any) {
            setBillingActionMessage({ type: 'error', text: err?.message || 'Unable to purchase credits.' });
        } finally {
            setBillingBusy(false);
        }
    };

    const handleSetupPaymentMethod = async () => {
        setBillingActionMessage(null);
        setBillingBusy(true);
        try {
            const response = await setupPaymentMethod();
            setBillingActionMessage({
                type: 'success',
                text: response.setupIntentClientSecret
                    ? 'Setup intent created. Finish card collection in Stripe-enabled UI.'
                    : 'Payment setup initiated.'
            });
            await refreshBillingSummary();
        } catch (err: any) {
            setBillingActionMessage({ type: 'error', text: err?.message || 'Unable to start payment setup.' });
        } finally {
            setBillingBusy(false);
        }
    };

    const handleToggleAutoReload = async (enabled: boolean) => {
        setBillingActionMessage(null);
        setBillingBusy(true);
        try {
            await updateAutoReload({ enabled: false, thresholdCt: 5000, packUsd: 25 });
            setBillingActionMessage({
                type: enabled ? 'error' : 'success',
                text: enabled ? 'Auto-reload is disabled by billing policy.' : 'Auto-reload remains disabled.'
            });
            await refreshBillingSummary();
        } catch (err: any) {
            setBillingActionMessage({ type: 'error', text: err?.message || 'Unable to update auto-reload.' });
        } finally {
            setBillingBusy(false);
        }
    };

    const handleOpenBillingPortal = async () => {
        setBillingActionMessage(null);
        setBillingBusy(true);
        try {
            const result = await createBillingPortal();
            if (result.url) {
                window.location.href = result.url;
                return;
            }
            setBillingActionMessage({ type: 'error', text: 'Billing portal URL was not returned.' });
        } catch (err: any) {
            setBillingActionMessage({ type: 'error', text: err?.message || 'Unable to open billing portal.' });
        } finally {
            setBillingBusy(false);
        }
    };

    const handleCancelAtPeriodEnd = async () => {
        const confirmed = window.confirm('Cancel subscription at period end? You will keep access until your current period ends.');
        if (!confirmed) return;
        setBillingActionMessage(null);
        setBillingBusy(true);
        try {
            const status = await cancelSubscription();
            setBillingActionMessage({
                type: 'success',
                text: status.currentPeriodEnd
                    ? `Cancellation scheduled. Plan remains active until ${new Date(status.currentPeriodEnd).toLocaleString()}.`
                    : 'Cancellation scheduled at period end.'
            });
            await refreshBillingSummary();
        } catch (err: any) {
            setBillingActionMessage({ type: 'error', text: err?.message || 'Unable to schedule cancellation.' });
        } finally {
            setBillingBusy(false);
        }
    };

    const handleReactivateSubscription = async () => {
        setBillingActionMessage(null);
        setBillingBusy(true);
        try {
            await reactivateSubscription();
            setBillingActionMessage({ type: 'success', text: 'Subscription reactivated successfully.' });
            await refreshBillingSummary();
        } catch (err: any) {
            setBillingActionMessage({ type: 'error', text: err?.message || 'Unable to reactivate subscription.' });
        } finally {
            setBillingBusy(false);
        }
    };

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
        const confirmed = window.confirm('Sign out from all devices? This will end every active session.');
        if (!confirmed) return;
        await signOutAll();
        onSignedOut?.();
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

                <div className="border-2 border-red-400 bg-red-50 rounded-xl p-5 space-y-3">
                    <h3 className="font-display text-2xl text-red-700">Session Control</h3>
                    <p className="text-sm text-red-700">Sign out all active sessions across devices.</p>
                    <Button onClick={handleSignOutAll} className="bg-red-600 hover:bg-red-700 text-white border-red-800" icon={<LogOut size={16} />}>
                        Sign Out All Sessions
                    </Button>
                </div>
            </div>
        );
    };

    const renderBilling = () => {
        const formatCt = (value?: number) => typeof value === 'number' ? value.toLocaleString() : 'n/a';
        const summary = billingSummary;
        const planName = summary?.effectivePlan?.name || summary?.plan?.name || 'Free';
        const planTier = summary?.effectivePlan?.id || summary?.plan?.id || 'free';
        const basePlanName = summary?.basePlan?.name || summary?.plan?.name || 'Free';
        const availableCt = summary?.wallet?.availableCt || 0;
        const dailyRemainingCt = summary?.usage?.dailyRemainingCt || 0;
        const monthlyResetAt = summary?.usage?.monthlyResetAt ? new Date(summary.usage.monthlyResetAt).toLocaleString() : 'n/a';
        const dailyResetAt = summary?.usage?.dailyResetAt ? new Date(summary.usage.dailyResetAt).toLocaleString() : 'n/a';
        const subscription = summary?.subscription;
        const subscriptionEnd = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleString() : null;
        const isCancelPending = subscription?.cancelAtPeriodEnd === true;
        const activeCoupon = summary?.activeCouponEntitlement;
        const tierOrder: PurchasablePlanTier[] = ['creator', 'pro', 'studio'];
        const pricingForInterval = tierOrder
            .map((tier) => planPricing.find((entry) => entry.planTier === tier && entry.interval === selectedBillingInterval))
            .filter((entry): entry is BillingPlanPricing => !!entry);
        const planById = new Map<string, BillingPlanDefinition>(catalogPlans.map((plan) => [plan.id, plan]));

        return (
            <div className="space-y-6 animate-fade-in">
                {billingLoading && <div className="text-sm font-bold text-slate-500">Loading billing summary...</div>}
                {renderMessage(billingActionMessage)}

                <div className="grid md:grid-cols-2 gap-6">
                    <div className="border-4 border-black bg-white p-6 rounded-2xl">
                        <h3 className="font-display text-2xl">Current Plan: {planName}</h3>
                        <p className="font-mono text-xs mt-1 uppercase text-slate-500">{planTier}</p>
                        {summary?.effectiveUsageSource === 'coupon_entitlement' && (
                            <p className="mt-1 text-xs font-bold text-amber-700">Coupon entitlement active (base plan: {basePlanName}).</p>
                        )}
                        {activeCoupon && (
                            <p className="mt-1 text-xs text-slate-600">
                                Coupon: <span className="font-mono font-bold">{activeCoupon.couponCode}</span> (valid until {new Date(activeCoupon.endsAt).toLocaleString()})
                            </p>
                        )}
                        <div className="mt-4 space-y-2 text-sm">
                            <div className="flex justify-between"><span>Available CT</span><strong>{formatCt(availableCt)}</strong></div>
                            <div className="flex justify-between"><span>Daily Remaining CT</span><strong>{formatCt(dailyRemainingCt)}</strong></div>
                            <div className="flex justify-between"><span>Monthly Included CT</span><strong>{formatCt(summary?.wallet?.includedMonthlyCt)}</strong></div>
                            <div className="flex justify-between"><span>Used This Month CT</span><strong>{formatCt(summary?.wallet?.usedMonthlyCt)}</strong></div>
                            <div className="flex justify-between"><span>Purchased CT</span><strong>{formatCt(summary?.wallet?.purchasedCt)}</strong></div>
                            <div className="flex justify-between"><span>Reserved CT</span><strong>{formatCt(summary?.wallet?.reservedCt)}</strong></div>
                        </div>
                        <div className="mt-4 text-xs text-slate-500 space-y-1">
                            <div>Daily reset: {dailyResetAt}</div>
                            <div>Monthly reset: {monthlyResetAt}</div>
                            {subscription?.status && <div>Subscription status: {subscription.status}</div>}
                            {subscription?.interval && <div>Billing interval: {subscription.interval === 'year' ? 'Annual' : 'Monthly'}</div>}
                            {subscriptionEnd && <div>Current period ends: {subscriptionEnd}</div>}
                            {isCancelPending && <div className="text-red-600 font-bold">Cancellation scheduled at period end.</div>}
                        </div>
                    </div>

                    <div className="border-4 border-black bg-brand-yellow/10 p-6 rounded-2xl">
                        <h3 className="font-display text-2xl">Upgrade Plans</h3>
                        <p className="text-xs text-slate-600 mb-4">Stripe checkout for monthly/annual subscriptions.</p>
                        <div className="flex gap-2 mb-4">
                            <Button
                                variant={selectedBillingInterval === 'month' ? 'secondary' : 'outline'}
                                disabled={billingBusy}
                                onClick={() => setSelectedBillingInterval('month')}
                            >
                                Monthly
                            </Button>
                            <Button
                                variant={selectedBillingInterval === 'year' ? 'secondary' : 'outline'}
                                disabled={billingBusy}
                                onClick={() => setSelectedBillingInterval('year')}
                            >
                                Annual
                            </Button>
                        </div>
                        <div className="grid gap-2">
                            {pricingForInterval.map((entry) => {
                                const plan = planById.get(entry.planTier);
                                const label = `${plan?.name || entry.planTier.toUpperCase()} · $${entry.priceUsd} · ${formatCt(plan?.monthlyIncludedCt)} CT`;
                                return (
                                    <Button
                                        key={`${entry.planTier}-${entry.interval}`}
                                        className="w-full"
                                        disabled={billingBusy || !entry.stripePriceConfigured}
                                        onClick={() => handleUpgradeCheckout(entry.planTier)}
                                    >
                                        {label} {entry.stripePriceConfigured ? '' : '(Unavailable)'}
                                    </Button>
                                );
                            })}
                        </div>
                        <div className="mt-4 text-xs text-slate-600">
                            Overage beyond credits requires a payment method on file.
                        </div>
                        <div className="mt-4 flex gap-2">
                            <Button variant="outline" disabled={billingBusy} onClick={handleOpenBillingPortal}>Open Billing Portal</Button>
                            {!isCancelPending && planTier !== 'free' && (
                                <Button variant="outline" disabled={billingBusy} onClick={handleCancelAtPeriodEnd}>Cancel at Period End</Button>
                            )}
                            {isCancelPending && (
                                <Button variant="secondary" disabled={billingBusy} onClick={handleReactivateSubscription}>Reactivate</Button>
                            )}
                        </div>
                    </div>
                </div>

                <div className="grid lg:grid-cols-3 gap-6">
                    <div className="border-2 border-black rounded-xl p-4 space-y-3">
                        <h4 className="font-display text-xl">Credit Packs</h4>
                        <div className="space-y-2 text-sm">
                            <button className="w-full border-2 border-black rounded px-3 py-2 font-bold text-left" disabled={billingBusy} onClick={() => handleAddCredits('pack_10', '$10 · 100,000 CT')}>
                                $10 · 100,000 CT
                            </button>
                            <button className="w-full border-2 border-black rounded px-3 py-2 font-bold text-left" disabled={billingBusy} onClick={() => handleAddCredits('pack_25', '$25 · 260,000 CT')}>
                                $25 · 260,000 CT
                            </button>
                            <button className="w-full border-2 border-black rounded px-3 py-2 font-bold text-left" disabled={billingBusy} onClick={() => handleAddCredits('pack_100', '$100 · 1,100,000 CT')}>
                                $100 · 1,100,000 CT
                            </button>
                        </div>
                    </div>

                    <div className="border-2 border-black rounded-xl p-4 space-y-3">
                        <h4 className="font-display text-xl">Payment Method</h4>
                        <div className="text-sm text-slate-700">
                            {summary?.hasPaymentMethodOnFile
                                ? 'Payment method on file for overage and direct credit purchases.'
                                : 'No payment method on file. Required for overage usage and paid credit purchases.'}
                        </div>
                        <Button icon={<CreditCard size={16} />} onClick={handleSetupPaymentMethod} disabled={billingBusy}>
                            {summary?.hasPaymentMethodOnFile ? 'Update Card' : 'Add Card'}
                        </Button>
                        <div className="text-xs text-slate-500">Cards are stored with Stripe; DreamStream stores tokenized references only.</div>
                    </div>

                    <div className="border-2 border-black rounded-xl p-4 space-y-3">
                        <h4 className="font-display text-xl">Auto Reload Policy</h4>
                        <div className="text-sm text-slate-700">
                            Auto-reload is disabled. Every credit purchase requires explicit Stripe Checkout confirmation.
                        </div>
                        <div className="flex gap-2">
                            <Button variant="outline" disabled={billingBusy} onClick={() => handleToggleAutoReload(false)}>Acknowledge</Button>
                        </div>
                        <div className="text-xs text-slate-500">Default overage hard cap: $100/month unless increased by support.</div>
                    </div>
                </div>

                <div className="border-2 border-black rounded-xl p-4 max-w-md">
                    <label className="font-bold text-xs uppercase">Redeem Coupon</label>
                    <div className="flex gap-2 mt-2">
                        <input
                            type="text"
                            value={couponCode}
                            onChange={(e) => setCouponCode(e.target.value)}
                            placeholder="Enter coupon code"
                            className="flex-1 border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                        />
                        <Button onClick={handleRedeem} disabled={billingBusy}>Redeem</Button>
                    </div>
                    {redeemMsg && (
                        <p className={`text-sm mt-2 font-semibold ${redeemMsg.type === 'success' ? 'text-green-700' : 'text-red-700'}`}>
                            {redeemMsg.text}
                        </p>
                    )}
                </div>
            </div>
        );
    };

    const renderAdmin = () => (
        <div className="space-y-6 animate-fade-in">
            {renderMessage(adminActionMessage)}

            <div className="bg-slate-100 p-6 rounded-xl border-4 border-black space-y-4">
                <h3 className="font-display text-2xl">Create Coupon Definition</h3>
                <div className="grid md:grid-cols-2 gap-3">
                    <input
                        value={newCouponCode}
                        onChange={(e) => setNewCouponCode(e.target.value)}
                        placeholder="Code (e.g. VIP_CREATOR_2026)"
                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                    />
                    <select
                        value={newCouponPlanOverride}
                        onChange={(e) => setNewCouponPlanOverride(e.target.value)}
                        className="border-2 border-black rounded-lg px-3 py-2 text-sm"
                    >
                        <option value="">No plan override</option>
                        <option value="free">free</option>
                        <option value="creator">creator</option>
                        <option value="pro">pro</option>
                        <option value="studio">studio</option>
                        <option value="custom">custom</option>
                        <option value="admin">admin</option>
                    </select>
                    <input
                        type="datetime-local"
                        value={newCouponStartsAt}
                        onChange={(e) => setNewCouponStartsAt(e.target.value)}
                        className="border-2 border-black rounded-lg px-3 py-2 text-sm"
                    />
                    <input
                        type="datetime-local"
                        value={newCouponEndsAt}
                        onChange={(e) => setNewCouponEndsAt(e.target.value)}
                        className="border-2 border-black rounded-lg px-3 py-2 text-sm"
                    />
                    <input
                        value={newCouponIncludedOverride}
                        onChange={(e) => setNewCouponIncludedOverride(e.target.value)}
                        placeholder="Included CT override"
                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                    />
                    <input
                        value={newCouponDailyOverride}
                        onChange={(e) => setNewCouponDailyOverride(e.target.value)}
                        placeholder="Daily CT override"
                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                    />
                    <input
                        value={newCouponIncludedBonus}
                        onChange={(e) => setNewCouponIncludedBonus(e.target.value)}
                        placeholder="Included CT bonus"
                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                    />
                    <input
                        value={newCouponDailyBonus}
                        onChange={(e) => setNewCouponDailyBonus(e.target.value)}
                        placeholder="Daily CT bonus"
                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                    />
                    <input
                        value={newCouponBonusCt}
                        onChange={(e) => setNewCouponBonusCt(e.target.value)}
                        placeholder="One-time bonus CT"
                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                    />
                    <select
                        value={newCouponOverageOverride}
                        onChange={(e) => setNewCouponOverageOverride(e.target.value)}
                        className="border-2 border-black rounded-lg px-3 py-2 text-sm"
                    >
                        <option value="">Keep overage policy</option>
                        <option value="true">Force overage enabled</option>
                        <option value="false">Force overage disabled</option>
                    </select>
                </div>
                <Button onClick={handleCreateAdminCoupon} disabled={adminBusy}>Create Definition</Button>
            </div>

            <div className="bg-white p-6 rounded-xl border-2 border-black space-y-4">
                <h3 className="font-display text-2xl">Assign Coupon</h3>
                <div className="grid md:grid-cols-2 gap-3">
                    <select
                        value={assignCouponDefinitionId}
                        onChange={(e) => setAssignCouponDefinitionId(e.target.value)}
                        className="border-2 border-black rounded-lg px-3 py-2 text-sm"
                    >
                        <option value="">Select coupon definition</option>
                        {adminCouponDefinitions.map((definition) => (
                            <option key={definition.id} value={definition.id}>
                                {definition.code}
                            </option>
                        ))}
                    </select>
                    <input
                        value={assignTargetUserId}
                        onChange={(e) => setAssignTargetUserId(e.target.value)}
                        placeholder="Target user ID (optional)"
                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                    />
                    <input
                        value={assignTargetEmail}
                        onChange={(e) => setAssignTargetEmail(e.target.value)}
                        placeholder="Target email (optional)"
                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                    />
                    <input
                        type="datetime-local"
                        value={assignStartsAt}
                        onChange={(e) => setAssignStartsAt(e.target.value)}
                        className="border-2 border-black rounded-lg px-3 py-2 text-sm"
                    />
                    <input
                        type="datetime-local"
                        value={assignEndsAt}
                        onChange={(e) => setAssignEndsAt(e.target.value)}
                        className="border-2 border-black rounded-lg px-3 py-2 text-sm"
                    />
                </div>
                <Button onClick={handleAssignAdminCoupon} disabled={adminBusy}>Assign Coupon</Button>
            </div>

            <div className="bg-white border-2 border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 border-b-2 border-slate-200">
                        <tr>
                            <th className="p-3 font-bold">Code</th>
                            <th className="p-3 font-bold">Window</th>
                            <th className="p-3 font-bold">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {adminCouponDefinitions.map((definition) => (
                            <tr key={definition.id} className="border-b border-slate-100 last:border-0">
                                <td className="p-3 font-mono font-bold">{definition.code}</td>
                                <td className="p-3 text-xs text-slate-500">{new Date(definition.startsAt).toLocaleString()} → {new Date(definition.endsAt).toLocaleString()}</td>
                                <td className="p-3 text-xs">{definition.isActive ? 'Active' : 'Inactive'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="bg-white border-2 border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 border-b-2 border-slate-200">
                        <tr>
                            <th className="p-3 font-bold">Coupon</th>
                            <th className="p-3 font-bold">Target</th>
                            <th className="p-3 font-bold">Status</th>
                            <th className="p-3 font-bold">Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {adminCouponAssignments.map((assignment) => (
                            <tr key={assignment.id} className="border-b border-slate-100 last:border-0">
                                <td className="p-3 font-mono">{assignment.couponCode}</td>
                                <td className="p-3 text-xs text-slate-600">{assignment.userId || assignment.email || '-'}</td>
                                <td className="p-3 text-xs">
                                    {assignment.revokedAt
                                        ? 'Revoked'
                                        : assignment.isRedeemed
                                            ? `Redeemed ${assignment.redeemedAt ? new Date(assignment.redeemedAt).toLocaleString() : ''}`
                                            : assignment.isActive ? 'Assigned' : 'Inactive'}
                                </td>
                                <td className="p-3">
                                    {!assignment.revokedAt && assignment.isActive && (
                                        <Button variant="outline" onClick={() => handleRevokeAssignment(assignment.id)} disabled={adminBusy}>
                                            Revoke
                                        </Button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="bg-white border-2 border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 border-b-2 border-slate-200">
                        <tr>
                            <th className="p-3 font-bold">When</th>
                            <th className="p-3 font-bold">Code</th>
                            <th className="p-3 font-bold">Outcome</th>
                            <th className="p-3 font-bold">Reason</th>
                        </tr>
                    </thead>
                    <tbody>
                        {adminCouponEvents.slice(0, 100).map((event) => (
                            <tr key={event.id} className="border-b border-slate-100 last:border-0">
                                <td className="p-3 text-xs">{new Date(event.createdAt).toLocaleString()}</td>
                                <td className="p-3 font-mono">{event.couponCode}</td>
                                <td className="p-3 text-xs">{event.outcome}</td>
                                <td className="p-3 text-xs text-slate-500">{event.reason || '-'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );

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

    const renderSettings = () => {
        const modelKeys = getAllModelKeys();
        const imageModelOptions = IMAGE_MODELS;
        const textModelLabelMap = new Map(TEXT_MODELS.map((model) => [model.id, model.label]));
        const textModelOptions = TEXT_MODELS.map((model) => model.id);
        const imageModelIds = new Set(imageModelOptions.map((model) => model.id));
        const textModelIds = new Set(textModelOptions);
        const selectedImageModel = imageModelIds.has(settingsState.defaultImageModel || '')
            ? settingsState.defaultImageModel
            : imageModelOptions[0]?.id;
        const requestedTextModel = settingsState.defaultTextModel || settingsState.defaultTextModelKey || TEXT_MODEL;
        const selectedTextModel = textModelIds.has(requestedTextModel) ? requestedTextModel : TEXT_MODEL;

        const saveSettings = (next: ReturnType<typeof getSettingsState>) => {
            setSettingsState(next);
            persistSettingsState(next);
        };

        return (
            <div className="space-y-6 animate-fade-in max-w-3xl">
                <div>
                    <h3 className="font-display text-xl mb-4">API Keys</h3>
                    <KeyManager />
                </div>

                <div className="border-2 border-slate-200 rounded-xl p-4 bg-white space-y-4">
                    <div>
                        <label className="text-xs font-bold uppercase text-slate-500">Default Image Model</label>
                        <select
                            value={selectedImageModel}
                            onChange={(e) => saveSettings({ ...settingsState, defaultImageModel: e.target.value })}
                            className="w-full mt-1 border-2 border-black rounded-lg px-3 py-2 text-sm bg-white"
                        >
                            {imageModelOptions.map((model) => (
                                <option key={model.id} value={model.id}>
                                    {model.label}{modelKeys[model.id] ? ' (your key)' : model.provider === 'flux' ? ' (system/free)' : ''}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="text-xs font-bold uppercase text-slate-500">Default Text Model</label>
                        <select
                            value={selectedTextModel}
                            onChange={(e) => saveSettings({
                                ...settingsState,
                                defaultTextModel: e.target.value,
                                defaultTextModelKey: e.target.value
                            })}
                            className="w-full mt-1 border-2 border-black rounded-lg px-3 py-2 text-sm bg-white"
                        >
                            {textModelOptions.map((modelId) => (
                                <option key={modelId} value={modelId}>
                                    {(textModelLabelMap.get(modelId) || modelId)}
                                    {modelKeys[modelId] ? ' (configured key)' : modelId === TEXT_MODEL ? ' (default)' : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-slate-50 pb-20">
            <div className="bg-white border-b-4 border-black sticky top-0 z-30">
                <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-black text-white rounded-lg flex items-center justify-center font-display text-xl">S</div>
                        <h1 className="font-display text-2xl">Account Settings</h1>
                    </div>
                    <button onClick={onClose} className="font-bold hover:underline">Exit</button>
                </div>
            </div>

            <div className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 md:grid-cols-4 gap-8">
                <div className="space-y-2">
                    <NavButton icon={<UserIcon size={18} />} label="Profile" active={activeTab === 'profile'} onClick={() => setActiveTab('profile')} />
                    <NavButton icon={<Settings size={18} />} label="API Configuration" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
                    <NavButton icon={<Mail size={18} />} label="Preferences" active={activeTab === 'preferences'} onClick={() => setActiveTab('preferences')} />
                    <NavButton icon={<Shield size={18} />} label="Security" active={activeTab === 'security'} onClick={() => setActiveTab('security')} />
                    <NavButton icon={<CreditCard size={18} />} label="Billing" active={activeTab === 'billing'} onClick={() => setActiveTab('billing')} />
                    <NavButton icon={<Shield size={18} />} label="Legal" active={activeTab === 'legal'} onClick={() => setActiveTab('legal')} />
                    <NavButton icon={<Mail size={18} />} label="Contact" active={activeTab === 'contact'} onClick={() => setActiveTab('contact')} />
                    {isAdmin && (
                        <NavButton icon={<Shield size={18} />} label="Admin" active={activeTab === 'admin'} onClick={() => setActiveTab('admin')} />
                    )}

                    <div className="pt-8">
                        <button
                            onClick={async () => {
                                await signOut();
                                onSignedOut?.();
                            }}
                            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-red-600 hover:bg-red-50 transition-colors"
                        >
                            <LogOut size={18} /> Sign Out
                        </button>
                    </div>
                </div>

                <div className="md:col-span-3 bg-white border-4 border-black rounded-2xl p-8 shadow-comic min-h-[600px]">
                    {loading ? (
                        <div className="flex items-center justify-center h-full">Loading...</div>
                    ) : (
                        <>
                            <h2 className="font-display text-3xl mb-6 capitalize">{activeTab}</h2>
                            {activeTab === 'profile' && renderProfile()}
                            {activeTab === 'settings' && renderSettings()}
                            {activeTab === 'preferences' && renderPreferences()}
                            {activeTab === 'security' && renderSecurity()}
                            {activeTab === 'billing' && renderBilling()}
                            {activeTab === 'legal' && renderLegal()}
                            {activeTab === 'contact' && <ContactSection />}
                            {activeTab === 'admin' && renderAdmin()}
                        </>
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

const NavButton = ({
    icon,
    label,
    active,
    onClick
}: {
    icon: React.ReactNode;
    label: string;
    active: boolean;
    onClick: () => void;
}) => (
    <button
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold transition-all ${active ? 'bg-black text-white shadow-comic transform -translate-y-1' : 'bg-transparent text-slate-500 hover:bg-slate-200'}`}
    >
        {icon} {label}
    </button>
);
