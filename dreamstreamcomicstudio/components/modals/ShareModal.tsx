import React, { useEffect, useState } from 'react';
import { X, Copy, Globe, Lock, Trash2, Clock, Download, Share2 } from 'lucide-react';
import { ModalPortal } from './ModalPortal';
import { post, get } from '../../services/apiClient';

interface ShareModalProps {
    projectId: string;
    onClose: () => void;
}

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

export const ShareModal: React.FC<ShareModalProps> = ({ projectId, onClose }) => {
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
            <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
                <div
                    className="bg-white rounded-2xl border-4 border-black shadow-comic max-w-lg w-full max-h-[80vh] overflow-y-auto"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b-4 border-black bg-brand-blue text-white rounded-t-xl">
                        <div className="flex items-center gap-2">
                            <Share2 size={20} />
                            <h2 className="text-xl font-display">Share Comic</h2>
                        </div>
                        <button onClick={onClose} className="hover:bg-white/20 rounded-full p-1 transition-colors">
                            <X size={20} />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="flex border-b-2 border-black">
                        {(['create', 'active'] as Tab[]).map(t => (
                            <button
                                key={t}
                                onClick={() => setTab(t)}
                                className={`flex-1 py-2 text-sm font-bold uppercase transition-colors ${tab === t ? 'bg-brand-yellow text-black' : 'bg-white text-slate-600 hover:bg-slate-50'
                                    }`}
                            >
                                {t === 'create' ? 'Create Share' : `Active (${activeShares.length})`}
                            </button>
                        ))}
                    </div>

                    <div className="p-4 space-y-4">
                        {tab === 'create' ? (
                            <>
                                {/* Share Type */}
                                <div>
                                    <label className="text-sm font-display text-black block mb-2">Share Type</label>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setShareType('public')}
                                            className={`flex-1 flex items-center justify-center gap-2 border-2 border-black rounded-lg py-2 text-sm font-bold transition-all ${shareType === 'public' ? 'bg-brand-blue text-white' : 'bg-white'
                                                }`}
                                        >
                                            <Globe size={16} /> Public
                                        </button>
                                        <button
                                            onClick={() => setShareType('private')}
                                            className={`flex-1 flex items-center justify-center gap-2 border-2 border-black rounded-lg py-2 text-sm font-bold transition-all ${shareType === 'private' ? 'bg-brand-blue text-white' : 'bg-white'
                                                }`}
                                        >
                                            <Lock size={16} /> Private
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-slate-500 mt-1">
                                        {shareType === 'public'
                                            ? 'Anyone with the link can view (login required).'
                                            : 'Only specified email addresses can view.'}
                                    </p>
                                </div>

                                {/* Private: Emails */}
                                {shareType === 'private' && (
                                    <div>
                                        <label className="text-sm font-display text-black block mb-1">Allowed Emails</label>
                                        <input
                                            type="text"
                                            value={emails}
                                            onChange={e => setEmails(e.target.value)}
                                            placeholder="user@example.com, friend@example.com"
                                            className="w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
                                        />
                                        <p className="text-[10px] text-slate-500 mt-1">Comma-separated email addresses</p>
                                    </div>
                                )}

                                {/* Expiry */}
                                <div>
                                    <label className="text-sm font-display text-black block mb-1 flex items-center gap-1">
                                        <Clock size={14} /> Expires After (hours)
                                    </label>
                                    <input
                                        type="number"
                                        value={expiresInHours}
                                        onChange={e => setExpiresInHours(e.target.value)}
                                        placeholder="Leave empty for no expiration"
                                        min={1}
                                        className="w-full border-2 border-black rounded-lg px-3 py-2 text-sm"
                                    />
                                </div>

                                {/* Permissions */}
                                <div className="flex gap-4">
                                    <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={allowDownload}
                                            onChange={e => setAllowDownload(e.target.checked)}
                                            className="w-4 h-4"
                                        />
                                        <Download size={14} /> Allow Download
                                    </label>
                                    <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={allowReshare}
                                            onChange={e => setAllowReshare(e.target.checked)}
                                            className="w-4 h-4"
                                        />
                                        <Share2 size={14} /> Allow Reshare
                                    </label>
                                </div>

                                {error && (
                                    <div className="bg-red-50 border-2 border-red-300 rounded-lg p-2 text-xs text-red-700 font-bold">
                                        {error}
                                    </div>
                                )}

                                <button
                                    onClick={handleCreate}
                                    disabled={isCreating}
                                    className="w-full py-3 bg-brand-blue text-white font-display text-lg rounded-xl border-4 border-black shadow-comic hover:shadow-[6px_6px_0px_0px_#000] transition-all disabled:opacity-50"
                                >
                                    {isCreating ? 'Creating...' : 'Create Share Link'}
                                </button>
                            </>
                        ) : (
                            /* Active Shares List */
                            <div className="space-y-3">
                                {activeShares.length === 0 ? (
                                    <p className="text-center text-slate-500 text-sm py-6">No active shares yet</p>
                                ) : (
                                    activeShares.map(share => (
                                        <div key={share.id} className="border-2 border-black rounded-lg p-3 bg-slate-50">
                                            <div className="flex items-center justify-between mb-2">
                                                <div className="flex items-center gap-2">
                                                    {share.share_type === 'public' ? <Globe size={14} className="text-brand-blue" /> : <Lock size={14} className="text-orange-500" />}
                                                    <span className="text-xs font-bold uppercase">{share.share_type}</span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <button
                                                        onClick={() => copyLink(share.share_token, share.id)}
                                                        className="p-1 hover:bg-brand-blue/10 rounded"
                                                        title="Copy link"
                                                    >
                                                        <Copy size={14} className={copiedId === share.id ? 'text-green-600' : ''} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleRevoke(share.id)}
                                                        className="p-1 hover:bg-red-100 rounded text-red-500"
                                                        title="Revoke"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="text-[10px] text-slate-500 space-y-0.5">
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
