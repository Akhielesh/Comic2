import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Activity,
    AlertTriangle,
    BadgeCheck,
    CheckCircle2,
    ChevronRight,
    FlaskConical,
    Gauge,
    Loader2,
    Mail,
    MonitorPlay,
    RefreshCw,
    Shield,
    ShieldAlert,
    Ticket,
    UserCog,
    Users
} from 'lucide-react';
import { Button } from '../Button';
import { VerificationCenter } from '../VerificationCenter';
import { AdminAnalytics } from './AdminAnalytics';
import { InviteManager } from './InviteManager';
import { EmailConsole } from './EmailConsole';
import { ProductAccessPanel } from './ProductAccessPanel';
import type {
    AdminAccessResponse,
    AdminCouponAssignment,
    AdminCouponDefinition,
    AdminCouponRedemptionEvent,
    AdminUserRecord,
    BillingPlanTier,
    ProjectModerationQueueItem
} from '../../shared/types/billing';
import {
    approveProjectRepublish,
    createAdminCouponDefinition,
    forceProjectPrivate,
    listAdminCoupons,
    listAdminCouponsByCursor,
    listAdminUsers,
    listModerationQueue,
    moderateUser,
    updateAdminUserPlan,
    updateAdminUserRole
} from '../../services/billing';
import { getEmailUsage, listEmailTemplates, type EmailUsage } from '../../services/adminEmail';
import { getAnalyticsOverview } from '../../services/adminAnalytics';
import { patchUrlParams, persistUiState, resolveInitialUiState } from '../../services/viewState';

type AdminSection =
    | 'overview'
    | 'users'
    | 'moderation'
    | 'invites'
    | 'studios'
    | 'email'
    | 'analytics'
    | 'coupons'
    | 'verification';

const SECTIONS: Array<{ id: AdminSection; label: string; icon: React.ReactNode; adminOnly?: boolean }> = [
    { id: 'overview', label: 'Overview', icon: <Gauge size={15} /> },
    { id: 'users', label: 'Users', icon: <Users size={15} /> },
    { id: 'moderation', label: 'Moderation', icon: <ShieldAlert size={15} /> },
    { id: 'invites', label: 'Invites', icon: <Ticket size={15} />, adminOnly: true },
    // adminOnly: /api/admin/product-access is mounted behind requireAdmin.
    { id: 'studios', label: 'Studios', icon: <MonitorPlay size={15} />, adminOnly: true },
    { id: 'email', label: 'Email', icon: <Mail size={15} />, adminOnly: true },
    // adminOnly: the server mounts /api/admin/analytics/* behind requireAdmin, so the
    // section would render nothing but 403s for moderators.
    { id: 'analytics', label: 'Analytics', icon: <Activity size={15} />, adminOnly: true },
    { id: 'coupons', label: 'Coupons', icon: <BadgeCheck size={15} />, adminOnly: true },
    { id: 'verification', label: 'Verification', icon: <CheckCircle2 size={15} />, adminOnly: true }
];

const isAdminSection = (value: string): value is AdminSection =>
    SECTIONS.some((section) => section.id === value);

type MessageState = { type: 'success' | 'error'; text: string } | null;

const normalizeText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

interface AdminConsoleProps {
    isAdmin: boolean;
    isModerator: boolean;
    adminAccess: AdminAccessResponse | null;
    onNavigate?: (view: string) => void;
    /** Called after actions that change billing-relevant state (e.g. the operator's own
     *  plan), so the host can refresh its billing summary/entitlements immediately. */
    onBillingShouldRefresh?: () => void;
}

/** Small framed stat used across the console. */
const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({ label, value, tone = 'bg-white' }) => (
    <div className={`border-2 border-black rounded-xl px-3 py-2.5 ${tone}`}>
        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</div>
        <div className="font-display text-xl leading-tight mt-0.5">{value}</div>
    </div>
);

/** Health row: green when ok, amber when degraded, red when broken. */
const HealthRow: React.FC<{ ok: boolean | null; label: string; detail: string; warn?: boolean }> = ({ ok, label, detail, warn }) => {
    const tone = ok === null
        ? 'bg-slate-100 text-slate-500 border-slate-300'
        : ok
            ? 'bg-green-50 text-green-800 border-green-500'
            : warn
                ? 'bg-amber-50 text-amber-800 border-amber-500'
                : 'bg-red-50 text-red-700 border-red-500';
    const Icon = ok === null ? Loader2 : ok ? CheckCircle2 : AlertTriangle;
    return (
        <div className={`flex items-start gap-2.5 border-2 rounded-lg px-3 py-2 ${tone}`}>
            <Icon size={16} className={`mt-0.5 shrink-0 ${ok === null ? 'animate-spin' : ''}`} />
            <div className="min-w-0">
                <div className="text-sm font-bold leading-tight">{label}</div>
                <div className="text-xs opacity-80 leading-snug">{detail}</div>
            </div>
        </div>
    );
};

const sectionMotion = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -6 },
    transition: { duration: 0.18, ease: 'easeOut' as const }
};

export const AdminConsole: React.FC<AdminConsoleProps> = ({ isAdmin, isModerator, adminAccess, onNavigate, onBillingShouldRefresh }) => {
    const visibleSections = useMemo(
        () => SECTIONS.filter((section) => isAdmin || !section.adminOnly),
        [isAdmin]
    );

    const [section, setSection] = useState<AdminSection>(() => {
        const initial = resolveInitialUiState<AdminSection>('settings.admin.section', 'section', isAdminSection, 'overview');
        return visibleSections.some((s) => s.id === initial) ? initial : 'overview';
    });

    const selectSection = (next: AdminSection) => {
        setSection(next);
        persistUiState('settings.admin.section', 'section', next);
    };

    // Leaving the console (unmount) drops the ?section= param so other settings tabs
    // don't carry a stale admin deep-link around. Session memory is kept on purpose —
    // reopening the console returns to the section the operator was working in.
    useEffect(() => () => patchUrlParams({ section: null }), []);

    // ----- governance data (users + moderation queue) -----
    const [adminUsers, setAdminUsers] = useState<AdminUserRecord[]>([]);
    const [moderationQueue, setModerationQueue] = useState<ProjectModerationQueueItem[]>([]);
    const [adminUserQuery, setAdminUserQuery] = useState('');
    // Debounced copy of the search box: data loads key on this, so typing doesn't fire a
    // request pair per keystroke (and tear down / re-arm the polling interval each time).
    const [debouncedUserQuery, setDebouncedUserQuery] = useState('');
    useEffect(() => {
        const id = window.setTimeout(() => setDebouncedUserQuery(adminUserQuery), 350);
        return () => window.clearTimeout(id);
    }, [adminUserQuery]);
    const userQueryRef = useRef(adminUserQuery);
    userQueryRef.current = adminUserQuery;
    const [moderationReasonByProject, setModerationReasonByProject] = useState<Record<string, string>>({});
    const [moderationReasonByUser, setModerationReasonByUser] = useState<Record<string, string>>({});
    const [message, setMessage] = useState<MessageState>(null);
    const [busy, setBusy] = useState(false);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

    // ----- coupons -----
    const [couponDefinitions, setCouponDefinitions] = useState<AdminCouponDefinition[]>([]);
    const [couponAssignments, setCouponAssignments] = useState<AdminCouponAssignment[]>([]);
    const [couponEvents, setCouponEvents] = useState<AdminCouponRedemptionEvent[]>([]);
    const [newCouponTokenAmount, setNewCouponTokenAmount] = useState('10000');
    const [newCouponValidForHours, setNewCouponValidForHours] = useState('168');
    const [createdCoupon, setCreatedCoupon] = useState<AdminCouponDefinition | null>(null);

    // ----- platform health (overview) -----
    const [emailConfigured, setEmailConfigured] = useState<boolean | null>(null);
    const [emailUsage, setEmailUsage] = useState<EmailUsage | null>(null);
    const [telemetryEnabled, setTelemetryEnabled] = useState<boolean | null>(null);
    const [failures24h, setFailures24h] = useState<number | null>(null);

    const loadGovernance = useCallback(async () => {
        const requestedQuery = debouncedUserQuery.trim();
        const [userResult, queueResult] = await Promise.all([
            listAdminUsers({ q: requestedQuery || undefined, limit: 100 }),
            listModerationQueue({ limit: 100 })
        ]);
        // Stale-response guard: a slow response for an old prefix must not clobber the
        // list the user is currently filtering for.
        if (requestedQuery === userQueryRef.current.trim()) {
            setAdminUsers(userResult.items || []);
        }
        setModerationQueue(queueResult.items || []);
        setLastRefreshedAt(new Date().toISOString());
    }, [debouncedUserQuery]);

    const loadCoupons = useCallback(async () => {
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
        setCouponDefinitions(definitionRows);
        setCouponAssignments(firstPage.assignments);
        setCouponEvents(firstPage.events);
        setLastRefreshedAt(new Date().toISOString());
    }, []);

    const loadHealth = useCallback(async () => {
        if (!isAdmin) return;
        const [templates, usage, overview] = await Promise.allSettled([
            listEmailTemplates(),
            getEmailUsage(),
            getAnalyticsOverview(1)
        ]);
        if (usage.status === 'fulfilled') {
            setEmailUsage(usage.value);
            setEmailConfigured(usage.value.configured);
        } else if (templates.status === 'fulfilled') {
            setEmailConfigured(templates.value.configured);
        } else {
            setEmailConfigured(false);
        }
        if (overview.status === 'fulfilled') {
            setTelemetryEnabled(overview.value.storageEnabled);
            setFailures24h(overview.value.totals.failures);
        } else {
            setTelemetryEnabled(false);
        }
    }, [isAdmin]);

    // Load + poll only the data the open section needs, and pause while the browser tab
    // is hidden — with an immediate catch-up tick on refocus, so returning to the tab
    // shows fresh data instead of waiting out the interval. Governance (users + queue)
    // loads in EVERY section: it's two light requests and it keeps the pending-moderation
    // badge on the section rail honest while the operator works elsewhere.
    useEffect(() => {
        if (!isAdmin && !isModerator) return; // defense in depth — host also gates mount
        let alive = true;
        let inFlight = false;

        const needsCoupons = isAdmin && section === 'coupons';
        const needsHealth = isAdmin && section === 'overview';

        const tick = async () => {
            if (inFlight || document.hidden) return;
            inFlight = true;
            try {
                await loadGovernance();
                if (needsCoupons) await loadCoupons();
                if (needsHealth) await loadHealth();
            } catch (err: any) {
                if (alive) setMessage({ type: 'error', text: err?.message || 'Failed to load admin data.' });
            } finally {
                inFlight = false;
            }
        };

        void tick();
        const timer = window.setInterval(() => void tick(), 20_000);
        const onVisible = () => {
            if (!document.hidden) void tick();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            alive = false;
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [section, isAdmin, isModerator, loadGovernance, loadCoupons, loadHealth]);

    const refreshNow = async () => {
        setBusy(true);
        try {
            await loadGovernance();
            if (isAdmin) {
                await loadCoupons();
                await loadHealth();
            }
            setMessage(null);
        } catch (err: any) {
            setMessage({ type: 'error', text: err?.message || 'Failed to refresh admin data.' });
        } finally {
            setBusy(false);
        }
    };

    const runAction = async (action: () => Promise<void>, successText: string) => {
        setBusy(true);
        setMessage(null);
        try {
            await action();
            setMessage({ type: 'success', text: successText });
        } catch (err: any) {
            setMessage({ type: 'error', text: err?.message || 'Action failed.' });
        } finally {
            setBusy(false);
        }
    };

    const handlePlanChange = (userId: string, planTier: BillingPlanTier) =>
        runAction(async () => {
            await updateAdminUserPlan({ userId, planTier });
            await loadGovernance();
            // The operator may have changed their OWN plan — refresh the host's billing
            // summary so entitlements (default models, limits) re-validate immediately.
            onBillingShouldRefresh?.();
        }, 'Plan updated.');

    const handleRemovePlanStatus = (userId: string) =>
        runAction(async () => {
            await updateAdminUserPlan({ userId, removePlanStatus: true });
            await loadGovernance();
            onBillingShouldRefresh?.();
        }, 'Plan status removed.');

    const handleRoleChange = (userId: string, role: 'admin' | 'moderator', action: 'grant' | 'revoke') =>
        runAction(async () => {
            await updateAdminUserRole({ userId, role, action });
            await loadGovernance();
        }, `Role ${action === 'grant' ? 'granted' : 'revoked'}.`);

    // Each action consumes its reason input: a stale reason left in the box would
    // otherwise be silently attached to the NEXT action on the same user/project,
    // corrupting the moderation audit trail.
    const handleModerateUser = (userId: string, status: 'active' | 'restricted' | 'suspended') =>
        runAction(async () => {
            await moderateUser({ userId, status, reason: normalizeText(moderationReasonByUser[userId]) || undefined });
            setModerationReasonByUser((prev) => ({ ...prev, [userId]: '' }));
            await loadGovernance();
        }, `User set to ${status}.`);

    const handleForcePrivate = (projectId: string) =>
        runAction(async () => {
            await forceProjectPrivate({ projectId, reason: normalizeText(moderationReasonByProject[projectId]) });
            setModerationReasonByProject((prev) => ({ ...prev, [projectId]: '' }));
            await loadGovernance();
        }, 'Project forced private.');

    const handleReviewRepublish = (projectId: string, approve: boolean) =>
        runAction(async () => {
            await approveProjectRepublish({ projectId, approve, reason: normalizeText(moderationReasonByProject[projectId]) || undefined });
            setModerationReasonByProject((prev) => ({ ...prev, [projectId]: '' }));
            await loadGovernance();
        }, approve ? 'Republish approved.' : 'Republish rejected.');

    const handleCreateCoupon = () =>
        runAction(async () => {
            const tokenAmountCt = Math.floor(Number(newCouponTokenAmount));
            const validForHours = Math.floor(Number(newCouponValidForHours));
            if (!Number.isFinite(tokenAmountCt) || tokenAmountCt <= 0) throw new Error('Token amount must be a positive number.');
            if (!Number.isFinite(validForHours) || validForHours <= 0) throw new Error('Validity must be a positive number of hours.');
            const coupon = await createAdminCouponDefinition({ tokenAmountCt, validForHours });
            setCreatedCoupon(coupon);
            await loadCoupons();
        }, 'Coupon created.');

    const pendingModeration = moderationQueue.filter((item) => item.republishRequestStatus === 'pending').length;
    const planOptions: BillingPlanTier[] = ['free', 'creator', 'studio', 'custom', 'admin'];

    const renderOverview = () => (
        <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Users loaded" value={adminUsers.length} />
                <Stat label="Moderation queue" value={moderationQueue.length} tone={moderationQueue.length ? 'bg-amber-50' : 'bg-white'} />
                <Stat label="Pending republish" value={pendingModeration} tone={pendingModeration ? 'bg-amber-50' : 'bg-white'} />
                {isAdmin
                    ? <Stat label="Failures (24h)" value={failures24h ?? '—'} tone={failures24h ? 'bg-red-50' : 'bg-white'} />
                    : <Stat label="Coupons" value="Admin only" />}
            </div>

            {isAdmin && (
                <div className="border-2 border-black rounded-xl bg-white p-4 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="font-display text-xl flex items-center gap-2"><Activity size={18} /> System health</h3>
                        <span className="text-[11px] text-slate-500">live checks against the platform services</span>
                    </div>
                    <div className="grid md:grid-cols-2 gap-2">
                        <HealthRow
                            ok={emailConfigured}
                            label={emailConfigured === false ? 'Email delivery not configured' : 'Email delivery'}
                            detail={emailConfigured
                                ? `Worker connected. Sent today ${emailUsage?.day ?? '—'}/${emailUsage?.maxPerDay ?? '—'} · month ${emailUsage?.month ?? '—'}/${emailUsage?.maxPerMonth ?? '—'}.`
                                : emailConfigured === null
                                    ? 'Checking the email worker configuration…'
                                    : 'EMAIL_WORKER_URL / EMAIL_HMAC_SECRET missing — sends are silently skipped. See docs/email/SETUP.md.'}
                        />
                        <HealthRow
                            ok={telemetryEnabled}
                            warn
                            label={telemetryEnabled === false ? 'Telemetry persistence off' : 'Telemetry & feedback'}
                            detail={telemetryEnabled
                                ? 'Events and feedback are being persisted; analytics reflect live data.'
                                : telemetryEnabled === null
                                    ? 'Checking telemetry storage…'
                                    : 'SUPABASE_SERVICE_ROLE_KEY missing or schema not applied — analytics show empty data.'}
                        />
                    </div>
                </div>
            )}

            <div className="grid md:grid-cols-2 gap-3">
                <button
                    onClick={() => selectSection('moderation')}
                    className="group text-left border-2 border-black rounded-xl bg-white p-4 hover:bg-amber-50 transition-colors"
                >
                    <div className="flex items-center justify-between">
                        <h4 className="font-display text-lg flex items-center gap-2"><ShieldAlert size={17} /> Review moderation queue</h4>
                        <ChevronRight size={16} className="transition-transform group-hover:translate-x-1" />
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                        {pendingModeration > 0
                            ? `${pendingModeration} republish request${pendingModeration === 1 ? '' : 's'} awaiting review.`
                            : 'No pending republish requests.'}
                    </p>
                </button>
                <button
                    onClick={() => onNavigate?.('test')}
                    className="group text-left border-2 border-black rounded-xl bg-white p-4 hover:bg-purple-50 transition-colors"
                >
                    <div className="flex items-center justify-between">
                        <h4 className="font-display text-lg flex items-center gap-2"><FlaskConical size={17} /> Launch Test Lab</h4>
                        <ChevronRight size={16} className="transition-transform group-hover:translate-x-1" />
                    </div>
                    <p className="text-xs text-slate-500 mt-1">Restricted model-consistency environment — strict limits, no token burn, full audit.</p>
                </button>
            </div>
        </div>
    );

    const renderUsers = () => (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-500">Search users, manage plans and roles, apply account moderation.</p>
                <input
                    value={adminUserQuery}
                    onChange={(e) => setAdminUserQuery(e.target.value)}
                    placeholder="Search by username or email"
                    className="w-full md:w-72 border-2 border-black rounded-lg px-3 py-2 font-mono text-sm bg-white"
                />
            </div>

            <div className="space-y-3">
                {adminUsers.length === 0 && (
                    <div className="text-sm text-slate-500 border-2 border-dashed border-slate-300 rounded-xl px-4 py-6 text-center">No users found.</div>
                )}
                {adminUsers.map((adminUser) => {
                    const isTargetAdmin = adminUser.roles.includes('admin');
                    const canModerateTarget = isAdmin || !isTargetAdmin;
                    return (
                        <div key={adminUser.userId} className="border-2 border-black rounded-xl bg-white p-4 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <div className="w-9 h-9 shrink-0 rounded-full border-2 border-black bg-slate-100 flex items-center justify-center font-display">
                                        {(adminUser.username || '?').slice(0, 1).toUpperCase()}
                                    </div>
                                    <div className="min-w-0">
                                        <div className="font-bold truncate">{adminUser.username || '(no username)'}</div>
                                        <div className="text-xs text-slate-500 truncate">{adminUser.email || adminUser.maskedEmail || adminUser.userId}</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    {adminUser.roles.map((role) => (
                                        <span key={role} className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border border-black ${role === 'admin' ? 'bg-green-200' : 'bg-blue-200'}`}>
                                            {role}
                                        </span>
                                    ))}
                                    <span className="text-[11px] text-slate-500">
                                        Joined {adminUser.createdAt ? new Date(adminUser.createdAt).toLocaleDateString() : 'n/a'}
                                    </span>
                                </div>
                            </div>

                            <div className="grid md:grid-cols-3 gap-3">
                                <div className="border border-slate-300 rounded-lg p-3 space-y-2 bg-slate-50/60">
                                    <div className="text-[10px] font-bold uppercase text-slate-500">Plan · {adminUser.planTier}</div>
                                    {isAdmin ? (
                                        <>
                                            <select
                                                value={adminUser.planTier}
                                                onChange={(e) => void handlePlanChange(adminUser.userId, e.target.value as BillingPlanTier)}
                                                className="w-full border-2 border-black rounded px-2 py-1 text-sm bg-white"
                                                disabled={busy}
                                            >
                                                {adminUser.planTier === 'pro' && <option value="pro">pro (legacy)</option>}
                                                {planOptions.map((planTier) => (
                                                    <option key={planTier} value={planTier}>{planTier}</option>
                                                ))}
                                            </select>
                                            <Button
                                                variant="outline"
                                                disabled={busy || adminUser.planTier === 'free'}
                                                onClick={() => void handleRemovePlanStatus(adminUser.userId)}
                                            >
                                                Remove Plan Status
                                            </Button>
                                        </>
                                    ) : (
                                        <div className="text-xs text-slate-500">Only admins can change plans.</div>
                                    )}
                                </div>

                                <div className="border border-slate-300 rounded-lg p-3 space-y-2 bg-slate-50/60">
                                    <div className="text-[10px] font-bold uppercase text-slate-500">Roles</div>
                                    {isAdmin ? (
                                        <div className="flex gap-2 flex-wrap">
                                            <Button
                                                variant="outline"
                                                disabled={busy}
                                                onClick={() => void handleRoleChange(adminUser.userId, 'moderator', adminUser.roles.includes('moderator') ? 'revoke' : 'grant')}
                                            >
                                                {adminUser.roles.includes('moderator') ? 'Revoke Moderator' : 'Grant Moderator'}
                                            </Button>
                                            <Button
                                                variant="outline"
                                                disabled={busy}
                                                onClick={() => void handleRoleChange(adminUser.userId, 'admin', adminUser.roles.includes('admin') ? 'revoke' : 'grant')}
                                            >
                                                {adminUser.roles.includes('admin') ? 'Revoke Admin' : 'Grant Admin'}
                                            </Button>
                                        </div>
                                    ) : (
                                        <div className="text-xs text-slate-500">Moderators cannot assign roles.</div>
                                    )}
                                </div>

                                <div className="border border-slate-300 rounded-lg p-3 space-y-2 bg-slate-50/60">
                                    <div className="text-[10px] font-bold uppercase text-slate-500">Account status · {adminUser.moderationStatus}</div>
                                    <input
                                        value={moderationReasonByUser[adminUser.userId] || ''}
                                        onChange={(e) => setModerationReasonByUser((prev) => ({ ...prev, [adminUser.userId]: e.target.value }))}
                                        placeholder="Reason (optional)"
                                        className="w-full border-2 border-black rounded px-2 py-1 text-xs bg-white"
                                    />
                                    {canModerateTarget ? (
                                        <div className="flex gap-2 flex-wrap">
                                            <Button variant="outline" disabled={busy} onClick={() => void handleModerateUser(adminUser.userId, 'active')}>Activate</Button>
                                            <Button variant="outline" disabled={busy} onClick={() => void handleModerateUser(adminUser.userId, 'restricted')}>Restrict</Button>
                                            <Button variant="outline" disabled={busy} onClick={() => void handleModerateUser(adminUser.userId, 'suspended')}>Suspend</Button>
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
    );

    const renderModeration = () => (
        <div className="space-y-4">
            <p className="text-xs text-slate-500">Force projects private (reason required) and review republish requests.</p>
            <div className="space-y-3">
                {moderationQueue.length === 0 && (
                    <div className="text-sm text-slate-500 border-2 border-dashed border-slate-300 rounded-xl px-4 py-6 text-center">
                        Queue is clear — no moderation items.
                    </div>
                )}
                {moderationQueue.map((item) => (
                    <div key={item.projectId} className="border-2 border-black rounded-xl bg-white p-4 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <div className="font-bold">{item.projectName || item.projectId}</div>
                                <div className="text-xs text-slate-500">Owner: {item.ownerUserId}</div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <span className={`px-2 py-1 rounded-full text-xs font-bold border border-black ${item.isForcedPrivate ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                                    {item.isForcedPrivate ? 'Forced Private' : item.isPublic ? 'Public' : 'Private'}
                                </span>
                                <span className={`px-2 py-1 rounded-full text-xs font-bold border border-black ${item.republishRequestStatus === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
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
                                    disabled={busy || !normalizeText(moderationReasonByProject[item.projectId])}
                                    onClick={() => void handleForcePrivate(item.projectId)}
                                >
                                    Force Private
                                </Button>
                            )}
                            {item.republishRequestStatus === 'pending' && (
                                <>
                                    <Button variant="secondary" disabled={busy} onClick={() => void handleReviewRepublish(item.projectId, true)}>
                                        Approve Republish
                                    </Button>
                                    <Button variant="outline" disabled={busy} onClick={() => void handleReviewRepublish(item.projectId, false)}>
                                        Reject Republish
                                    </Button>
                                </>
                            )}
                        </div>

                        {item.forcedPrivateReason && <div className="text-xs text-slate-600">Force-private reason: {item.forcedPrivateReason}</div>}
                        {item.republishRequestReason && <div className="text-xs text-slate-600">Republish request: {item.republishRequestReason}</div>}
                        {item.republishReviewReason && <div className="text-xs text-slate-600">Republish review: {item.republishReviewReason}</div>}
                    </div>
                ))}
            </div>
        </div>
    );

    const renderCoupons = () => (
        <div className="space-y-4">
            <div className="border-2 border-black rounded-xl bg-slate-50 p-4 space-y-3">
                <div>
                    <h3 className="font-display text-xl">Create coupon</h3>
                    <p className="text-xs text-slate-600">Securely generated, single-use global code.</p>
                </div>
                <div className="grid md:grid-cols-3 gap-3 items-end">
                    <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase text-slate-500">Token Amount (CT)</label>
                        <input
                            value={newCouponTokenAmount}
                            onChange={(e) => setNewCouponTokenAmount(e.target.value)}
                            placeholder="10000"
                            className="w-full border-2 border-black rounded-lg px-3 py-2 font-mono text-sm bg-white"
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase text-slate-500">Valid For (Hours)</label>
                        <input
                            value={newCouponValidForHours}
                            onChange={(e) => setNewCouponValidForHours(e.target.value)}
                            placeholder="168"
                            className="w-full border-2 border-black rounded-lg px-3 py-2 font-mono text-sm bg-white"
                        />
                    </div>
                    <Button onClick={() => void handleCreateCoupon()} disabled={busy}>
                        {busy ? 'Saving…' : 'Create Coupon'}
                    </Button>
                </div>

                {createdCoupon && (
                    <div className="border-2 border-green-500 bg-green-50 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <div className="text-sm font-bold text-green-800">
                                Coupon created: <span className="font-mono">{createdCoupon.code}</span>
                            </div>
                            <div className="text-xs text-slate-700">
                                {createdCoupon.tokenAmountCt.toLocaleString()} CT · Expires {new Date(createdCoupon.endsAt).toLocaleString()}
                            </div>
                        </div>
                        <Button
                            variant="outline"
                            onClick={async () => {
                                try {
                                    await navigator.clipboard.writeText(createdCoupon.code);
                                    setMessage({ type: 'success', text: `Copied ${createdCoupon.code} to clipboard.` });
                                } catch {
                                    setMessage({ type: 'error', text: 'Unable to copy automatically. Copy the code manually.' });
                                }
                            }}
                        >
                            Copy Code
                        </Button>
                    </div>
                )}
            </div>

            <div className="bg-white border-2 border-black rounded-xl overflow-auto">
                <div className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide border-b-2 border-black bg-slate-50">Coupon definitions</div>
                <table className="w-full text-sm text-left min-w-[900px]">
                    <thead className="bg-slate-50 border-b border-slate-200">
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
                        {couponDefinitions.length === 0 && (
                            <tr><td className="p-3 text-slate-500 text-sm" colSpan={7}>No coupon history found.</td></tr>
                        )}
                        {couponDefinitions.map((definition) => (
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
                                    {definition.warningExpiresSoon && <span className="ml-2 text-amber-700 font-semibold">Expires &lt; 72h</span>}
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

            <div className="bg-white border-2 border-black rounded-xl overflow-auto">
                <div className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide border-b-2 border-black bg-slate-50">Redemption events</div>
                <table className="w-full text-sm text-left min-w-[760px]">
                    <thead className="bg-slate-50 border-b border-slate-200">
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
                        {couponEvents.length === 0 && (
                            <tr><td className="p-3 text-slate-500 text-sm" colSpan={6}>No redemption events yet.</td></tr>
                        )}
                        {couponEvents.slice(0, 300).map((event) => (
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

            {couponAssignments.length > 0 && (
                <div className="bg-white border-2 border-black rounded-xl overflow-auto">
                    <div className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide border-b-2 border-black bg-slate-50">Legacy assignments (read-only)</div>
                    <table className="w-full text-sm text-left min-w-[760px]">
                        <thead className="bg-slate-50 border-b border-slate-200">
                            <tr>
                                <th className="p-3 font-bold">Coupon</th>
                                <th className="p-3 font-bold">Target</th>
                                <th className="p-3 font-bold">Window</th>
                                <th className="p-3 font-bold">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {couponAssignments.map((assignment) => (
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
        </div>
    );

    return (
        <div className="space-y-4">
            {/* Console header: identity + section switcher in one calm bar. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border-2 border-black bg-brand-yellow">
                        <Shield size={13} /> {isAdmin ? 'Admin' : 'Moderator'}
                    </span>
                    {adminAccess?.bootstrapAdmin && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border-2 border-black bg-amber-100 text-amber-800">
                            <UserCog size={13} /> Bootstrap
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span>{lastRefreshedAt ? `Updated ${new Date(lastRefreshedAt).toLocaleTimeString()}` : 'Loading…'}</span>
                    <button
                        onClick={() => void refreshNow()}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 border-2 border-black rounded-lg px-2.5 py-1 font-bold bg-white hover:bg-slate-100 disabled:opacity-50 transition-colors"
                    >
                        <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Refresh
                    </button>
                </div>
            </div>

            {/* Section navigation: a single scrollable rail replaces the old wall of stacked panels. */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1" role="tablist" aria-label="Admin console sections">
                {visibleSections.map((entry) => {
                    const active = section === entry.id;
                    const badge = entry.id === 'moderation' && pendingModeration > 0 ? pendingModeration : null;
                    return (
                        <button
                            key={entry.id}
                            role="tab"
                            aria-selected={active}
                            onClick={() => selectSection(entry.id)}
                            className={`relative shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border-2 text-sm font-bold transition-colors ${active ? 'border-black bg-black text-white' : 'border-transparent text-slate-500 hover:text-black hover:bg-slate-100'}`}
                        >
                            {active && (
                                <motion.span
                                    layoutId="admin-section-pill"
                                    className="absolute inset-0 rounded-xl border-2 border-black bg-black -z-10"
                                    transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                                />
                            )}
                            {entry.icon}
                            {entry.label}
                            {badge !== null && (
                                <span className={`min-w-[18px] h-[18px] inline-flex items-center justify-center rounded-full text-[10px] px-1 ${active ? 'bg-brand-yellow text-black' : 'bg-amber-400 text-black'}`}>
                                    {badge}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {message && (
                <div className={`border-2 rounded-lg px-3 py-2 text-sm font-semibold flex items-center gap-2 ${message.type === 'success' ? 'border-green-500 bg-green-50 text-green-700' : 'border-red-500 bg-red-50 text-red-700'}`}>
                    {message.type === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />} {message.text}
                </div>
            )}

            <AnimatePresence mode="wait">
                <motion.div key={section} {...sectionMotion}>
                    {section === 'overview' && renderOverview()}
                    {section === 'users' && renderUsers()}
                    {section === 'moderation' && renderModeration()}
                    {section === 'invites' && isAdmin && (
                        <div className="border-2 border-black rounded-xl bg-white"><InviteManager /></div>
                    )}
                    {section === 'studios' && isAdmin && (
                        <div className="border-2 border-black rounded-xl bg-white"><ProductAccessPanel /></div>
                    )}
                    {section === 'email' && isAdmin && (
                        <div className="border-2 border-black rounded-xl bg-white"><EmailConsole /></div>
                    )}
                    {section === 'analytics' && (
                        <div className="border-2 border-black rounded-xl bg-white"><AdminAnalytics /></div>
                    )}
                    {section === 'coupons' && isAdmin && renderCoupons()}
                    {section === 'verification' && isAdmin && (
                        <div className="border-2 border-black rounded-xl bg-white"><VerificationCenter /></div>
                    )}
                </motion.div>
            </AnimatePresence>
        </div>
    );
};
