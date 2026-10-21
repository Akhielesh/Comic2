// Public reader for a published v4 comic (/api/comic/public/:id): title and logline, then
// the comic in the reader. Honest states for loading, "not published / not found" and
// network trouble; signed image links that expire mid-read are refreshed automatically.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, RotateCcw, X } from 'lucide-react';
import type { AssetRef, ComicDoc } from '../../shared/comic/doc';
import { CANVAS_BG } from '../chat/studioDesign';
import { Skeleton } from '../studio/kit/Shimmer';
import { GhostButton, IconButton, cx } from './board/ui';
import { ComicReaderView } from './reader/ComicReaderView';
import { loadPublicComic } from './studioApi';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: ComicDoc; urls: Record<string, string> }
  | { kind: 'error'; message: string; notFound: boolean };

/** Don't refresh links more often than this when images fail. */
const RELINK_COOLDOWN_MS = 60_000;

const errorInfo = (err: unknown): { message: string; notFound: boolean } => {
  const e = (err && typeof err === 'object' ? err : {}) as { kind?: string; status?: number; message?: string };
  const notFound = e.kind === 'not_found' || e.status === 404 || e.kind === 'forbidden' || e.status === 403;
  if (notFound) return { message: "This comic isn't published, or its creator made it private.", notFound: true };
  return { message: e.message || 'Couldn’t load this comic. Check your connection and try again.', notFound: false };
};

export const PublicComicReader: React.FC<{ projectId: string; onClose?: () => void }> = ({ projectId, onClose }) => {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const abortRef = useRef<AbortController | null>(null);
  const lastRelink = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (!quiet) setState({ kind: 'loading' });
      try {
        const res = await loadPublicComic(projectId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState({ kind: 'ready', doc: res.doc, urls: res.urls || {} });
      } catch (err) {
        if (controller.signal.aborted || (err as { kind?: string })?.kind === 'aborted') return;
        // A failed quiet refresh keeps the comic on screen.
        if (quiet) return;
        setState({ kind: 'error', ...errorInfo(err) });
      }
    },
    [projectId]
  );

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const urls = state.kind === 'ready' ? state.urls : null;
  const urlFor = useCallback(
    (asset?: AssetRef | string | null) => {
      if (!asset || !urls) return undefined;
      const path = typeof asset === 'string' ? asset : asset.path;
      if (!path) return undefined;
      if (/^(https?:|data:|blob:)/i.test(path)) return path;
      return urls[path];
    },
    [urls]
  );

  // Signed links expire: when an image fails, refetch quietly (rate-limited).
  const onImageError = useCallback(() => {
    const now = Date.now();
    if (now - lastRelink.current < RELINK_COOLDOWN_MS) return;
    lastRelink.current = now;
    void load(true);
  }, [load]);

  const doc = state.kind === 'ready' ? state.doc : null;

  return (
    <div className={cx('flex h-full min-h-[100dvh] flex-col', CANVAS_BG)} data-testid="public-comic-reader">
      <header className="flex shrink-0 items-start gap-3 border-b border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-4 py-3 backdrop-blur-md">
        <BookOpen className="mt-1 h-4 w-4 shrink-0 text-[var(--ds-accent)]" aria-hidden />
        <div className="min-w-0 flex-1">
          {doc ? (
            <>
              <h1 className="truncate text-[16px] font-semibold tracking-tight text-[var(--ds-ink)]">{doc.brief.title || 'Untitled comic'}</h1>
              {doc.brief.logline && <p className="line-clamp-2 text-[13px] leading-snug text-[var(--ds-muted)]">{doc.brief.logline}</p>}
            </>
          ) : state.kind === 'loading' ? (
            <div className="space-y-1.5 py-0.5" aria-hidden>
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
          ) : (
            <h1 className="text-[16px] font-semibold tracking-tight text-[var(--ds-ink)]">Comic</h1>
          )}
        </div>
        {onClose && (
          <IconButton label="Close reader" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        )}
      </header>

      <main className="min-h-0 flex-1">
        {state.kind === 'loading' && (
          <div className="flex h-full items-center justify-center p-6" role="status" aria-live="polite">
            <div className="w-full max-w-sm space-y-3">
              <Skeleton className="aspect-[2/3] w-full rounded-xl" />
              <p className="text-center text-[13px] text-[var(--ds-muted)]">Opening the comic…</p>
            </div>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="flex h-full items-center justify-center p-6">
            <div role="alert" className="max-w-md rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-6 text-center shadow-sm">
              <p className="text-[15px] font-semibold text-[var(--ds-ink)]">{state.notFound ? 'This comic isn’t available' : 'Couldn’t open this comic'}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ds-muted)]">{state.message}</p>
              <div className="mt-4 flex justify-center gap-2">
                {!state.notFound && (
                  <GhostButton size="sm" onClick={() => void load()}>
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Try again
                  </GhostButton>
                )}
                {onClose && (
                  <GhostButton size="sm" onClick={onClose}>
                    Close
                  </GhostButton>
                )}
              </div>
            </div>
          </div>
        )}
        {doc && <ComicReaderView doc={doc} urlFor={urlFor} onImageError={onImageError} />}
      </main>
    </div>
  );
};

export default PublicComicReader;
