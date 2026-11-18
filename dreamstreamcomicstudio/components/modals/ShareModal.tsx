import React, { useEffect, useId, useState } from 'react';
import { X, Copy, Globe, Lock, Trash2, Clock, Download, Share2 } from 'lucide-react';
import { ModalPortal } from './ModalPortal';
import { post, get, ApiError } from '../../services/apiClient';
import { buttonClasses } from '../ds/Button';
import {
    DENSITY,
    DIALOG_TITLE,
    FIELD,
    HAIRLINE,
    INK,
    MUTED,
    OVERLAY,
    OVERLINE,
    RADIUS_PANEL,
    SCRIM,
    SEGMENTED_ACTIVE_FILL,
    SEGMENTED_ITEM,
    SEGMENTED_TRACK,
    STATUS_SURFACE,
    TONE_TEXT,
    Z
} from '../chat/studioDesign';

/** A two-way choice (the tabs, the share type): the Atlas segmented track, the chosen one on the raised pill. */
const SEGMENT_TRACK = `${SEGMENTED_TRACK} flex w-full`;
const segment = (on: boolean) => `${SEGMENTED_ITEM} min-h-9 ${DENSITY.coarse} aria-pressed:text-[var(--ds-ink)] ${on ? SEGMENTED_ACTIVE_FILL : ''}`;
const FIELD_LABEL = `mb-1 block text-sm font-medium ${INK}`;
const HELP = `mt-1 text-xs ${MUTED}`;
const TEXT_FIELD = `${FIELD} block h-10 w-full px-3 text-sm`;
const ROW_ICON = buttonClasses({ variant: 'ghost', size: 'icon', className: 'size-8' });

interface ShareModalProps {
    projectId: string;
    onClose: () => void;
    /** Comic Studio (v4) comic: classic shares are refused server-side (409 USE_STUDIO_SHARE). */
    isStudioV4?: boolean;
}

/** The server refuses classic shares for Comic Studio comics (they publish from the studio). */
const isUseStudioShareError = (e: unknown): boolean => {
    if (!(e instanceof ApiError) || e.status !== 409) return false;
    const details = e.details as { code?: unknown; error?: { code?: unknown } } | undefined;
    return details?.code === 'USE_STUDIO_SHARE' || details?.error?.code === 'USE_STUDIO_SHARE' || /studio share sheet/i.test(e.message);
};

interface ShareRecord {
    id: string;
    share_type: 'public' | 'private';
    share_token: string;
    allowed_emails: string[];
    allowed_usernames: string[];
    expires_at: string | null;
    allow_download: boolean;
    allow_reshare: boolean;
    created_at: string;
    revoked_at: string | null;
}

type Tab = 'create' | 'active';

export const ShareModal: React.FC<ShareModalProps> = ({ projectId, onClose, isStudioV4 = false }) => {
    const [studioOnly, setStudioOnly] = useState(isStudioV4);
    const [tab, setTab] = useState<Tab>('create');
    const [shareType, setShareType] = useState<'public' | 'private'>('public');
    const [emails, setEmails] = useState('');
    const [expiresInHours, setExpiresInHours] = useState<string>('');
    const [allowDownload, setAllowDownload] = useState(false);
    const [allowReshare, setAllowReshare] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [shares, setShares] = useState<ShareRecord[]>([]);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const titleId = useId();
    const emailsId = useId();
    const expiryId = useId();

    const loadShares = async () => {
        try {
            const res = await get<{ shares: ShareRecord[] }>(`/api/shares/project/${projectId}`);
            setShares(res.shares);
        } catch { /* ignore */ }
    };

    useEffect(() => { loadShares(); }, [projectId]);

    const handleCreate = async () => {
        setIsCreating(true);
        setError(null);
        try {
            const body: Record<string, unknown> = {
                projectId,
                shareType,
                allowDownload,
                allowReshare,
            };
            if (shareType === 'private' && emails.trim()) {
                body.allowedEmails = emails.split(',').map(e => e.trim()).filter(Boolean);
            }
            if (expiresInHours) {
                body.expiresInHours = Number(expiresInHours);
            }
            await post('/api/shares', body);
            await loadShares();
            setTab('active');
        } catch (e: unknown) {
            if (isUseStudioShareError(e)) {
                setStudioOnly(true);
                return;
            }
            setError(e instanceof Error ? e.message : 'Failed to create share');
        } finally {
            setIsCreating(false);
        }
    };

    const handleRevoke = async (shareId: string) => {
        try {
            await post(`/api/shares/${shareId}/revoke`, {});
            await loadShares();
        } catch { /* ignore */ }
    };

    const copyLink = (token: string, id: string) => {
        const url = `${window.location.origin}/share/${token}`;
        navigator.clipboard.writeText(url);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const activeShares = shares.filter(s => !s.revoked_at);

    return (
        <ModalPortal>
            <div className={`fixed inset-0 ${Z.dialog} ${SCRIM} flex items-center justify-center p-4`} onClick={onClose}>
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    className={`${OVERLAY} max-h-[80vh] w-full max-w-lg overflow-y-auto`}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline)] p-4">
                        <div className="flex min-w-0 items-center gap-2">
                            <Share2 size={20} aria-hidden="true" />
                            <h2 id={titleId} className={DIALOG_TITLE}>Share Comic</h2>
                        </div>
                        <button onClick={onClose} aria-label="Close" className={buttonClasses({ variant: 'ghost', size: 'icon', className: 'text-[var(--ds-muted)]' })}>
                            <X size={20} />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="px-4 pt-4">
                      <div className={SEGMENT_TRACK}>
                        {(['create', 'active'] as Tab[]).map(t => (
                            <button
                                key={t}
                                onClick={() => setTab(t)}
                                aria-pressed={tab === t}
                                className={segment(tab === t)}
                            >
                                {t === 'create' ? 'Create Share' : `Active (${activeShares.length})`}
                            </button>
                        ))}
                      </div>
                    </div>

                    <div className="p-4 space-y-4">
                        {tab === 'create' && studioOnly ? (
                            <div
                                className={`${RADIUS_PANEL} ${HAIRLINE} bg-[var(--ds-surface-soft)] p-4 text-sm text-[var(--ds-ink)]`}
                                role="status"
                                data-testid="share-use-studio"
                            >
                                <div className="flex items-center gap-2 font-semibold">
                                    <Globe size={16} aria-hidden /> Publish from the studio
                                </div>
                                <p className="mt-1 text-[13px] leading-snug text-[var(--ds-muted)]">
                                    Comic Studio comics are shared and published from the studio&apos;s Share sheet, so only finished,
                                    checked pages reach readers. Open the comic in the studio to share it.
                                </p>
                            </div>
                        ) : tab === 'create' ? (
                            <>
                                {/* Share Type */}
                                <div>
                                    <div className={FIELD_LABEL}>Share Type</div>
                                    <div className={SEGMENT_TRACK}>
                                        <button
                                            onClick={() => setShareType('public')}
                                            aria-pressed={shareType === 'public'}
                                            className={segment(shareType === 'public')}
                                        >
                                            <Globe size={16} /> Public
                                        </button>
                                        <button
                                            onClick={() => setShareType('private')}
                                            aria-pressed={shareType === 'private'}
                                            className={segment(shareType === 'private')}
                                        >
                                            <Lock size={16} /> Private
                                        </button>
                                    </div>
                                    <p className={HELP}>
                                        {shareType === 'public'
                                            ? 'Anyone with the link can view (login required).'
                                            : 'Only specified email addresses can view.'}
                                    </p>
                                </div>

                                {/* Private: Emails */}
                                {shareType === 'private' && (
                                    <div>
                                        <label htmlFor={emailsId} className={FIELD_LABEL}>Allowed Emails</label>
                                        <input
                                            type="text"
                                            value={emails}
                                            onChange={e => setEmails(e.target.value)}
                                            placeholder="user@example.com, friend@example.com"
                                            id={emailsId}
                                            className={TEXT_FIELD}
                                        />
                                        <p className={HELP}>Comma-separated email addresses</p>
                                    </div>
                                )}

                                {/* Expiry */}
                                <div>
                                    <label htmlFor={expiryId} className={`${FIELD_LABEL} flex items-center gap-1`}>
                                        <Clock size={14} aria-hidden="true" /> Expires After (hours)
                                    </label>
                                    <input
                                        type="number"
                                        value={expiresInHours}
                                        onChange={e => setExpiresInHours(e.target.value)}
                                        placeholder="Leave empty for no expiration"
                                        min={1}
                                        id={expiryId}
                                        className={TEXT_FIELD}
                                    />
                                </div>

                                {/* Permissions */}
                                <div className="flex flex-wrap gap-x-4">
                                    <label className={`flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium ${INK}`}>
                                        <input
                                            type="checkbox"
                                            checked={allowDownload}
                                            onChange={e => setAllowDownload(e.target.checked)}
                                            className="size-4 accent-[var(--ds-ink)]"
                                        />
                                        <Download size={14} /> Allow Download
                                    </label>
                                    <label className={`flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium ${INK}`}>
                                        <input
                                            type="checkbox"
                                            checked={allowReshare}
                                            onChange={e => setAllowReshare(e.target.checked)}
                                            className="size-4 accent-[var(--ds-ink)]"
                                        />
                                        <Share2 size={14} /> Allow Reshare
                                    </label>
                                </div>

                                {error && (
                                    <div className={`border p-2 text-xs font-semibold [overflow-wrap:anywhere] ${RADIUS_PANEL} ${STATUS_SURFACE.error} ${TONE_TEXT.danger}`}>
                                        {error}
                                    </div>
                                )}

                                <button
                                    onClick={handleCreate}
                                    disabled={isCreating}
                                    className={buttonClasses({ size: 'lg', className: 'w-full' })}
                                >
                                    {isCreating ? 'Creating...' : 'Create Share Link'}
                                </button>
                            </>
                        ) : (
                            /* Active Shares List */
                            <div className="space-y-3">
                                {activeShares.length === 0 ? (
                                    <p className={`py-6 text-center text-sm ${MUTED}`}>No active shares yet</p>
                                ) : (
                                    activeShares.map(share => (
                                        <div key={share.id} className={`bg-[var(--ds-well)] p-3 ${RADIUS_PANEL} ${HAIRLINE}`}>
                                            <div className="mb-2 flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-2">
                                                    {share.share_type === 'public' ? <Globe size={14} className={INK} aria-hidden="true" /> : <Lock size={14} className={INK} aria-hidden="true" />}
                                                    <span className={OVERLINE}>{share.share_type}</span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <button
                                                        onClick={() => copyLink(share.share_token, share.id)}
                                                        className={ROW_ICON}
                                                        title="Copy link"
                                                        aria-label="Copy link"
                                                    >
                                                        <Copy size={14} className={copiedId === share.id ? TONE_TEXT.success : ''} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleRevoke(share.id)}
                                                        className={`${ROW_ICON} text-[var(--ds-danger-text)]`}
                                                        title="Revoke"
                                                        aria-label="Revoke"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            </div>
                                            <div className={`space-y-0.5 text-xs [overflow-wrap:anywhere] ${MUTED}`}>
                                                {share.expires_at && <p>⏳ Expires: {new Date(share.expires_at).toLocaleDateString()}</p>}
                                                {share.allowed_emails.length > 0 && <p>📧 {share.allowed_emails.join(', ')}</p>}
                                                <p>📅 Created: {new Date(share.created_at).toLocaleDateString()}</p>
                                                <p>{share.allow_download ? '✅' : '❌'} Download · {share.allow_reshare ? '✅' : '❌'} Reshare</p>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
};
