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
import { ApiConfiguration } from './ApiConfiguration';
import { AlertTriangle, CheckCircle2, CreditCard, LogOut, Mail, Save, Settings, Shield, Upload, User as UserIcon, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSearchParams } from 'react-router-dom';
import {
    getAllowedImageModelsForPlan,
    isImageModelAllowedForPlan
} from '../services/imageModels';
import {
    TEXT_MODEL,
    TEXT_MODELS,
    getAllowedTextModelIdsForPlan
} from '../services/modelPolicy';
import type {
    AdminAccessResponse,
    AdminCouponAssignment,
    AdminCouponDefinition,
    AdminCouponRedemptionEvent,
    AdminUserRecord,
    BillingInterval,
    BillingPlanDefinition,
    BillingPlanTier,
    BillingPlanPricing,
    BillingSummaryResponse,
    CouponPreviewResult,
    CreditPackId,
    ProjectModerationQueueItem,
    PurchasablePlanTier
} from '../shared/types/billing';
import {
    addCredits,
    approveProjectRepublish,
    cancelSubscription,
    confirmCheckoutSession,
    createAdminCouponDefinition,
    createBillingPortal,
    createCheckoutSession,
    forceProjectPrivate,
    getAdminAccess,
    getBillingSummary,
    getPricingCatalog,
    listAdminUsers,
    listAdminCoupons,
    listAdminCouponsByCursor,
    listModerationQueue,
    moderateUser,
    previewCoupon,
    redeemCoupon,
    reactivateSubscription,
    setupPaymentMethod,
    setSpendCap,
    updateAdminUserPlan,
    updateAdminUserRole,
    updateAutoReload
} from '../services/billing';
import { buildModelEntitlements } from '../services/modelEntitlements';
import { isFreeOnly, setFreeOnly, onFreeOnlyChanged } from '../services/freeOnlyMode';
import { VerificationCenter } from './VerificationCenter';

type SettingsTab = 'profile' | 'settings' | 'billing' | 'legal' | 'contact' | 'admin' | 'preferences' | 'security';

interface AccountSettingsProps {
    onClose: () => void;
    initialTab?: SettingsTab;
    onSignedOut?: () => void;
    requireDobCompletion?: boolean;
    onDobCompletionStatusChange?: (needsCompletion: boolean) => void;
    openPasswordReset?: boolean;
    onPasswordResetHandled?: () => void;
    onNavigate?: (view: string) => void;
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
    onPasswordResetHandled,
    onNavigate
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
    const [couponPreview, setCouponPreview] = useState<CouponPreviewResult | null>(null);
    const [couponPreviewBusy, setCouponPreviewBusy] = useState(false);
    const [redeemMsg, setRedeemMsg] = useState<MessageState>(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [isModerator, setIsModerator] = useState(false);
    const [adminAccess, setAdminAccess] = useState<AdminAccessResponse | null>(null);
    const [settingsState, setSettingsState] = useState(() => getSettingsState());
    const [billingSummary, setBillingSummary] = useState<BillingSummaryResponse | null>(null);
    const [planPricing, setPlanPricing] = useState<BillingPlanPricing[]>([]);
    const [catalogPlans, setCatalogPlans] = useState<BillingPlanDefinition[]>([]);
    const [billingLoading, setBillingLoading] = useState(false);
    const [billingActionMessage, setBillingActionMessage] = useState<MessageState>(null);
    const [billingBusy, setBillingBusy] = useState(false);
    const [spendCapInput, setSpendCapInput] = useState<string>('');
    const [selectedBillingInterval, setSelectedBillingInterval] = useState<BillingIntervalOption>('month');

    const [adminCouponDefinitions, setAdminCouponDefinitions] = useState<AdminCouponDefinition[]>([]);
    const [adminCouponAssignments, setAdminCouponAssignments] = useState<AdminCouponAssignment[]>([]);
    const [adminCouponEvents, setAdminCouponEvents] = useState<AdminCouponRedemptionEvent[]>([]);
    const [adminActionMessage, setAdminActionMessage] = useState<MessageState>(null);
    const [adminBusy, setAdminBusy] = useState(false);
    const [newCouponTokenAmount, setNewCouponTokenAmount] = useState('10000');
    const [newCouponValidForHours, setNewCouponValidForHours] = useState('168');
    const [createdAdminCoupon, setCreatedAdminCoupon] = useState<AdminCouponDefinition | null>(null);
    const [adminLastRefreshedAt, setAdminLastRefreshedAt] = useState<string | null>(null);
    const [adminUsers, setAdminUsers] = useState<AdminUserRecord[]>([]);
    const [moderationQueue, setModerationQueue] = useState<ProjectModerationQueueItem[]>([]);
    const [adminUserQuery, setAdminUserQuery] = useState('');
    const [moderationReasonByProject, setModerationReasonByProject] = useState<Record<string, string>>({});
    const [moderationReasonByUser, setModerationReasonByUser] = useState<Record<string, string>>({});

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
        if (!user) {
            setIsAdmin(false);
            setIsModerator(false);
            setAdminAccess(null);
            return;
        }

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
            }
        };

        void loadAccess();
        return () => {
            active = false;
        };
    }, [user]);

    const loadAdminCouponState = async () => {
        const firstPage = await listAdminCoupons(200);
        const definitionRows = [...firstPage.definitions];
        let cursor = firstPage.nextCursor;
        let pageCount = 0;
        while (cursor && pageCount < 25) {
            const nextPage = await listAdminCouponsByCursor({ limit: 200, cursor });
            definitionRows.push(...nextPage.definitions);
            cursor = nextPage.nextCursor;
            pageCount += 1;
        }
        setAdminCouponDefinitions(definitionRows);
        setAdminCouponAssignments(firstPage.assignments);
        setAdminCouponEvents(firstPage.events);
        setAdminLastRefreshedAt(new Date().toISOString());
    };

    const loadGovernanceState = async () => {
        const [userResult, queueResult] = await Promise.all([
            listAdminUsers({ q: adminUserQuery.trim() || undefined, limit: 100 }),
            listModerationQueue({ limit: 100 })
        ]);
        setAdminUsers(userResult.items || []);
        setModerationQueue(queueResult.items || []);
        setAdminLastRefreshedAt(new Date().toISOString());
    };

    useEffect(() => {
        if (activeTab !== 'admin' || (!isAdmin && !isModerator)) return;
        let alive = true;
        let inFlight = false;

        const loadAdminData = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                await loadGovernanceState();
                if (isAdmin) {
                    await loadAdminCouponState();
                }
            } catch (err: any) {
                if (!alive) return;
                setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to load moderation/admin data.' });
            } finally {
                inFlight = false;
            }
        };

        void loadAdminData();
        const timer = window.setInterval(() => {
            void loadAdminData();
        }, 15_000);

        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [activeTab, isAdmin, isModerator, adminUserQuery]);

    useEffect(() => {
        if ((activeTab !== 'billing' && activeTab !== 'settings' && activeTab !== 'admin') || !user) return;
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

    const handlePreviewCoupon = async () => {
        const normalizedCode = couponCode.trim();
        if (!normalizedCode) return;
        setCouponPreviewBusy(true);
        setRedeemMsg(null);
        try {
            const preview = await previewCoupon(normalizedCode);
            setCouponPreview(preview);
        } catch (err: any) {
            setCouponPreview(null);
            setRedeemMsg({ type: 'error', text: err?.message || 'Unable to preview coupon.' });
        } finally {
            setCouponPreviewBusy(false);
        }
    };

    const handleRedeem = async () => {
        const normalizedCode = couponCode.trim();
        if (!normalizedCode) return;
        setBillingBusy(true);
        setRedeemMsg(null);
        try {
            const res = await redeemCoupon(normalizedCode);
            setRedeemMsg({ type: res.success ? 'success' : 'error', text: res.message });
            setCouponPreview(null);
            if (res.summary) {
                setBillingSummary(res.summary);
            } else {
                await refreshBillingSummary();
            }
            if ((isAdmin || isModerator) && activeTab === 'admin') {
                await loadGovernanceState();
                if (isAdmin) {
                    await loadAdminCouponState();
                }
            }
        } catch (err: any) {
            setRedeemMsg({ type: 'error', text: err?.message || 'Unable to redeem coupon.' });
        } finally {
            setBillingBusy(false);
        }
    };

    const parsePositiveInteger = (value: string, fieldName: string, min = 1) => {
        const normalized = value.trim();
        if (!normalized) throw new Error(`${fieldName} is required.`);
        const parsed = Number(normalized);
        if (!Number.isFinite(parsed) || Math.floor(parsed) !== parsed || parsed < min) {
            throw new Error(`${fieldName} must be an integer >= ${min}.`);
        }
        return Math.floor(parsed);
    };

    const handleCreateAdminCoupon = async () => {
        setAdminActionMessage(null);
        setAdminBusy(true);
        try {
            const tokenAmountCt = parsePositiveInteger(newCouponTokenAmount, 'Token amount');
            const validForHours = parsePositiveInteger(newCouponValidForHours, 'Validity (hours)');

            const created = await createAdminCouponDefinition({
                tokenAmountCt,
                validForHours
            });
            setCreatedAdminCoupon(created);
            setAdminActionMessage({ type: 'success', text: `Coupon ${created.code} created.` });
            await loadAdminCouponState();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to create coupon.' });
        } finally {
            setAdminBusy(false);
        }
    };

    const handleAdminUserPlanChange = async (userId: string, planTier: BillingPlanTier) => {
        setAdminBusy(true);
        setAdminActionMessage(null);
        try {
            await updateAdminUserPlan({ userId, planTier });
            setAdminActionMessage({ type: 'success', text: `Updated plan for ${userId} to ${planTier}.` });
            await loadGovernanceState();
            await refreshBillingSummary();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to update user plan.' });
        } finally {
            setAdminBusy(false);
        }
    };

    const handleAdminRemovePlanStatus = async (userId: string) => {
        setAdminBusy(true);
        setAdminActionMessage(null);
        try {
            await updateAdminUserPlan({ userId, removePlanStatus: true });
            setAdminActionMessage({ type: 'success', text: `Removed paid plan status for ${userId}.` });
            await loadGovernanceState();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to remove plan status.' });
        } finally {
            setAdminBusy(false);
        }
    };

    const handleAdminRoleChange = async (userId: string, role: 'admin' | 'moderator', action: 'grant' | 'revoke') => {
        setAdminBusy(true);
        setAdminActionMessage(null);
        try {
            await updateAdminUserRole({ userId, role, action });
            setAdminActionMessage({ type: 'success', text: `${action === 'grant' ? 'Granted' : 'Revoked'} ${role} role for ${userId}.` });
            await loadGovernanceState();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to update role.' });
        } finally {
            setAdminBusy(false);
        }
    };

    const handleForcePrivateProject = async (projectId: string) => {
        const reason = normalizeText(moderationReasonByProject[projectId]);
        if (!reason) {
            setAdminActionMessage({ type: 'error', text: 'Reason is required to force private.' });
            return;
        }
        setAdminBusy(true);
        setAdminActionMessage(null);
        try {
            await forceProjectPrivate({ projectId, reason });
            setAdminActionMessage({ type: 'success', text: `Project ${projectId} is now private.` });
            setModerationReasonByProject((prev) => ({ ...prev, [projectId]: '' }));
            await loadGovernanceState();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to force private.' });
        } finally {
            setAdminBusy(false);
        }
    };

    const handleReviewRepublish = async (projectId: string, approve: boolean) => {
        const reason = normalizeText(moderationReasonByProject[projectId]);
        setAdminBusy(true);
        setAdminActionMessage(null);
        try {
            await approveProjectRepublish({ projectId, approve, reason: reason || undefined });
            setAdminActionMessage({ type: 'success', text: `${approve ? 'Approved' : 'Rejected'} republish for ${projectId}.` });
            setModerationReasonByProject((prev) => ({ ...prev, [projectId]: '' }));
            await loadGovernanceState();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to review republish request.' });
        } finally {
            setAdminBusy(false);
        }
    };

    const handleModerateUser = async (
        userId: string,
        status: 'active' | 'restricted' | 'suspended'
    ) => {
        const reason = normalizeText(moderationReasonByUser[userId]);
        setAdminBusy(true);
        setAdminActionMessage(null);
        try {
            await moderateUser({ userId, status, reason: reason || undefined });
            setAdminActionMessage({ type: 'success', text: `Set moderation status for ${userId} to ${status}.` });
            setModerationReasonByUser((prev) => ({ ...prev, [userId]: '' }));
            await loadGovernanceState();
        } catch (err: any) {
            setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to update moderation status.' });
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

    const handleUpdateSpendCap = async () => {
        const capUsd = Number(spendCapInput);
        if (!Number.isFinite(capUsd) || capUsd < 0) {
            setBillingActionMessage({ type: 'error', text: 'Enter a valid spend cap in USD (0 or more).' });
            return;
        }
        setBillingActionMessage(null);
        setBillingBusy(true);
        try {
            await setSpendCap(capUsd);
            setBillingActionMessage({ type: 'success', text: `Monthly spend cap set to $${capUsd.toFixed(2)}.` });
            setSpendCapInput('');
            await refreshBillingSummary();
        } catch (err: any) {
            setBillingActionMessage({ type: 'error', text: err?.message || 'Unable to update spend cap.' });
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
                        <p className="text-sm text-slate-500">Block instead of paid fallback. Text uses :free models; images route to NVIDIA's free image tier when an nvapi- key is configured.</p>
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
        const availableCt = summary?.wallet?.availableCt || 0;
        const dailyRemainingCt = summary?.usage?.dailyRemainingCt || 0;
        const dailyLimitEnabled = summary?.effectivePlan?.dailyLimitEnabled ?? summary?.plan?.dailyLimitEnabled ?? false;
        const monthlyResetAt = summary?.usage?.monthlyResetAt ? new Date(summary.usage.monthlyResetAt).toLocaleString() : 'n/a';
        const dailyResetAt = summary?.usage?.dailyResetAt ? new Date(summary.usage.dailyResetAt).toLocaleString() : 'n/a';
        const subscription = summary?.subscription;
        const subscriptionEnd = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleString() : null;
        const isCancelPending = subscription?.cancelAtPeriodEnd === true;
        const tierOrder: PurchasablePlanTier[] = ['creator', 'studio'];
        const pricingForInterval = tierOrder
            .map((tier) => planPricing.find((entry) => entry.planTier === tier && entry.interval === selectedBillingInterval))
            .filter((entry): entry is BillingPlanPricing => !!entry);
        const planById = new Map<string, BillingPlanDefinition>(catalogPlans.map((plan) => [plan.id, plan]));
        const normalizedCode = couponCode.trim().toUpperCase();
        const previewMatchesInput = Boolean(couponPreview?.couponCode && couponPreview.couponCode === normalizedCode);
        const canRedeemPreviewedCoupon = previewMatchesInput && couponPreview?.canRedeemNow === true;

        return (
            <div className="space-y-6 animate-fade-in">
                {billingLoading && <div className="text-sm font-bold text-slate-500">Loading billing summary...</div>}
                {renderMessage(billingActionMessage)}

                <div className="grid md:grid-cols-2 gap-6">
                    <div className="border-4 border-black bg-white p-6 rounded-2xl">
                        <h3 className="font-display text-2xl">Current Plan: {planName}</h3>
                        <p className="font-mono text-xs mt-1 uppercase text-slate-500">{planTier}</p>
                        <div className="mt-4 space-y-2 text-sm">
                            <div className="flex justify-between"><span>Available CT</span><strong>{formatCt(availableCt)}</strong></div>
                            {dailyLimitEnabled && (
                                <div className="flex justify-between"><span>Daily Remaining CT</span><strong>{formatCt(dailyRemainingCt)}</strong></div>
                            )}
                            <div className="flex justify-between"><span>Monthly Included CT</span><strong>{formatCt(summary?.wallet?.includedMonthlyCt)}</strong></div>
                            <div className="flex justify-between"><span>Used This Month CT</span><strong>{formatCt(summary?.wallet?.usedMonthlyCt)}</strong></div>
                            <div className="flex justify-between"><span>Purchased CT</span><strong>{formatCt(summary?.wallet?.purchasedCt)}</strong></div>
                            <div className="flex justify-between"><span>Reserved CT</span><strong>{formatCt(summary?.wallet?.reservedCt)}</strong></div>
                        </div>
                        <div className="mt-4 text-xs text-slate-500 space-y-1">
                            {dailyLimitEnabled ? (
                                <div>Daily reset: {dailyResetAt}</div>
                            ) : (
                                <div>Daily cap: Disabled for this plan</div>
                            )}
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
                                const label = `${plan?.name || entry.planTier.toUpperCase()} · $${entry.priceUsd} · ${formatCt(entry.includedMonthlyCt)} CT`;
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

                    <div className="border-2 border-black rounded-xl p-4 space-y-3">
                        <h4 className="font-display text-xl">Monthly Spend Cap</h4>
                        <div className="text-sm text-slate-700">
                            Hard ceiling on overage spend per month — generation is blocked once it's reached. Current cap:{' '}
                            <span className="font-bold">${(summary?.overageHardCapUsd ?? 0).toFixed(2)}</span>.
                        </div>
                        <div className="flex gap-2">
                            <input
                                type="number"
                                min={0}
                                step={1}
                                value={spendCapInput}
                                onChange={(e) => setSpendCapInput(e.target.value)}
                                placeholder={`${(summary?.overageHardCapUsd ?? 0).toFixed(0)}`}
                                className="w-32 border-2 border-black rounded px-3 py-2 text-sm"
                            />
                            <Button variant="outline" disabled={billingBusy || !spendCapInput.trim()} onClick={handleUpdateSpendCap}>Update cap</Button>
                        </div>
                        <div className="text-xs text-slate-500">Set to 0 to block all overage spend. You'll get an in-app alert at 80% and 100% of your daily limit or spend cap.</div>
                    </div>
                </div>

                <div className="border-2 border-black rounded-xl p-4 max-w-2xl space-y-3">
                    <label className="font-bold text-xs uppercase">Redeem Coupon</label>
                    <p className="text-xs text-slate-600">
                        Coupons add CT to your wallet and are single-use globally. Preview first to verify amount, expiry, and remaining availability.
                    </p>
                    <div className="flex gap-2 mt-2">
                        <input
                            type="text"
                            value={couponCode}
                            onChange={(e) => {
                                setCouponCode(e.target.value);
                                setCouponPreview(null);
                                setRedeemMsg(null);
                            }}
                            placeholder="Enter coupon code"
                            className="flex-1 border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                        />
                        <Button onClick={handlePreviewCoupon} disabled={billingBusy || couponPreviewBusy || !couponCode.trim()}>
                            {couponPreviewBusy ? 'Checking...' : 'Preview'}
                        </Button>
                        <Button onClick={handleRedeem} disabled={billingBusy || !canRedeemPreviewedCoupon}>
                            Redeem
                        </Button>
                    </div>

                    {couponPreview && (
                        <div className={`border-2 rounded-lg p-3 text-sm ${couponPreview.success ? 'border-green-400 bg-green-50' : 'border-amber-400 bg-amber-50'}`}>
                            <div className="font-semibold">{couponPreview.message}</div>
                            <div className="mt-2 text-xs space-y-1">
                                <div>Code: <span className="font-mono font-bold">{couponPreview.couponCode}</span></div>
                                <div>Token amount: <span className="font-semibold">{formatCt(couponPreview.tokenAmountCt)} CT</span></div>
                                {couponPreview.startsAt && couponPreview.endsAt && (
                                    <div>Validity: {new Date(couponPreview.startsAt).toLocaleString()} to {new Date(couponPreview.endsAt).toLocaleString()}</div>
                                )}
                                <div>Remaining redemptions: {couponPreview.remainingRedemptions ?? 0} / {couponPreview.maxRedemptions ?? 1}</div>
                                {couponPreview.warnings?.expiresSoon && (
                                    <div className="text-amber-700 font-semibold">
                                        Expiry warning: this coupon expires in about {couponPreview.warnings.expiresInHours ?? 0} hours.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {redeemMsg && (
                        <p className={`text-sm mt-2 font-semibold ${redeemMsg.type === 'success' ? 'text-green-700' : 'text-red-700'}`}>
                            {redeemMsg.text}
                        </p>
                    )}
                </div>
            </div>
        );
    };

    const renderAdmin = () => {
        const planOptions: BillingPlanTier[] = ['free', 'creator', 'studio', 'custom', 'admin'];

        return (
            <div className="space-y-6 animate-fade-in">
                {renderMessage(adminActionMessage)}

                <details className="border-2 border-black rounded-xl bg-white" open>
                    <summary className="px-4 py-3 cursor-pointer font-display text-lg">Verification Center</summary>
                    <div className="border-t-2 border-black">
                        <VerificationCenter />
                    </div>
                </details>

                <div className="border-2 border-black bg-slate-50 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm">
                        <div className="font-bold">Access Level</div>
                        <div className="flex flex-wrap gap-2 mt-1">
                            <span className={`px-2 py-1 rounded-full text-xs font-bold ${isAdmin ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-700'}`}>Admin {isAdmin ? 'Enabled' : 'No'}</span>
                            <span className={`px-2 py-1 rounded-full text-xs font-bold ${isModerator ? 'bg-blue-100 text-blue-700' : 'bg-slate-200 text-slate-700'}`}>Moderator {isModerator ? 'Enabled' : 'No'}</span>
                            {adminAccess?.bootstrapAdmin && (
                                <span className="px-2 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700">Bootstrap Admin</span>
                            )}
                        </div>
                    </div>
                    <div className="text-xs text-slate-500 flex items-center gap-3">
                        <span>{adminLastRefreshedAt ? `Last refreshed: ${new Date(adminLastRefreshedAt).toLocaleTimeString()}` : 'Not refreshed yet'}</span>
                        <Button
                            variant="outline"
                            disabled={adminBusy}
                            onClick={async () => {
                                setAdminBusy(true);
                                try {
                                    await loadGovernanceState();
                                    if (isAdmin) {
                                        await loadAdminCouponState();
                                    }
                                } catch (err: any) {
                                    setAdminActionMessage({ type: 'error', text: err?.message || 'Failed to refresh admin data.' });
                                } finally {
                                    setAdminBusy(false);
                                }
                            }}
                        >
                            Refresh
                        </Button>
                    </div>
                </div>

                <div className="border-4 border-purple-500 bg-purple-50 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-6 shadow-sm">
                    <div>
                        <h3 className="font-display text-2xl text-purple-900">Test Lab</h3>
                        <p className="text-sm text-purple-800 font-bold mt-1">
                            Restricted environment for model consistency testing.
                        </p>
                        <ul className="mt-2 text-xs text-purple-700 space-y-1 list-disc list-inside">
                            <li>Strict limits (max 2 chars/items/locations)</li>
                            <li>No token burn (uses guardrail or test key)</li>
                            <li>Full raw metadata & AI audit</li>
                        </ul>
                    </div>
                    <div>
                        <Button
                            onClick={() => onNavigate?.('test')}
                            className="bg-purple-600 hover:bg-purple-700 text-white border-purple-900 shadow-md"
                            icon={<Settings size={18} />}
                        >
                            Launch Test Lab
                        </Button>
                    </div>
                </div>

                <div className="border-2 border-slate-200 rounded-xl p-4 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h3 className="font-display text-2xl">User Directory</h3>
                            <p className="text-xs text-slate-500">Search users, manage plans, and apply moderation controls.</p>
                        </div>
                        <input
                            value={adminUserQuery}
                            onChange={(e) => setAdminUserQuery(e.target.value)}
                            placeholder="Search by username or email"
                            className="w-full md:w-72 border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                        />
                    </div>

                    <div className="space-y-3">
                        {adminUsers.length === 0 && (
                            <div className="text-sm text-slate-500 border border-slate-200 rounded-lg px-3 py-3">No users found.</div>
                        )}
                        {adminUsers.map((adminUser) => {
                            const isTargetAdmin = adminUser.roles.includes('admin');
                            const canModerateTarget = isAdmin || !isTargetAdmin;
                            return (
                                <div key={adminUser.userId} className="border-2 border-slate-200 rounded-xl p-4 space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                            <div className="font-bold">{adminUser.username || '(no username)'}</div>
                                            <div className="text-xs text-slate-500">
                                                {adminUser.email || adminUser.maskedEmail || adminUser.userId}
                                            </div>
                                        </div>
                                        <div className="text-xs text-slate-600">
                                            Created: {adminUser.createdAt ? new Date(adminUser.createdAt).toLocaleDateString() : 'n/a'}
                                        </div>
                                    </div>

                                    <div className="grid md:grid-cols-3 gap-3">
                                        <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                                            <div className="text-xs font-bold uppercase text-slate-500">Plan</div>
                                            <div className="text-sm font-semibold uppercase">{adminUser.planTier}</div>
                                            {isAdmin ? (
                                                <>
                                                    <select
                                                        value={adminUser.planTier}
                                                        onChange={(e) => handleAdminUserPlanChange(adminUser.userId, e.target.value as BillingPlanTier)}
                                                        className="w-full border-2 border-black rounded px-2 py-1 text-sm bg-white"
                                                        disabled={adminBusy}
                                                    >
                                                        {adminUser.planTier === 'pro' && (
                                                            <option value="pro">pro (legacy)</option>
                                                        )}
                                                        {planOptions.map((planTier) => (
                                                            <option key={planTier} value={planTier}>{planTier}</option>
                                                        ))}
                                                    </select>
                                                    <Button
                                                        variant="outline"
                                                        disabled={adminBusy || adminUser.planTier === 'free'}
                                                        onClick={() => handleAdminRemovePlanStatus(adminUser.userId)}
                                                    >
                                                        Remove Plan Status
                                                    </Button>
                                                </>
                                            ) : (
                                                <div className="text-xs text-slate-500">Only admins can change plans.</div>
                                            )}
                                        </div>

                                        <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                                            <div className="text-xs font-bold uppercase text-slate-500">Roles</div>
                                            <div className="flex flex-wrap gap-1">
                                                {adminUser.roles.length === 0 && <span className="text-xs text-slate-500">No elevated roles</span>}
                                                {adminUser.roles.map((role) => (
                                                    <span key={role} className={`px-2 py-1 rounded-full text-xs font-bold ${role === 'admin' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                                                        {role}
                                                    </span>
                                                ))}
                                            </div>
                                            {isAdmin ? (
                                                <div className="flex gap-2 flex-wrap">
                                                    <Button
                                                        variant="outline"
                                                        disabled={adminBusy}
                                                        onClick={() => handleAdminRoleChange(adminUser.userId, 'moderator', adminUser.roles.includes('moderator') ? 'revoke' : 'grant')}
                                                    >
                                                        {adminUser.roles.includes('moderator') ? 'Revoke Moderator' : 'Grant Moderator'}
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        disabled={adminBusy}
                                                        onClick={() => handleAdminRoleChange(adminUser.userId, 'admin', adminUser.roles.includes('admin') ? 'revoke' : 'grant')}
                                                    >
                                                        {adminUser.roles.includes('admin') ? 'Revoke Admin' : 'Grant Admin'}
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div className="text-xs text-slate-500">Moderators cannot assign roles.</div>
                                            )}
                                        </div>

                                        <div className="border border-slate-200 rounded-lg p-3 space-y-2">
                                            <div className="text-xs font-bold uppercase text-slate-500">User Moderation</div>
                                            <div className="text-sm font-semibold capitalize">{adminUser.moderationStatus}</div>
                                            <input
                                                value={moderationReasonByUser[adminUser.userId] || ''}
                                                onChange={(e) => setModerationReasonByUser((prev) => ({ ...prev, [adminUser.userId]: e.target.value }))}
                                                placeholder="Reason (optional)"
                                                className="w-full border-2 border-black rounded px-2 py-1 text-xs"
                                            />
                                            {canModerateTarget ? (
                                                <div className="flex gap-2 flex-wrap">
                                                    <Button variant="outline" disabled={adminBusy} onClick={() => handleModerateUser(adminUser.userId, 'active')}>Set Active</Button>
                                                    <Button variant="outline" disabled={adminBusy} onClick={() => handleModerateUser(adminUser.userId, 'restricted')}>Restrict</Button>
                                                    <Button variant="outline" disabled={adminBusy} onClick={() => handleModerateUser(adminUser.userId, 'suspended')}>Suspend</Button>
                                                </div>
                                            ) : (
                                                <div className="text-xs text-slate-500">Only admins can moderate admin accounts.</div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                <div className="border-2 border-slate-200 rounded-xl p-4 space-y-3">
                    <h3 className="font-display text-2xl">Moderation Queue</h3>
                    <p className="text-xs text-slate-500">Force projects private with reason and review republish requests.</p>
                    <div className="space-y-3">
                        {moderationQueue.length === 0 && (
                            <div className="text-sm text-slate-500 border border-slate-200 rounded-lg px-3 py-3">No moderation items in queue.</div>
                        )}
                        {moderationQueue.map((item) => (
                            <div key={item.projectId} className="border-2 border-slate-200 rounded-xl p-4 space-y-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                        <div className="font-bold">{item.projectName || item.projectId}</div>
                                        <div className="text-xs text-slate-500">Owner: {item.ownerUserId}</div>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <span className={`px-2 py-1 rounded-full text-xs font-bold ${item.isForcedPrivate ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                                            {item.isForcedPrivate ? 'Forced Private' : item.isPublic ? 'Public' : 'Private'}
                                        </span>
                                        <span className={`px-2 py-1 rounded-full text-xs font-bold ${item.republishRequestStatus === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-700'}`}>
                                            Republish: {item.republishRequestStatus}
                                        </span>
                                    </div>
                                </div>

                                <input
                                    value={moderationReasonByProject[item.projectId] || ''}
                                    onChange={(e) => setModerationReasonByProject((prev) => ({ ...prev, [item.projectId]: e.target.value }))}
                                    placeholder="Moderation reason (required for force private)"
                                    className="w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
                                />

                                <div className="flex gap-2 flex-wrap">
                                    {!item.isForcedPrivate && (
                                        <Button
                                            variant="outline"
                                            disabled={adminBusy || !normalizeText(moderationReasonByProject[item.projectId])}
                                            onClick={() => handleForcePrivateProject(item.projectId)}
                                        >
                                            Force Private
                                        </Button>
                                    )}
                                    {item.republishRequestStatus === 'pending' && (
                                        <>
                                            <Button variant="secondary" disabled={adminBusy} onClick={() => handleReviewRepublish(item.projectId, true)}>
                                                Approve Republish
                                            </Button>
                                            <Button variant="outline" disabled={adminBusy} onClick={() => handleReviewRepublish(item.projectId, false)}>
                                                Reject Republish
                                            </Button>
                                        </>
                                    )}
                                </div>

                                {item.forcedPrivateReason && (
                                    <div className="text-xs text-slate-600">Force-private reason: {item.forcedPrivateReason}</div>
                                )}
                                {item.republishRequestReason && (
                                    <div className="text-xs text-slate-600">Republish request: {item.republishRequestReason}</div>
                                )}
                                {item.republishReviewReason && (
                                    <div className="text-xs text-slate-600">Republish review: {item.republishReviewReason}</div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {isAdmin && (
                    <>
                        <div className="bg-slate-100 p-6 rounded-xl border-4 border-black space-y-4">
                            <h3 className="font-display text-2xl">Create Coupon</h3>
                            <p className="text-xs text-slate-600">
                                Admin-only flow: enter token amount and validity duration. Code is securely generated and single-use global.
                            </p>
                            <div className="grid md:grid-cols-3 gap-3 items-end">
                                <div className="space-y-1">
                                    <label className="text-xs font-bold uppercase text-slate-500">Token Amount (CT)</label>
                                    <input
                                        value={newCouponTokenAmount}
                                        onChange={(e) => setNewCouponTokenAmount(e.target.value)}
                                        placeholder="10000"
                                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs font-bold uppercase text-slate-500">Valid For (Hours)</label>
                                    <input
                                        value={newCouponValidForHours}
                                        onChange={(e) => setNewCouponValidForHours(e.target.value)}
                                        placeholder="168"
                                        className="border-2 border-black rounded-lg px-3 py-2 font-mono text-sm"
                                    />
                                </div>
                                <Button onClick={handleCreateAdminCoupon} disabled={adminBusy}>
                                    {adminBusy ? 'Saving...' : 'Save'}
                                </Button>
                            </div>

                            {createdAdminCoupon && (
                                <div className="border-2 border-green-500 bg-green-50 rounded-lg p-4 space-y-2">
                                    <div className="text-sm font-bold text-green-800">Coupon created</div>
                                    <div className="text-sm">
                                        Code: <span className="font-mono font-bold">{createdAdminCoupon.code}</span>
                                    </div>
                                    <div className="text-xs text-slate-700">
                                        {createdAdminCoupon.tokenAmountCt.toLocaleString()} CT · Expires {new Date(createdAdminCoupon.endsAt).toLocaleString()}
                                    </div>
                                    <div>
                                        <Button
                                            variant="outline"
                                            onClick={async () => {
                                                try {
                                                    await navigator.clipboard.writeText(createdAdminCoupon.code);
                                                    setAdminActionMessage({ type: 'success', text: `Copied ${createdAdminCoupon.code} to clipboard.` });
                                                } catch {
                                                    setAdminActionMessage({ type: 'error', text: 'Unable to copy automatically. Copy the code manually.' });
                                                }
                                            }}
                                        >
                                            Copy Code
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="bg-white border-2 border-slate-200 rounded-xl overflow-auto">
                            <table className="w-full text-sm text-left min-w-[900px]">
                                <thead className="bg-slate-50 border-b-2 border-slate-200">
                                    <tr>
                                        <th className="p-3 font-bold">Code</th>
                                        <th className="p-3 font-bold">Mode</th>
                                        <th className="p-3 font-bold">Token CT</th>
                                        <th className="p-3 font-bold">Validity</th>
                                        <th className="p-3 font-bold">Usage</th>
                                        <th className="p-3 font-bold">Status</th>
                                        <th className="p-3 font-bold">First/Last Redeemed By</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {adminCouponDefinitions.length === 0 && (
                                        <tr>
                                            <td className="p-3 text-slate-500 text-sm" colSpan={7}>No coupon history found.</td>
                                        </tr>
                                    )}
                                    {adminCouponDefinitions.map((definition) => (
                                        <tr key={definition.id} className="border-b border-slate-100 last:border-0">
                                            <td className="p-3 font-mono font-bold">{definition.code}</td>
                                            <td className="p-3 text-xs uppercase">{definition.couponMode}</td>
                                            <td className="p-3 text-xs">{definition.tokenAmountCt.toLocaleString()}</td>
                                            <td className="p-3 text-xs text-slate-500">{new Date(definition.startsAt).toLocaleString()} → {new Date(definition.endsAt).toLocaleString()}</td>
                                            <td className="p-3 text-xs">{definition.redemptionCount}/{definition.maxRedemptions}</td>
                                            <td className="p-3 text-xs">
                                                <span className={`inline-flex px-2 py-1 rounded-full font-semibold uppercase ${definition.status === 'active' ? 'bg-green-100 text-green-700' : definition.status === 'expired' || definition.status === 'exhausted' ? 'bg-slate-200 text-slate-700' : 'bg-amber-100 text-amber-700'}`}>
                                                    {definition.status}
                                                </span>
                                                {definition.warningExpiresSoon && (
                                                    <span className="ml-2 text-amber-700 font-semibold">Expires &lt; 72h</span>
                                                )}
                                            </td>
                                            <td className="p-3 text-xs text-slate-600">
                                                <div>{definition.firstRedeemedBy || '-'}</div>
                                                <div>{definition.lastRedeemedBy || '-'}</div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="bg-white border-2 border-slate-200 rounded-xl overflow-auto">
                            <table className="w-full text-sm text-left min-w-[760px]">
                                <thead className="bg-slate-50 border-b-2 border-slate-200">
                                    <tr>
                                        <th className="p-3 font-bold">When</th>
                                        <th className="p-3 font-bold">Code</th>
                                        <th className="p-3 font-bold">Outcome</th>
                                        <th className="p-3 font-bold">User</th>
                                        <th className="p-3 font-bold">Token CT</th>
                                        <th className="p-3 font-bold">Reason</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {adminCouponEvents.length === 0 && (
                                        <tr>
                                            <td className="p-3 text-slate-500 text-sm" colSpan={6}>No redemption events yet.</td>
                                        </tr>
                                    )}
                                    {adminCouponEvents.slice(0, 300).map((event) => (
                                        <tr key={event.id} className="border-b border-slate-100 last:border-0">
                                            <td className="p-3 text-xs">{new Date(event.createdAt).toLocaleString()}</td>
                                            <td className="p-3 font-mono">{event.couponCode}</td>
                                            <td className="p-3 text-xs">{event.outcome}</td>
                                            <td className="p-3 text-xs text-slate-600">{event.userId || event.email || '-'}</td>
                                            <td className="p-3 text-xs">{event.tokenAmountCt?.toLocaleString?.() || '-'}</td>
                                            <td className="p-3 text-xs text-slate-500">{event.reason || '-'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {adminCouponAssignments.length > 0 && (
                            <div className="bg-white border-2 border-slate-200 rounded-xl overflow-auto">
                                <div className="px-4 py-3 text-xs font-bold uppercase border-b border-slate-200 bg-slate-50">Legacy Assignments (Read-only)</div>
                                <table className="w-full text-sm text-left min-w-[760px]">
                                    <thead className="bg-slate-50 border-b-2 border-slate-200">
                                        <tr>
                                            <th className="p-3 font-bold">Coupon</th>
                                            <th className="p-3 font-bold">Target</th>
                                            <th className="p-3 font-bold">Window</th>
                                            <th className="p-3 font-bold">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {adminCouponAssignments.map((assignment) => (
                                            <tr key={assignment.id} className="border-b border-slate-100 last:border-0">
                                                <td className="p-3 font-mono">{assignment.couponCode}</td>
                                                <td className="p-3 text-xs text-slate-600">{assignment.userId || assignment.email || '-'}</td>
                                                <td className="p-3 text-xs text-slate-600">
                                                    {new Date(assignment.startsAt).toLocaleString()} → {new Date(assignment.endsAt).toLocaleString()}
                                                </td>
                                                <td className="p-3 text-xs">
                                                    {assignment.revokedAt
                                                        ? 'Revoked'
                                                        : assignment.isRedeemed
                                                            ? `Redeemed ${assignment.redeemedAt ? new Date(assignment.redeemedAt).toLocaleString() : ''}`
                                                            : assignment.isActive ? 'Assigned' : 'Inactive'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </div>
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

    const renderSettings = () => {
        const modelKeys = getAllModelKeys();
        const entitlements = buildModelEntitlements(billingSummary);
        const imageModelOptions = getAllowedImageModelsForPlan(entitlements.planTier);
        const textModelLabelMap = new Map(TEXT_MODELS.map((model) => [model.id, model.label]));
        const textModelOptions = getAllowedTextModelIdsForPlan(entitlements.planTier);
        const imageModelIds = new Set(imageModelOptions.map((model) => model.id));
        const textModelIds = new Set(textModelOptions);
        const selectedImageModel = imageModelIds.has(settingsState.defaultImageModel || '')
            ? settingsState.defaultImageModel
            : entitlements.defaultImageModelId;
        const requestedTextModel = settingsState.defaultTextModel || settingsState.defaultTextModelKey || TEXT_MODEL;
        const selectedTextModel = textModelIds.has(requestedTextModel) ? requestedTextModel : entitlements.defaultTextModelId;

        const saveSettings = (next: ReturnType<typeof getSettingsState>) => {
            setSettingsState(next);
            persistSettingsState(next);
        };

        return (
            <div className="space-y-6 animate-fade-in max-w-3xl">
                <ApiConfiguration />
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
                    <NavButton icon={<Shield size={18} />} label="Legal" active={activeTab === 'legal'} onClick={() => setActiveTab('legal')} />
                    <NavButton icon={<Mail size={18} />} label="Contact" active={activeTab === 'contact'} onClick={() => setActiveTab('contact')} />
                    {(isAdmin || isModerator) && (
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
