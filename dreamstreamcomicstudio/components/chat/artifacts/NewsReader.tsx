import React, { useCallback, useEffect, useRef, useState } from 'react';
import { readArticle, type ReadArticleResult } from '../../../services/chatApi';
import type { NewsItem } from '../../../apiTypes';
import { relativeTime } from './kit';

// Shared news-reading primitives — used by BOTH the split-pane reader inside
// NewsDigest (wide detailed cards) and the ArticleReader modal (narrow/compact),
// so loading, host resolution and fallback messaging stay identical everywhere.
//
// The server may attach `resolvedUrl` / `resolvedHost` to a read-url response when
// the input was a news.google.com redirect. Those fields are OPTIONAL and read
// defensively via `ResolvedArticle` — never assume they exist.

export type ResolvedArticle = ReadArticleResult & { resolvedUrl?: string; resolvedHost?: string };

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const GOOGLE_NEWS_HOST = /(^|\.)news\.google\.com$/i;

/**
 * The REAL publisher host for display: prefer the server-resolved host, then the
 * fetched host / URL host as long as it isn't the news.google.com redirector, then
 * the item's source name. Never shows "news.google.com" when something truer exists.
 */
export const articleHost = (item: NewsItem, article: ResolvedArticle | null): string => {
  if (article?.resolvedHost) return article.resolvedHost;
  const h = article?.host || hostOf(item.url);
  if (h && !GOOGLE_NEWS_HOST.test(h)) return h;
  return item.source || h || 'the source';
};

/** The best outbound link: the resolved publisher URL when known, else the item URL. */
export const articleHref = (item: NewsItem, article: ResolvedArticle | null): string =>
  article?.resolvedUrl || item.url;

/** Warm the per-URL readArticle cache (row hover/focus) so selection feels instant. */
export const prefetchArticle = (url: string): void => {
  void readArticle(url);
};

/** Fetch extracted reader content for a URL. Cached per URL by chatApi.readArticle. */
export const useArticle = (url: string): { loading: boolean; article: ResolvedArticle | null } => {
  const [state, setState] = useState<{ url: string; loading: boolean; article: ResolvedArticle | null }>({
    url,
    loading: true,
    article: null
  });

  useEffect(() => {
    let active = true;
    setState({ url, loading: true, article: null });
    void readArticle(url).then((data) => {
      if (active) setState({ url, loading: false, article: data as ResolvedArticle });
    });
    return () => {
      active = false;
    };
  }, [url]);

  // Never flash the previous article for one frame while the effect catches up.
  if (state.url !== url) return { loading: true, article: null };
  return { loading: state.loading, article: state.article };
};

// ── Reader content pieces ──────────────────────────────────────────────────────

/** Calm loading skeleton — shimmering text lines (+ image block), never a spinner. */
export const ArticleSkeleton: React.FC<{ withImage?: boolean }> = ({ withImage = true }) => (
  <div role="status" aria-label="Loading article" className="space-y-2.5 py-0.5">
    {withImage && <div className="studio-shimmer aspect-[16/9] w-full rounded-xl" />}
    <div className="studio-shimmer h-3.5 w-full rounded" />
    <div className="studio-shimmer h-3.5 w-[94%] rounded" />
    <div className="studio-shimmer h-3.5 w-full rounded" />
    <div className="studio-shimmer h-3.5 w-2/3 rounded" />
  </div>
);

/** Extracted blocks in comfortable reading typography. */
export const ArticleBlocks: React.FC<{ blocks: ReadArticleResult['blocks'] }> = ({ blocks }) => (
  <div className="space-y-3">
    {blocks.map((b, i) =>
      b.type === 'h' ? (
        <h2 key={i} className="pt-1 text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">{b.text}</h2>
      ) : (
        <p key={i} className="text-[15px] leading-relaxed text-[var(--ds-ink)] opacity-90">{b.text}</p>
      )
    )}
  </div>
);

/** Quiet attribution footer below a successful extraction. */
export const ArticleFooter: React.FC<{ host: string; href: string; className?: string }> = ({ host, href, className = '' }) => (
  <p className={`border-t border-[var(--ds-hairline-soft)] pt-3 text-[12px] text-[var(--ds-muted)] ${className}`}>
    Extracted for in-app reading.{' '}
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--ds-accent)] hover:underline">
      Read the full article at {host} ↗
    </a>
  </p>
);

/** Extraction-failed state: the snippet we already have + a quiet way out. Never a dead end. */
export const ArticleUnavailable: React.FC<{ item: NewsItem; host: string; href: string }> = ({ item, host, href }) => (
  <div>
    {item.snippet && <p className="text-[15px] leading-relaxed text-[var(--ds-ink)] opacity-90">{item.snippet}</p>}
    <div className={`${item.snippet ? 'mt-4' : 'mt-0.5'} rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-4 py-3 text-[13px] leading-relaxed text-[var(--ds-muted)]`}>
      This article couldn’t be fully loaded for in-app reading (it may be paywalled or load its text with scripts).{' '}
      <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-[var(--ds-accent)] hover:underline">
        Open it at {host} ↗
      </a>
    </div>
  </div>
);

// ── Selection-change entrance (quick fade/slide, ~180ms) ───────────────────────
// The kit's global keyframes don't include a small fade/slide, and this module may
// not touch index.css — so it registers its own once, with reduced-motion respected.

const STYLE_ID = 'ds-news-reader-styles';
const READER_CSS = [
  '@keyframes dsNewsReaderIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
  '.ds-news-reader-in{animation:dsNewsReaderIn 0.18s ease-out both}',
  '@media (prefers-reduced-motion: reduce){.ds-news-reader-in{animation:none}}'
].join('\n');

const ensureReaderStyles = (): void => {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = READER_CSS;
  document.head.appendChild(el);
};

// ── The reader pane (right side of the NewsDigest split) ───────────────────────

/**
 * In-card article reader: title → byline · real host · time → hero image → blocks,
 * with its own internal scroll and a 2px accent reading-progress bar pinned to the
 * pane's top edge. Content keyed by URL so selection changes replay the entrance.
 */
export const NewsReaderPane: React.FC<{ item: NewsItem }> = ({ item }) => {
  ensureReaderStyles();
  const { loading, article } = useArticle(item.url);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  const syncProgress = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 4 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0);
  }, []);

  // New story → back to the top, progress reset.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setProgress(0);
  }, [item.url]);

  const hasBody = !!article && article.ok && article.blocks.length > 0;
  const title = article?.title || item.title;
  const image = article?.image || item.image;
  const host = articleHost(item, article);
  const href = articleHref(item, article);
  const time = relativeTime(item.publishedAt);

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      {/* Reading progress — a thin accent bar tracking the pane's own scroll. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px]">
        <div
          className="h-full rounded-r-full bg-[var(--ds-accent)] transition-[width] duration-150 ease-out"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <div
        ref={scrollRef}
        onScroll={syncProgress}
        tabIndex={0}
        aria-label={`Article: ${item.title}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin] focus:outline-none"
      >
        <article key={item.url} className="ds-news-reader-in px-4 pb-4 pt-3 sm:px-5">
          <h2 className="text-[17px] font-semibold leading-snug tracking-tight text-[var(--ds-ink)]">{title}</h2>
          <p className="mt-1 text-[12px] text-[var(--ds-muted)]">
            {[article?.byline, host, time].filter(Boolean).join(' · ')}
          </p>

          {image && (
            <img
              src={image}
              alt=""
              loading="lazy"
              className="mt-3 aspect-[16/9] w-full rounded-xl object-cover ring-1 ring-[var(--ds-hairline-soft)]"
            />
          )}

          <div className="mt-3">
            {loading ? (
              <ArticleSkeleton withImage={!image} />
            ) : hasBody ? (
              <>
                <ArticleBlocks blocks={article.blocks} />
                <ArticleFooter host={host} href={href} className="mt-4" />
              </>
            ) : (
              <ArticleUnavailable item={item} host={host} href={href} />
            )}
          </div>
        </article>
      </div>
    </div>
  );
};
