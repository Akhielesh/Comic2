import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X, Newspaper } from 'lucide-react';
import type { NewsItem } from '../../../apiTypes';
import {
  ArticleBlocks,
  ArticleFooter,
  ArticleSkeleton,
  ArticleUnavailable,
  articleHost,
  articleHref,
  useArticle
} from './NewsReader';

// In-app article reader — opens a focused, scrollable overlay with the extracted
// readable content (server-side reader mode) so a news item is read in-window instead
// of bouncing to a new tab. Portaled to <body> so it escapes any transformed/clipped
// ancestor; Esc / backdrop closes it. Falls back to the snippet + "open original" when
// extraction is thin (paywalls, JS-only sites).
//
// Shares its loading skeleton, typography, host resolution (real publisher host, never
// news.google.com when a resolved host exists) and fallback messaging with the split-pane
// reader via ./NewsReader.

export const ArticleReader: React.FC<{ item: NewsItem; onClose: () => void }> = ({ item, onClose }) => {
  const { loading, article } = useArticle(item.url);

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

  const hasBody = !!article && article.ok && article.blocks.length > 0;
  const title = article?.title || item.title;
  const image = article?.image || item.image;
  // Real publisher host (server-resolved when the item URL was a news.google.com
  // redirect) and the best outbound link to match it.
  const host = articleHost(item, article);
  const href = articleHref(item, article);

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
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open at ${host}`}
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
            {[article?.byline, host].filter(Boolean).join(' · ')}
          </p>

          {image && (
            <img
              src={image}
              alt=""
              loading="lazy"
              className="mt-4 aspect-[16/9] w-full rounded-xl object-cover ring-1 ring-[var(--ds-hairline-soft)]"
            />
          )}

          <div className="mt-4">
            {loading ? (
              <ArticleSkeleton withImage={!image} />
            ) : hasBody ? (
              <>
                <ArticleBlocks blocks={article.blocks} />
                <ArticleFooter host={host} href={href} className="mt-4" />
              </>
            ) : (
              // Extraction too thin (paywall / JS-only) → show what we have + a clear out.
              <ArticleUnavailable item={item} host={host} href={href} />
            )}
          </div>
        </div>
      </article>
    </div>,
    document.body
  );
};
