import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Link2Off, Loader2, Lock, LogIn, RefreshCw } from 'lucide-react';
import { get } from '../services/apiClient';
import { Project } from '../types';
import { ComicReader } from './ComicReader';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ds/Button';
import { SPINNER, STATE_DESCRIPTION, STATE_TITLE, StateIconTile } from './ds/stateParts';
import { cn } from '../lib/utils';

interface SharedViewerProps {
    shareToken: string;
    onNavigate?: (view: string, id?: string) => void;
    onOpenPrivacy: () => void;
    onOpenTerms: () => void;
    onOpenFaq: () => void;
}

/** Sign in, then come back to this link: App's ?next= hand-back follows a same-origin path after sign-in. */
export const signInHref = (shareToken: string): string => `/?next=${encodeURIComponent(`/share/${shareToken}`)}`;

/**
 * What a legacy share link (/share/<token>) shows before the comic opens, in the Atlas state views:
 * - `loading`: the link is being checked;
 * - `login_required`: the owner asks readers to sign in (401, or `loginRequired` on another status);
 * - `not_active`: the link no longer opens a comic for this reader: revoked or never existed (404), expired
 *   (410), not shared with this account (403), or a Comic Studio comic that has its own studio link (409);
 * - `error`: it could not be opened right now (offline, a server error): the reader may try again.
 */
export type SharedViewerNotice =
    | { status: 'loading' }
    | { status: 'login_required' }
    | { status: 'not_active'; reason: 'gone' | 'expired' | 'no_access' | 'studio' }
    | { status: 'error'; message?: string };

type ViewerState = SharedViewerNotice | { status: 'ready'; project: Project; allowDownload: boolean };

/** Reads a failed GET /shares/token/:token into the state the reader sees (server/src/routes/sharing.ts). */
export const sharedViewerNoticeFor = (err: unknown): Exclude<SharedViewerNotice, { status: 'loading' }> => {
    const apiErr = (err ?? {}) as { status?: number; message?: string; details?: { loginRequired?: boolean } };
    const message = typeof apiErr.message === 'string' && apiErr.message.trim() ? apiErr.message.trim() : undefined;
    if (apiErr.status === 401 || apiErr.details?.loginRequired) return { status: 'login_required' };
    if (apiErr.status === 404) return { status: 'not_active', reason: 'gone' };
    if (apiErr.status === 410) return { status: 'not_active', reason: 'expired' };
    if (apiErr.status === 403) return { status: 'not_active', reason: 'no_access' };
    if (apiErr.status === 409) return { status: 'not_active', reason: 'studio' };
    return { status: 'error', message };
};

const NOT_ACTIVE_COPY: Record<'gone' | 'expired' | 'no_access' | 'studio', { title: string; body: string }> = {
    gone: { title: 'This link isn’t active', body: 'The person who shared it may have turned it off. Ask them for a new link.' },
    expired: { title: 'This link has expired', body: 'Shared links can be set to end after a while. Ask the person who shared it for a new one.' },
    no_access: { title: 'This comic isn’t shared with you', body: 'It was shared with specific people. If you think that includes you, sign in with that account or ask the creator.' },
    studio: { title: 'This comic has a newer link', body: 'It’s shared from Comic Studio now. Ask the creator for its studio link.' }
};

export interface SharedViewerStateViewProps {
    notice: SharedViewerNotice;
    /** Sign in on this site and come back to the link. */
    onSignIn?: () => void;
    /** Check the link again (a reader's choice; nothing retries on its own). */
    onRetry?: () => void;
    onGoHome?: () => void;
    /** The page heading level: h1 on the page itself; lower where several states share a page (the QA scene). */
    headingLevel?: 1 | 2;
}

/**
 * One state of the share page, without the page around it (SharedViewer wraps it in the page's <main>):
 * the icon tile, a plain title and the next step, centred on the canvas. Calm words, never a red banner.
 */
export const SharedViewerStateView: React.FC<SharedViewerStateViewProps> = ({ notice, onSignIn, onRetry, onGoHome, headingLevel = 1 }) => {
    const H = headingLevel === 1 ? 'h1' : 'h2';
    const goHome = onGoHome ? (
        <Button variant="ghost" onClick={onGoHome}>
            <ArrowLeft aria-hidden /> Go home
        </Button>
    ) : null;

    if (notice.status === 'loading') {
        return (
            <div role="status" data-shared-state="loading" className="flex min-w-0 flex-col items-center gap-2 text-center">
                <StateIconTile>
                    <Loader2 className={SPINNER} />
                </StateIconTile>
                <H className={STATE_TITLE}>Opening the shared comic…</H>
                <p className={STATE_DESCRIPTION}>Checking the link.</p>
            </div>
        );
    }

    let icon: React.ReactNode;
    let title: string;
    let body: string;
    let actions: React.ReactNode;
    if (notice.status === 'login_required') {
        icon = <Lock />;
        title = 'Sign in to read this comic';
        body = 'The creator shares this comic with signed-in readers. Sign in or create an account, and you’ll come straight back here.';
        actions = (
            <>
                {onSignIn ? (
                    <Button size="lg" onClick={onSignIn}>
                        <LogIn aria-hidden /> Sign in
                    </Button>
                ) : null}
                {goHome}
            </>
        );
    } else if (notice.status === 'not_active') {
        const copy = NOT_ACTIVE_COPY[notice.reason];
        icon = notice.reason === 'no_access' ? <Lock /> : <Link2Off />;
        title = copy.title;
        body = copy.body;
        actions = goHome;
    } else {
        icon = <RefreshCw />;
        title = 'We couldn’t open this comic';
        body = 'Something got in the way while checking the link. Check your connection, then try again.';
        actions = (
            <>
                {onRetry ? (
                    <Button size="lg" variant="outline" onClick={onRetry}>
                        <RefreshCw aria-hidden /> Try again
                    </Button>
                ) : null}
                {goHome}
            </>
        );
    }

    return (
        <div role="status" data-shared-state={notice.status} className="flex min-w-0 flex-col items-center gap-2 text-center">
            <StateIconTile>{icon}</StateIconTile>
            <H className={STATE_TITLE}>{title}</H>
            <p className={cn(STATE_DESCRIPTION, 'max-w-md')}>{body}</p>
            {notice.status === 'error' && notice.message ? (
                <p className="m-0 max-w-md text-[length:var(--ds-text-sm)] text-[var(--ds-muted)] [overflow-wrap:anywhere]">{notice.message}</p>
            ) : null}
            {actions ? <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
        </div>
    );
};

/** The share page around a state: the canvas, centred, with the one <main>. */
const SHARED_PAGE = 'flex min-h-[100dvh] min-w-0 flex-col items-center justify-center bg-[var(--ds-canvas)] px-4 py-12 text-[var(--ds-ink)] sm:px-6';

export const SharedViewer: React.FC<SharedViewerProps> = ({
    shareToken,
    onNavigate,
    onOpenPrivacy,
    onOpenTerms,
    onOpenFaq,
}) => {
    const { user } = useAuth();
    const [state, setState] = useState<ViewerState>({ status: 'loading' });
    // A reader's "Try again" asks for the link once more (never a timer).
    const [attempt, setAttempt] = useState(0);
    const retry = useCallback(() => setAttempt((n) => n + 1), []);

    useEffect(() => {
        let active = true;
        const validate = async () => {
            setState({ status: 'loading' });
            try {
                const res = await get<{ project: Project; share: { allowDownload: boolean } }>(
                    `/shares/token/${shareToken}`
                );
                if (!active) return;
                setState({
                    status: 'ready',
                    project: res.project,
                    allowDownload: res.share.allowDownload,
                });
            } catch (err: unknown) {
                if (active) setState(sharedViewerNoticeFor(err));
            }
        };
        validate();
        return () => {
            active = false;
        };
    }, [shareToken, user?.id, attempt]);

    if (state.status !== 'ready') {
        return (
            <main className={SHARED_PAGE} aria-busy={state.status === 'loading' || undefined}>
                <SharedViewerStateView
                    notice={state}
                    onSignIn={() => window.location.assign(signInHref(shareToken))}
                    onRetry={retry}
                    onGoHome={() => onNavigate?.('home')}
                />
            </main>
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
