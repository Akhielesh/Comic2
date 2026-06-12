import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Activity,
    AlertTriangle,
    Ban,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
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
    AdminUserRecord,
    ProjectModerationQueueItem,
    UserRole
} from '../../shared/types/billing';
import {
    approveProjectRepublish,
    forceProjectPrivate,
    listAdminUsers,
    listModerationQueue,
    moderateUser,
    updateAdminUserRole
} from '../../services/billing';
import {
    adminResetProductAccess,
    adminSetProductAccess,
    invalidateProductAccess,
    PRODUCT_IDS,
    PRODUCT_LABELS,
    type ProductId
} from '../../services/productAccess';
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
    { id: 'verification', label: 'Verification', icon: <CheckCircle2 size={15} />, adminOnly: true }
];

const isAdminSection = (value: string): value is AdminSection =>
    SECTIONS.some((section) => section.id === value);

type MessageState = { type: 'success' | 'error'; text: string } | null;

const normalizeText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Short chip labels for the per-studio access column. */
const PRODUCT_CHIP_LABEL: Record<ProductId, string> = {
    stream_studio: 'Stream',
    comic_studio: 'Comic',
    chat_studio: 'Chat'
};

/** Single visible role for the table's select: admin wins over moderator. */
type RoleValue = 'admin' | 'moderator' | 'none';
const roleValueOf = (roles: UserRole[]): RoleValue =>
    roles.includes('admin') ? 'admin' : roles.includes('moderator') ? 'moderator' : 'none';

interface AdminConsoleProps {
    isAdmin: boolean;
    isModerator: boolean;
    adminAccess: AdminAccessResponse | null;
    onNavigate?: (view: string) => void;
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

export const AdminConsole: React.FC<AdminConsoleProps> = ({ isAdmin, isModerator, adminAccess, onNavigate }) => {
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
    const [message, setMessage] = useState<MessageState>(null);
    const [busy, setBusy] = useState(false);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

    // ----- users table: inline "Studios…" expander -----
    const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
    const [busyStudioKey, setBusyStudioKey] = useState<string | null>(null); // `${userId}:${product}`
    // Invite-email options applied when granting from the expander (reset per user).
    const [sendInvite, setSendInvite] = useState(false);
    const [inviterName, setInviterName] = useState('');
    const [personalNote, setPersonalNote] = useState('');

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

        const needsHealth = isAdmin && section === 'overview';

        const tick = async () => {
            if (inFlight || document.hidden) return;
            inFlight = true;
            try {
                await loadGovernance();
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
    }, [section, isAdmin, isModerator, loadGovernance, loadHealth]);

    const refreshNow = async () => {
        setBusy(true);
        try {
            await loadGovernance();
            if (isAdmin) await loadHealth();
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

    // Single-role model: setting a role grants it and revokes the other one, so the
    // select always reflects reality on the next refresh. Grants run before revokes so
    // the server's "last active admin" guard can still abort safely mid-change.
    const handleRoleSelect = (adminUser: AdminUserRecord, next: RoleValue) =>
        runAction(async () => {
            const has = (role: UserRole) => adminUser.roles.includes(role);
            const ops: Array<{ role: UserRole; action: 'grant' | 'revoke' }> = [];
            if (next === 'admin') {
                if (!has('admin')) ops.push({ role: 'admin', action: 'grant' });
                if (has('moderator')) ops.push({ role: 'moderator', action: 'revoke' });
            } else if (next === 'moderator') {
                if (!has('moderator')) ops.push({ role: 'moderator', action: 'grant' });
                if (has('admin')) ops.push({ role: 'admin', action: 'revoke' });
            } else {
                if (has('moderator')) ops.push({ role: 'moderator', action: 'revoke' });
                if (has('admin')) ops.push({ role: 'admin', action: 'revoke' });
            }
            for (const op of ops) {
                await updateAdminUserRole({ userId: adminUser.userId, role: op.role, action: op.action });
            }
            await loadGovernance();
        }, 'Role updated.');

    const handleSuspendToggle = (adminUser: AdminUserRecord) => {
        const suspend = adminUser.moderationStatus !== 'suspended';
        return runAction(async () => {
            await moderateUser({ userId: adminUser.userId, status: suspend ? 'suspended' : 'active' });
            await loadGovernance();
        }, suspend ? 'User suspended.' : 'User reactivated.');
    };

    // Same grant/revoke call as the Studios panel (POST /api/admin/product-access),
    // including the optional invite email. Honest outcomes: the server reports
    // alreadyGranted instead of silently re-upserting, and 404 means "no account yet".
    const toggleStudioAccess = async (adminUser: AdminUserRecord, product: ProductId, active: boolean) => {
        const email = normalizeText(adminUser.email);
        if (!email) {
            setMessage({ type: 'error', text: 'Full email is required to change studio access (admin only).' });
            return;
        }
        // Granting the FIRST row flips the account from "everything open" to "only the
        // granted studios" — make sure the operator means to confine, not add.
        if ((adminUser.productAccess || []).length === 0) {
            const ok = window.confirm(
                `${adminUser.email || 'This user'} currently has full access to every studio (default).\n\n` +
                `Granting ${PRODUCT_LABELS[product]} will CONFINE the account to only the studios you explicitly grant.\n\nContinue?`
            );
            if (!ok) return;
        }
        setBusyStudioKey(`${adminUser.userId}:${product}`);
        setMessage(null);
        try {
            const result = await adminSetProductAccess({
                email,
                product,
                active,
                ...(active && sendInvite
                    ? {
                        sendInvite: true,
                        inviterName: inviterName.trim() || undefined,
                        personalNote: personalNote.trim() || undefined
                    }
                    : {})
            });
            if (result.alreadyGranted) {
                setMessage({ type: 'success', text: `${PRODUCT_LABELS[product]}: already has access — nothing to do.` });
            } else {
                setMessage({
                    type: 'success',
                    text: active
                        ? `${PRODUCT_LABELS[product]} granted${result.emailed ? ' — invite email sent.' : sendInvite ? ' (invite email was not sent).' : '.'}`
                        : `${PRODUCT_LABELS[product]} revoked.`
                });
            }
            // If the operator changed their OWN account, the suite's gates re-check immediately.
            invalidateProductAccess();
            await loadGovernance();
        } catch (err: any) {
            // 404 → "No account with this email yet — they need to sign up first." (server copy)
            setMessage({ type: 'error', text: err?.message || 'Studio access update failed.' });
        } finally {
            setBusyStudioKey(null);
        }
    };

    const toggleExpanded = (userId: string) => {
        setExpandedUserId((prev) => {
            const next = prev === userId ? null : userId;
            if (next !== prev) {
                // Reset the per-user invite options so a note typed for one user can't
                // silently ride along on the next user's grant.
                setSendInvite(false);
                setInviterName('');
                setPersonalNote('');
            }
            return next;
        });
    };

    // Each action consumes its reason input: a stale reason left in the box would
    // otherwise be silently attached to the NEXT action on the same project,
    // corrupting the moderation audit trail.
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

    const pendingModeration = moderationQueue.filter((item) => item.republishRequestStatus === 'pending').length;
    const suspendedUsers = adminUsers.filter((u) => u.moderationStatus === 'suspended').length;

    const renderOverview = () => (
        <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Users loaded" value={adminUsers.length} />
                <Stat label="Moderation queue" value={moderationQueue.length} tone={moderationQueue.length ? 'bg-amber-50' : 'bg-white'} />
                <Stat label="Pending republish" value={pendingModeration} tone={pendingModeration ? 'bg-amber-50' : 'bg-white'} />
                {isAdmin
                    ? <Stat label="Failures (24h)" value={failures24h ?? '—'} tone={failures24h ? 'bg-red-50' : 'bg-white'} />
                    : <Stat label="Suspended users" value={suspendedUsers} tone={suspendedUsers ? 'bg-red-50' : 'bg-white'} />}
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
            </div>
        </div>
    );

    // ── Users: one clean, compact table ─────────────────────────────────────────
    // Roles model: admin / moderator / per-studio access. No plans, no billing.
    const statusChip = (status: AdminUserRecord['moderationStatus']) => {
        const tone = status === 'suspended'
            ? 'bg-red-100 text-red-700'
            : status === 'restricted'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-green-100 text-green-700';
        return <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${tone}`}>{status}</span>;
    };

    const studioChips = (adminUser: AdminUserRecord) => {
        const grants = adminUser.productAccess || [];
        if (grants.length === 0) {
            return (
                <span
                    className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-100 text-slate-600"
                    title="No grants — default access to every studio"
                >
                    all
                </span>
            );
        }
        return (
            <span className="inline-flex gap-1">
                {PRODUCT_IDS.map((product) => {
                    const grant = grants.find((g) => g.product === product);
                    const on = grant?.active === true;
                    return (
                        <span
                            key={product}
                            className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ${on ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-400 line-through'}`}
                            title={`${PRODUCT_LABELS[product]}: ${on ? 'granted' : grant ? 'revoked' : 'no grant (confined account — not allowed)'}`}
                        >
                            {PRODUCT_CHIP_LABEL[product]}
                        </span>
                    );
                })}
            </span>
        );
    };

    // Clearing every grant row returns the account to default full access — the
    // counterpart of the confinement that the first grant creates.
    const resetStudioAccess = async (adminUser: AdminUserRecord) => {
        const email = normalizeText(adminUser.email);
        if (!email) {
            setMessage({ type: 'error', text: 'Full email is required to change studio access (admin only).' });
            return;
        }
        setBusyStudioKey(`${adminUser.userId}:reset`);
        setMessage(null);
        try {
            const result = await adminResetProductAccess(email);
            setMessage({ type: 'success', text: `Reset to full access — ${result.cleared} grant${result.cleared === 1 ? '' : 's'} cleared (all studios open).` });
            invalidateProductAccess();
            await loadGovernance();
        } catch (err: any) {
            setMessage({ type: 'error', text: err?.message || 'Reset failed.' });
        } finally {
            setBusyStudioKey(null);
        }
    };

    const renderStudioExpander = (adminUser: AdminUserRecord) => {
        const grants = adminUser.productAccess || [];
        const isDefault = grants.length === 0;
        return (
            <tr className="bg-slate-50/70 border-b border-slate-100">
                <td colSpan={7} className="px-3 py-3">
                    <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-[11px] text-slate-500">
                                {isDefault
                                    ? 'This account has FULL access (default — no grants). Granting a studio below switches it to confined mode: only explicitly granted studios stay open.'
                                    : 'This account is CONFINED to its granted studios. Use "Reset to full access" to reopen everything (back to default).'}
                                {' '}Granting can send the branded studio-invite email.
                            </p>
                            {!isDefault && (
                                <button
                                    disabled={busyStudioKey === `${adminUser.userId}:reset`}
                                    onClick={() => void resetStudioAccess(adminUser)}
                                    className="text-[11px] font-bold border-2 border-black rounded px-2 py-0.5 bg-white hover:bg-green-50 transition-colors disabled:opacity-40"
                                >
                                    {busyStudioKey === `${adminUser.userId}:reset` ? <Loader2 size={11} className="animate-spin" /> : 'Reset to full access (all studios)'}
                                </button>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                            <label className="flex items-center gap-1.5 font-bold cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={sendInvite}
                                    onChange={(e) => setSendInvite(e.target.checked)}
                                    className="w-3.5 h-3.5 accent-black"
                                />
                                <Mail size={13} /> Send invite email when granting
                            </label>
                            {sendInvite && (
                                <>
                                    <input
                                        value={inviterName}
                                        onChange={(e) => setInviterName(e.target.value)}
                                        placeholder="Inviter name (optional)"
                                        maxLength={80}
                                        className="border-2 border-black rounded px-2 py-1 bg-white"
                                    />
                                    <input
                                        value={personalNote}
                                        onChange={(e) => setPersonalNote(e.target.value)}
                                        placeholder="Personal note (optional)"
                                        maxLength={500}
                                        className="border-2 border-black rounded px-2 py-1 bg-white w-64 max-w-full"
                                    />
                                </>
                            )}
                        </div>
                        <div className="grid sm:grid-cols-3 gap-2">
                            {PRODUCT_IDS.map((product) => {
                                const grant = grants.find((g) => g.product === product);
                                const state: 'default' | 'granted' | 'revoked' = !grant ? 'default' : grant.active ? 'granted' : 'revoked';
                                // Effective access, not just row state: default mode means every
                                // studio is open; confined mode means a missing row = locked out.
                                const label = state !== 'default' ? state : isDefault ? 'open (default)' : 'not allowed';
                                const labelTone = state === 'granted'
                                    ? 'text-green-700'
                                    : state === 'revoked'
                                        ? 'text-red-600'
                                        : isDefault ? 'text-green-600' : 'text-red-500';
                                const studioBusy = busyStudioKey === `${adminUser.userId}:${product}`;
                                return (
                                    <div key={product} className="border border-slate-300 rounded-lg bg-white px-2.5 py-2 flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="text-xs font-bold truncate">{PRODUCT_LABELS[product]}</div>
                                            <div className={`text-[10px] font-bold uppercase ${labelTone}`}>
                                                {label}
                                            </div>
                                        </div>
                                        <div className="flex gap-1 shrink-0">
                                            <button
                                                disabled={studioBusy || state === 'granted'}
                                                onClick={() => void toggleStudioAccess(adminUser, product, true)}
                                                className="text-[11px] font-bold border-2 border-black rounded px-2 py-0.5 bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors disabled:opacity-40 disabled:pointer-events-none"
                                            >
                                                {studioBusy ? <Loader2 size={11} className="animate-spin" /> : 'Grant'}
                                            </button>
                                            <button
                                                disabled={studioBusy || state === 'revoked'}
                                                onClick={() => void toggleStudioAccess(adminUser, product, false)}
                                                className="text-[11px] font-bold border-2 border-black rounded px-2 py-0.5 bg-white hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                                            >
                                                Revoke
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </td>
            </tr>
        );
    };

    const renderUsers = () => (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-500">Roles (admin / moderator) and per-studio access — nothing else to manage.</p>
                <input
                    value={adminUserQuery}
                    onChange={(e) => setAdminUserQuery(e.target.value)}
                    placeholder="Search by username or email"
                    className="w-full md:w-72 border-2 border-black rounded-lg px-3 py-2 font-mono text-sm bg-white"
                />
            </div>

            <div className="bg-white border-2 border-black rounded-xl overflow-x-auto">
                <table className="w-full text-sm text-left min-w-[860px]">
                    <thead>
                        <tr className="bg-slate-50 border-b-2 border-black text-[10px] uppercase tracking-wide text-slate-500">
                            <th className="px-3 py-2 font-bold">Email</th>
                            <th className="px-3 py-2 font-bold">Name</th>
                            <th className="px-3 py-2 font-bold">Joined</th>
                            <th className="px-3 py-2 font-bold">Role</th>
                            <th className="px-3 py-2 font-bold">Studio access</th>
                            <th className="px-3 py-2 font-bold">Status</th>
                            <th className="px-3 py-2 font-bold text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {adminUsers.length === 0 && (
                            <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-500">No users found.</td></tr>
                        )}
                        {adminUsers.map((adminUser) => {
                            const isTargetAdmin = adminUser.roles.includes('admin');
                            const canModerateTarget = isAdmin || !isTargetAdmin;
                            const expanded = expandedUserId === adminUser.userId;
                            const suspended = adminUser.moderationStatus === 'suspended';
                            return (
                                <React.Fragment key={adminUser.userId}>
                                    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                                        <td className="px-3 py-2 font-mono text-xs max-w-[220px] truncate" title={adminUser.email || adminUser.maskedEmail || adminUser.userId}>
                                            {adminUser.email || adminUser.maskedEmail || adminUser.userId}
                                        </td>
                                        <td className="px-3 py-2 font-bold max-w-[140px] truncate">{adminUser.username || '—'}</td>
                                        <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                                            {adminUser.createdAt ? new Date(adminUser.createdAt).toLocaleDateString() : '—'}
                                        </td>
                                        <td className="px-3 py-2">
                                            {isAdmin ? (
                                                <select
                                                    value={roleValueOf(adminUser.roles)}
                                                    onChange={(e) => void handleRoleSelect(adminUser, e.target.value as RoleValue)}
                                                    disabled={busy}
                                                    className="border-2 border-black rounded px-1.5 py-0.5 text-xs font-bold bg-white"
                                                >
                                                    <option value="none">—</option>
                                                    <option value="moderator">moderator</option>
                                                    <option value="admin">admin</option>
                                                </select>
                                            ) : (
                                                <span className="text-xs font-bold">{roleValueOf(adminUser.roles) === 'none' ? '—' : roleValueOf(adminUser.roles)}</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2">{studioChips(adminUser)}</td>
                                        <td className="px-3 py-2">{statusChip(adminUser.moderationStatus)}</td>
                                        <td className="px-3 py-2">
                                            <div className="flex items-center justify-end gap-1.5">
                                                {isAdmin && (
                                                    <button
                                                        onClick={() => toggleExpanded(adminUser.userId)}
                                                        className={`inline-flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded px-2 py-0.5 transition-colors ${expanded ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
                                                    >
                                                        <MonitorPlay size={11} /> Studios…
                                                        <ChevronDown size={11} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                                                    </button>
                                                )}
                                                {canModerateTarget && (
                                                    <button
                                                        onClick={() => void handleSuspendToggle(adminUser)}
                                                        disabled={busy}
                                                        className={`inline-flex items-center gap-1 text-[11px] font-bold border-2 border-black rounded px-2 py-0.5 transition-colors disabled:opacity-40 ${suspended ? 'bg-green-100 hover:bg-green-200' : 'bg-white hover:bg-red-50 text-red-600'}`}
                                                        title={suspended ? 'Reactivate this account' : 'Suspend this account'}
                                                    >
                                                        <Ban size={11} /> {suspended ? 'Unsuspend' : 'Suspend'}
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                    {isAdmin && expanded && renderStudioExpander(adminUser)}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
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
                    {section === 'verification' && isAdmin && (
                        <div className="border-2 border-black rounded-xl bg-white"><VerificationCenter /></div>
                    )}
                </motion.div>
            </AnimatePresence>
        </div>
    );
};
