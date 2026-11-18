import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    Users,
    Wallet
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ds';
import { CARD_TITLE } from '../ds/Card';
import {
    DENSITY,
    FIELD,
    FOCUS_RING,
    MUTED,
    OVERLINE,
    RISE_IN,
    SECTION_CARD,
    SEGMENTED_ACTIVE,
    STATUS_CHIP,
    STATUS_CHIP_TONE,
    STATUS_INK,
    STATUS_SURFACE,
    TEXT_XL,
    TRANSITION,
    type StatusState
} from '../chat/studioDesign';
import { VerificationCenter } from '../VerificationCenter';
import { AdminAnalytics } from './AdminAnalytics';
import { InviteManager } from './InviteManager';
import { EmailConsole } from './EmailConsole';
import { ProductAccessPanel } from './ProductAccessPanel';
import { CostCentre } from './CostCentre';
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
import { registeredAdminSections, type AdminSectionRegistration } from '../comicstudio/features';

type AdminSection =
    | 'overview'
    | 'users'
    | 'moderation'
    | 'invites'
    | 'studios'
    | 'email'
    | 'analytics'
    | 'costs'
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
    { id: 'costs', label: 'Costs', icon: <Wallet size={15} />, adminOnly: true },
    { id: 'verification', label: 'Verification', icon: <CheckCircle2 size={15} />, adminOnly: true }
];

/** A section id: a built-in, or one registered by a Comic Studio feature (features.ts, contract §13.2). */
type SectionId = AdminSection | string;

/** Feature sections (library builder, safety cases, …): admin-only (the server re-checks requireAdmin). */
const featureSections = (): readonly AdminSectionRegistration[] =>
    registeredAdminSections().filter((entry) => !SECTIONS.some((section) => section.id === entry.id));

const isAdminSection = (value: string): value is SectionId =>
    SECTIONS.some((section) => section.id === value) || featureSections().some((entry) => entry.id === value);

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

/** Small framed stat used across the console; a state that needs a look tints it (always with its label). */
const Stat: React.FC<{ label: string; value: React.ReactNode; state?: StatusState }> = ({ label, value, state }) => (
    <div className={cn(SECTION_CARD, 'px-3 py-2.5', state && STATUS_SURFACE[state])}>
        <div className={OVERLINE}>{label}</div>
        <div className={cn(TEXT_XL, 'mt-0.5 font-semibold tabular-nums', state ? STATUS_INK[state] : 'text-[var(--ds-ink)]')}>{value}</div>
    </div>
);

/** Health row: healthy when ok, attention when degraded, error when broken. */
const HealthRow: React.FC<{ ok: boolean | null; label: string; detail: string; warn?: boolean }> = ({ ok, label, detail, warn }) => {
    const state: StatusState = ok === null ? 'waiting' : ok ? 'healthy' : warn ? 'attention' : 'error';
    const Icon = ok === null ? Loader2 : ok ? CheckCircle2 : AlertTriangle;
    return (
        <div className={cn('flex items-start gap-2.5 rounded-[var(--ds-radius-control)] border px-3 py-2', STATUS_SURFACE[state])}>
            <Icon size={16} className={cn('mt-0.5 shrink-0', STATUS_INK[state], ok === null && 'motion-safe:animate-spin')} aria-hidden />
            <div className="min-w-0">
                <div className="text-sm font-semibold leading-tight text-[var(--ds-ink)]">{label}</div>
                <div className={cn('text-xs leading-snug [overflow-wrap:anywhere]', MUTED)}>{detail}</div>
            </div>
        </div>
    );
};

export const AdminConsole: React.FC<AdminConsoleProps> = ({ isAdmin, isModerator, adminAccess, onNavigate }) => {
    const visibleSections = useMemo<Array<{ id: SectionId; label: string; icon: React.ReactNode; adminOnly?: boolean }>>(
        () => [
            ...SECTIONS.filter((section) => isAdmin || !section.adminOnly),
            ...(isAdmin ? featureSections().map((entry) => ({ id: entry.id, label: entry.label, icon: entry.icon, adminOnly: true })) : [])
        ],
        [isAdmin]
    );
    const activeFeatureSection = (id: SectionId): AdminSectionRegistration | undefined =>
        isAdmin ? featureSections().find((entry) => entry.id === id) : undefined;

    const [section, setSection] = useState<SectionId>(() => {
        const initial = resolveInitialUiState<SectionId>('settings.admin.section', 'section', isAdminSection, 'overview');
        return visibleSections.some((s) => s.id === initial) ? initial : 'overview';
    });

    const selectSection = (next: SectionId) => {
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
                <Stat label="Moderation queue" value={moderationQueue.length} state={moderationQueue.length ? 'attention' : undefined} />
                <Stat label="Pending republish" value={pendingModeration} state={pendingModeration ? 'attention' : undefined} />
                {isAdmin
                    ? <Stat label="Failures (24h)" value={failures24h ?? '—'} state={failures24h ? 'error' : undefined} />
                    : <Stat label="Suspended users" value={suspendedUsers} state={suspendedUsers ? 'error' : undefined} />}
            </div>

            {isAdmin && (
                <div className={cn(SECTION_CARD, 'space-y-2.5 p-4')}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className={cn(CARD_TITLE, 'flex items-center gap-2')}><Activity size={18} aria-hidden /> System health</h3>
                        <span className={cn('text-[11px]', MUTED)}>live checks against the platform services</span>
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
                    className={cn(SECTION_CARD, 'group p-4 text-left hover:bg-[var(--ds-hover)]', TRANSITION, FOCUS_RING)}
                >
                    <div className="flex items-center justify-between gap-2">
                        <h4 className={cn(CARD_TITLE, 'flex items-center gap-2')}><ShieldAlert size={17} aria-hidden /> Review moderation queue</h4>
                        <ChevronRight size={16} className="shrink-0 transition-transform duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-safe:group-hover:translate-x-0.5" aria-hidden />
                    </div>
                    <p className={cn('mt-1 text-xs', MUTED)}>
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
        const state: StatusState = status === 'suspended' ? 'error' : status === 'restricted' ? 'attention' : 'healthy';
        return <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE[state])}>{status}</span>;
    };

    const studioChips = (adminUser: AdminUserRecord) => {
        const grants = adminUser.productAccess || [];
        if (grants.length === 0) {
            return (
                <span
                    className={cn(STATUS_CHIP, STATUS_CHIP_TONE.waiting)}
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
                            className={cn(STATUS_CHIP, on ? STATUS_CHIP_TONE.healthy : cn(STATUS_CHIP_TONE.waiting, 'line-through'))}
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
            <tr className="border-b border-[var(--ds-hairline-soft)] bg-[var(--ds-well)]">
                <td colSpan={7} className="px-3 py-3">
                    <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className={cn('text-[11px]', MUTED)}>
                                {isDefault
                                    ? 'This account has FULL access (default — no grants). Granting a studio below switches it to confined mode: only explicitly granted studios stay open.'
                                    : 'This account is CONFINED to its granted studios. Use "Reset to full access" to reopen everything (back to default).'}
                                {' '}Granting can send the branded studio-invite email.
                            </p>
                            {!isDefault && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busyStudioKey === `${adminUser.userId}:reset`}
                                    onClick={() => void resetStudioAccess(adminUser)}
                                >
                                    {busyStudioKey === `${adminUser.userId}:reset` ? <Loader2 size={11} className="motion-safe:animate-spin" /> : 'Reset to full access (all studios)'}
                                </Button>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                            <label className={cn('flex cursor-pointer items-center gap-1.5 font-medium', DENSITY.coarse)}>
                                <input
                                    type="checkbox"
                                    checked={sendInvite}
                                    onChange={(e) => setSendInvite(e.target.checked)}
                                    className="w-3.5 h-3.5 accent-[var(--ds-accent)]"
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
                                        className={cn(FIELD, 'h-8 px-2', DENSITY.coarse)}
                                    />
                                    <input
                                        value={personalNote}
                                        onChange={(e) => setPersonalNote(e.target.value)}
                                        placeholder="Personal note (optional)"
                                        maxLength={500}
                                        className={cn(FIELD, 'h-8 w-64 max-w-full px-2', DENSITY.coarse)}
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
                                const labelTone = STATUS_INK[state === 'granted' ? 'healthy' : state === 'revoked' ? 'error' : isDefault ? 'healthy' : 'error'];
                                const studioBusy = busyStudioKey === `${adminUser.userId}:${product}`;
                                return (
                                    <div key={product} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-2.5 py-2">
                                        <div className="min-w-0">
                                            <div className="truncate text-xs font-semibold">{PRODUCT_LABELS[product]}</div>
                                            <div className={cn('text-[11px] font-medium', labelTone)}>
                                                {label}
                                            </div>
                                        </div>
                                        <div className="flex gap-1 shrink-0">
                                            <Button
                                                size="sm"
                                                disabled={studioBusy || state === 'granted'}
                                                onClick={() => void toggleStudioAccess(adminUser, product, true)}
                                            >
                                                {studioBusy ? <Loader2 size={11} className="motion-safe:animate-spin" /> : 'Grant'}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                disabled={studioBusy || state === 'revoked'}
                                                onClick={() => void toggleStudioAccess(adminUser, product, false)}
                                            >
                                                Revoke
                                            </Button>
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
                <p className={cn('text-xs', MUTED)}>Roles (admin / moderator) and per-studio access — nothing else to manage.</p>
                <input
                    value={adminUserQuery}
                    onChange={(e) => setAdminUserQuery(e.target.value)}
                    placeholder="Search by username or email"
                    className={cn(FIELD, 'h-9 w-full px-3 font-mono text-sm md:w-72', DENSITY.coarse)}
                />
            </div>

            <div className={cn(SECTION_CARD, 'overflow-x-auto')}>
                <table className="w-full text-sm text-left min-w-[860px]">
                    <thead>
                        <tr className={cn('border-b border-[var(--ds-hairline)] bg-[var(--ds-well)]', OVERLINE)}>
                            <th className="px-3 py-2 font-semibold">Email</th>
                            <th className="px-3 py-2 font-semibold">Name</th>
                            <th className="px-3 py-2 font-semibold">Joined</th>
                            <th className="px-3 py-2 font-semibold">Role</th>
                            <th className="px-3 py-2 font-semibold">Studio access</th>
                            <th className="px-3 py-2 font-semibold">Status</th>
                            <th className="px-3 py-2 font-semibold text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {adminUsers.length === 0 && (
                            <tr><td colSpan={7} className={cn('px-3 py-6 text-center text-sm', MUTED)}>No users found.</td></tr>
                        )}
                        {adminUsers.map((adminUser) => {
                            const isTargetAdmin = adminUser.roles.includes('admin');
                            const canModerateTarget = isAdmin || !isTargetAdmin;
                            const expanded = expandedUserId === adminUser.userId;
                            const suspended = adminUser.moderationStatus === 'suspended';
                            return (
                                <React.Fragment key={adminUser.userId}>
                                    <tr className="border-b border-[var(--ds-hairline-soft)] last:border-0 hover:bg-[var(--ds-hover)]">
                                        <td className="px-3 py-2 font-mono text-xs max-w-[220px] truncate" title={adminUser.email || adminUser.maskedEmail || adminUser.userId}>
                                            {adminUser.email || adminUser.maskedEmail || adminUser.userId}
                                        </td>
                                        <td className="px-3 py-2 font-semibold max-w-[140px] truncate">{adminUser.username || '—'}</td>
                                        <td className={cn('whitespace-nowrap px-3 py-2 text-xs', MUTED)}>
                                            {adminUser.createdAt ? new Date(adminUser.createdAt).toLocaleDateString() : '—'}
                                        </td>
                                        <td className="px-3 py-2">
                                            {isAdmin ? (
                                                <select
                                                    value={roleValueOf(adminUser.roles)}
                                                    onChange={(e) => void handleRoleSelect(adminUser, e.target.value as RoleValue)}
                                                    disabled={busy}
                                                    className={cn(FIELD, 'h-8 px-1.5 text-xs font-medium', DENSITY.coarse)}
                                                >
                                                    <option value="none">—</option>
                                                    <option value="moderator">moderator</option>
                                                    <option value="admin">admin</option>
                                                </select>
                                            ) : (
                                                <span className="text-xs font-semibold">{roleValueOf(adminUser.roles) === 'none' ? '—' : roleValueOf(adminUser.roles)}</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2">{studioChips(adminUser)}</td>
                                        <td className="px-3 py-2">{statusChip(adminUser.moderationStatus)}</td>
                                        <td className="px-3 py-2">
                                            <div className="flex items-center justify-end gap-1.5">
                                                {isAdmin && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        aria-expanded={expanded}
                                                        onClick={() => toggleExpanded(adminUser.userId)}
                                                        className={expanded ? 'bg-[var(--ds-active)]' : undefined}
                                                    >
                                                        <MonitorPlay size={11} /> Studios…
                                                        <ChevronDown size={11} className={cn('transition-transform duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-reduce:transition-none', expanded && 'rotate-180')} />
                                                    </Button>
                                                )}
                                                {canModerateTarget && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() => void handleSuspendToggle(adminUser)}
                                                        disabled={busy}
                                                        className={suspended ? undefined : 'text-[var(--ds-danger-text)]'}
                                                        title={suspended ? 'Reactivate this account' : 'Suspend this account'}
                                                    >
                                                        <Ban size={11} /> {suspended ? 'Unsuspend' : 'Suspend'}
                                                    </Button>
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
            <p className={cn('text-xs', MUTED)}>Force projects private (reason required) and review republish requests.</p>
            <div className="space-y-3">
                {moderationQueue.length === 0 && (
                    <div className={cn('rounded-[var(--ds-radius-panel)] border border-dashed border-[var(--ds-hairline)] px-4 py-6 text-center text-sm', MUTED)}>
                        Queue is clear — no moderation items.
                    </div>
                )}
                {moderationQueue.map((item) => (
                    <div key={item.projectId} className={cn(SECTION_CARD, 'space-y-3 p-4')}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                                <div className="font-semibold [overflow-wrap:anywhere]">{item.projectName || item.projectId}</div>
                                <div className={cn('text-xs [overflow-wrap:anywhere]', MUTED)}>Owner: {item.ownerUserId}</div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE[item.isForcedPrivate ? 'error' : 'healthy'])}>
                                    {item.isForcedPrivate ? 'Forced Private' : item.isPublic ? 'Public' : 'Private'}
                                </span>
                                <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE[item.republishRequestStatus === 'pending' ? 'attention' : 'waiting'])}>
                                    Republish: {item.republishRequestStatus}
                                </span>
                            </div>
                        </div>

                        <input
                            value={moderationReasonByProject[item.projectId] || ''}
                            onChange={(e) => setModerationReasonByProject((prev) => ({ ...prev, [item.projectId]: e.target.value }))}
                            placeholder="Moderation reason (required for force private)"
                            className={cn(FIELD, 'h-9 w-full px-3 text-sm', DENSITY.coarse)}
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
                                    <Button disabled={busy} onClick={() => void handleReviewRepublish(item.projectId, true)}>
                                        Approve Republish
                                    </Button>
                                    <Button variant="outline" disabled={busy} onClick={() => void handleReviewRepublish(item.projectId, false)}>
                                        Reject Republish
                                    </Button>
                                </>
                            )}
                        </div>

                        {item.forcedPrivateReason && <div className={cn('text-xs [overflow-wrap:anywhere]', MUTED)}>Force-private reason: {item.forcedPrivateReason}</div>}
                        {item.republishRequestReason && <div className={cn('text-xs [overflow-wrap:anywhere]', MUTED)}>Republish request: {item.republishRequestReason}</div>}
                        {item.republishReviewReason && <div className={cn('text-xs [overflow-wrap:anywhere]', MUTED)}>Republish review: {item.republishReviewReason}</div>}
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
                    <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE.active)}>
                        <Shield size={13} aria-hidden /> {isAdmin ? 'Admin' : 'Moderator'}
                    </span>
                    {adminAccess?.bootstrapAdmin && (
                        <span className={cn(STATUS_CHIP, STATUS_CHIP_TONE.attention)}>
                            <UserCog size={13} aria-hidden /> Bootstrap
                        </span>
                    )}
                </div>
                <div className={cn('flex items-center gap-2 text-[11px]', MUTED)}>
                    <span>{lastRefreshedAt ? `Updated ${new Date(lastRefreshedAt).toLocaleTimeString()}` : 'Loading…'}</span>
                    <Button variant="outline" size="sm" onClick={() => void refreshNow()} disabled={busy}>
                        <RefreshCw size={12} className={busy ? 'motion-safe:animate-spin' : ''} /> Refresh
                    </Button>
                </div>
            </div>

            {/* Section navigation: a single scrollable rail replaces the old wall of stacked panels. */}
            <div className="flex max-w-full gap-0.5 overflow-x-auto rounded-[var(--ds-radius-control)] border border-[color:color-mix(in_srgb,var(--ds-hairline)_70%,transparent)] bg-[var(--ds-segment-track)] p-0.5" role="tablist" aria-label="Admin console sections">
                {visibleSections.map((entry) => {
                    const active = section === entry.id;
                    const badge = entry.id === 'moderation' && pendingModeration > 0 ? pendingModeration : null;
                    return (
                        <button
                            key={entry.id}
                            role="tab"
                            aria-selected={active}
                            onClick={() => selectSection(entry.id)}
                            className={cn(
                                'relative inline-flex shrink-0 items-center gap-1.5 rounded-[calc(var(--ds-radius-control)-2px)] px-3 py-1.5 text-[13px] font-medium transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)]',
                                DENSITY.coarse,
                                FOCUS_RING,
                                'focus-visible:outline-offset-0',
                                active ? SEGMENTED_ACTIVE : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
                            )}
                        >
                            {entry.icon}
                            {entry.label}
                            {badge !== null && (
                                <span className={cn(STATUS_CHIP, 'min-w-[18px] justify-center px-1.5', STATUS_CHIP_TONE.attention)}>
                                    {badge}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {message && (
                <div className={cn('flex items-center gap-2 rounded-[var(--ds-radius-control)] border px-3 py-2 text-sm font-medium [overflow-wrap:anywhere]', message.type === 'success' ? `${STATUS_SURFACE.healthy} ${STATUS_INK.healthy}` : `${STATUS_SURFACE.error} ${STATUS_INK.error}`)}>
                    {message.type === 'success' ? <CheckCircle2 size={16} className="shrink-0" aria-hidden /> : <AlertTriangle size={16} className="shrink-0" aria-hidden />} {message.text}
                </div>
            )}

            {/* The section rises in on the token entrance (still under reduced motion). */}
            <div key={section} className={RISE_IN}>
                    {section === 'overview' && renderOverview()}
                    {section === 'users' && renderUsers()}
                    {section === 'moderation' && renderModeration()}
                    {section === 'invites' && isAdmin && (
                        <div className={SECTION_CARD}><InviteManager /></div>
                    )}
                    {section === 'studios' && isAdmin && (
                        <div className={SECTION_CARD}><ProductAccessPanel /></div>
                    )}
                    {section === 'email' && isAdmin && (
                        <div className={SECTION_CARD}><EmailConsole /></div>
                    )}
                    {section === 'analytics' && (
                        <div className={SECTION_CARD}><AdminAnalytics /></div>
                    )}
                    {section === 'costs' && isAdmin && <CostCentre />}
                    {section === 'verification' && isAdmin && (
                        <div className={SECTION_CARD}><VerificationCenter /></div>
                    )}
                    {(() => {
                        const feature = activeFeatureSection(section);
                        return feature ? <feature.Component /> : null;
                    })()}
            </div>
        </div>
    );
};
