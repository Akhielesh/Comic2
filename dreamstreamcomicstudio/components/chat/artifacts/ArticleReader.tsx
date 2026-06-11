import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, ExternalLink, X, Newspaper } from 'lucide-react';
import { readArticle, type ReadArticleResult } from '../../../services/chatApi';
import type { NewsItem } from '../../../apiTypes';

// In-app article reader — opens a focused, scrollable overlay with the extracted
// readable content (server-side reader mode) so a news item is read in-window instead
// of bouncing to a new tab. Portaled to <body> so it escapes any transformed/clipped
// ancestor; Esc / backdrop closes it. Falls back to the snippet + "open original" when
// extraction is thin (paywalls, JS-only sites).

export const ArticleReader: React.FC<{ item: NewsItem; onClose: () => void }> = ({ item, onClose }) => {
  const [state, setState] = useState<{ loading: boolean; data: ReadArticleResult | null }>({ loading: true, data: null });

  useEffect(() => {
    let active = true;
    setState({ loading: true, data: null });
    readArticle(item.url).then((data) => {
      if (active) setState({ loading: false, data });
    });
    return () => {
      active = false;
    };
  }, [item.url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const data = state.data;
  const hasBody = !!data && data.ok && data.blocks.length > 0;
  const title = data?.title || item.title;
  const image = data?.image || item.image;
  const host = data?.host || (() => { try { return new URL(item.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm animate-fade-in sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <article
        className="relative my-2 w-full max-w-2xl animate-scale-in rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-2xl backdrop-blur-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky header — source + close, so controls stay reachable while scrolling. */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-4 py-2.5 backdrop-blur-md">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--ds-muted)]">
            <Newspaper className="h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" />
            <span className="truncate">{[item.source || host, item.readMinutes ? `${item.readMinutes} min` : null].filter(Boolean).join(' · ')}</span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open original"
              className="rounded-lg p-1.5 text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="rounded-lg p-1.5 text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="px-5 py-4 sm:px-7 sm:py-6">
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-[var(--ds-ink)] sm:text-2xl">{title}</h1>
          <p className="mt-1.5 text-[12px] text-[var(--ds-muted)]">
            {[data?.byline, host].filter(Boolean).join(' · ')}
          </p>

          {image && (
            <img
              src={image}
              alt=""
              loading="lazy"
              className="mt-4 aspect-[16/9] w-full rounded-xl object-cover ring-1 ring-[var(--ds-hairline-soft)]"
            />
          )}

          {state.loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[var(--ds-muted)]">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--ds-accent)]" />
              <span className="text-sm">Loading the article…</span>
            </div>
          ) : hasBody ? (
            <div className="mt-4 space-y-3">
              {data!.blocks.map((b, i) =>
                b.type === 'h' ? (
                  <h2 key={i} className="pt-1 text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">{b.text}</h2>
                ) : (
                  <p key={i} className="text-[15px] leading-relaxed text-[var(--ds-ink)] opacity-90">{b.text}</p>
                )
              )}
              <p className="border-t border-[var(--ds-hairline-soft)] pt-3 text-[12px] text-[var(--ds-muted)]">
                Extracted for in-app reading.{' '}
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--ds-accent)] hover:underline">
                  Read the full article at {host} ↗
                </a>
              </p>
            </div>
          ) : (
            // Extraction too thin (paywall / JS-only) → show what we have + a clear out.
            <div className="mt-4">
              {item.snippet && <p className="text-[15px] leading-relaxed text-[var(--ds-ink)] opacity-90">{item.snippet}</p>}
              <div className="mt-4 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-4 py-3 text-[13px] text-[var(--ds-muted)]">
                This article couldn’t be fully loaded for in-app reading (it may be paywalled or load its text with scripts).{' '}
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--ds-accent)] hover:underline">
                  Open it at {host} ↗
                </a>
              </div>
            </div>
          )}
        </div>
      </article>
    </div>,
    document.body
  );
};
