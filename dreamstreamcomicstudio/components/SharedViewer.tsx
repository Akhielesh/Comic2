import React, { useEffect, useState } from 'react';
import { get } from '../services/apiClient';
import { Project } from '../types';
import { ComicReader } from './ComicReader';
import { useAuth } from '../contexts/AuthContext';
import { Loader2, Lock, AlertTriangle, LogIn } from 'lucide-react';

interface SharedViewerProps {
    shareToken: string;
    onNavigate?: (view: string, id?: string) => void;
    onOpenPrivacy: () => void;
    onOpenTerms: () => void;
    onOpenFaq: () => void;
}

type ViewerState =
    | { status: 'loading' }
    | { status: 'login_required' }
    | { status: 'error'; message: string }
    | { status: 'ready'; project: Project; allowDownload: boolean };

export const SharedViewer: React.FC<SharedViewerProps> = ({
    shareToken,
    onNavigate,
    onOpenPrivacy,
    onOpenTerms,
    onOpenFaq,
}) => {
    const { user } = useAuth();
    const [state, setState] = useState<ViewerState>({ status: 'loading' });

    useEffect(() => {
        const validate = async () => {
            setState({ status: 'loading' });
            try {
                const res = await get<{ project: Project; share: { allowDownload: boolean } }>(
                    `/shares/token/${shareToken}`
                );
                setState({
                    status: 'ready',
                    project: res.project,
                    allowDownload: res.share.allowDownload,
                });
            } catch (err: unknown) {
                const apiErr = err as { status?: number; message?: string; details?: { loginRequired?: boolean } };
                if (apiErr.status === 401 || apiErr.details?.loginRequired) {
                    setState({ status: 'login_required' });
                } else {
                    setState({ status: 'error', message: apiErr.message || 'Failed to load shared comic' });
                }
            }
        };
        validate();
    }, [shareToken, user?.id]);

    if (state.status === 'loading') {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white gap-4">
                <Loader2 size={48} className="animate-spin text-brand-blue" />
                <p className="text-lg font-display">Loading shared comic...</p>
            </div>
        );
    }

    if (state.status === 'login_required') {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white gap-6">
                <Lock size={64} className="text-brand-yellow" />
                <h1 className="text-3xl font-display">Sign In Required</h1>
                <p className="text-slate-400 max-w-md text-center">
                    You need to be logged in to view this shared comic. Sign in or create an account to continue.
                </p>
                <button
                    onClick={() => onNavigate?.('login')}
                    className="flex items-center gap-2 bg-brand-blue text-white px-6 py-3 rounded-xl border-4 border-white/20 font-display text-lg hover:bg-brand-blue/80 transition-colors shadow-comic"
                >
                    <LogIn size={20} /> Sign In
                </button>
            </div>
        );
    }

    if (state.status === 'error') {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 text-white gap-6">
                <AlertTriangle size={64} className="text-red-400" />
                <h1 className="text-3xl font-display">Access Denied</h1>
                <p className="text-slate-400 max-w-md text-center">{state.message}</p>
                <button
                    onClick={() => onNavigate?.('home')}
                    className="bg-white text-black px-6 py-3 rounded-xl border-4 border-black font-display hover:bg-slate-100 transition-colors"
                >
                    Go Home
                </button>
            </div>
        );
    }

    return (
        <ComicReader
            project={state.project}
            onClose={() => onNavigate?.('home')}
            onUpdateProject={() => { }}
            isReadOnly={true}
            allowDownload={state.allowDownload}
            onNavigate={onNavigate}
            onOpenPrivacy={onOpenPrivacy}
            onOpenTerms={onOpenTerms}
            onOpenFaq={onOpenFaq}
        />
    );
};
