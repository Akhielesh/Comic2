import React, { useState } from 'react';
import { Newspaper } from 'lucide-react';
import type { NewsResultsArtifact, NewsItem } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, relativeTime, useCompact, useLiveData } from './kit';

// News digest, rebuilt in the calm-studio language.
//  • compact — the top 3 headlines with source + time. No images, no controls:
//    a pure glance card.
//  • detailed — a lead story (with image when available) above clean divided rows:
//    headline, source favicon, relative time, a tiny tinted sentiment dot + label,
//    and read minutes. "Show all" expansion preserved.
//  • live — when the live-data context can re-run the producing get_news call,
//    the detailed view grows a topic chip row: clicking a chip re-queries the tool
//    with that topic (no model round-trip) and the card re-renders with fresh data.

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const faviconUrl = (url: string): string | null => {
  const host = hostOf(url);
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null;
};
const seededGradient = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 45% 60%), hsl(${(h + 40) % 360} 45% 48%))`;
};
const initials = (s?: string): string =>
  (s || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const SENTIMENT: Record<NonNullable<NewsItem['sentiment']>, string> = {
  positive: '#059669',
  neutral: '#6e6a60',
  negative: '#dc2626'
};

const heading = (data: NewsResultsArtifact): string => {
  if (data.query) return `“${data.query}”`;
  if (data.topic) return `${data.topic.charAt(0).toUpperCase()}${data.topic.slice(1)} headlines`;
  return 'Top headlines';
};

const SourceIcon: React.FC<{ item: NewsItem; size?: number }> = ({ item, size = 16 }) => {
  const [failed, setFailed] = useState(false);
  const fav = faviconUrl(item.url);
  if (fav && !failed) {
    return <img src={fav} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} className="rounded ring-1 ring-[var(--ds-hairline-soft)]" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="flex items-center justify-center rounded text-[7px] font-bold text-white"
      style={{ width: size, height: size, background: seededGradient(item.source || hostOf(item.url)) }}
    >
      {initials(item.source || hostOf(item.url))}
    </span>
  );
};

/** Tiny tinted dot + label for the item's coarse sentiment. */
const SentimentMark: React.FC<{ sentiment: NonNullable<NewsItem['sentiment']> }> = ({ sentiment }) => (
  <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium capitalize" style={{ color: SENTIMENT[sentiment] }}>
    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SENTIMENT[sentiment] }} />
    {sentiment}
  </span>
);

/** "Source · 3h ago · 4 min" meta line pieces (joined with hairline dots). */
const MetaLine: React.FC<{ item: NewsItem; showSentiment?: boolean }> = ({ item, showSentiment = true }) => {
  const time = relativeTime(item.publishedAt);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--ds-muted)]">
      <span className="truncate font-medium">{item.source || hostOf(item.url)}</span>
      {time && <span className="shrink-0">· {time}</span>}
      {item.readMinutes ? <span className="shrink-0">· {item.readMinutes} min</span> : null}
      {showSentiment && item.sentiment && (
        <>
          <span className="shrink-0 text-[var(--ds-faint)]">·</span>
          <SentimentMark sentiment={item.sentiment} />
        </>
      )}
    </span>
  );
};

const PREVIEW = 5;

// Topic chips mirror the server's get_news `topic` enum (the subset that maps to a
// stable Google News section). Label is display-only; id is the tool argument.
const TOPICS: { id: string; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'world', label: 'World' },
  { id: 'business', label: 'Business' },
  { id: 'technology', label: 'Tech' },
  { id: 'science', label: 'Science' },
  { id: 'sports', label: 'Sports' },
  { id: 'health', label: 'Health' }
];

export const NewsDigest: React.FC<{ data: NewsResultsArtifact }> = ({ data }) => {
  const compact = useCompact();
  const live = useLiveData();
  const items = data.items ?? [];
  const [showAll, setShowAll] = useState(false);
  if (!items.length) return null;

  const updated = live.asOf ? relativeTime(live.asOf) : '';
  // Only a topical feed (no free-text query) lights up a chip.
  const activeTopic = !data.query && data.topic ? data.topic.toLowerCase() : undefined;
  const headerRight = (
    <span className="flex flex-col items-end">
      <SurfaceSubtitle>{items.length} stories</SurfaceSubtitle>
      {updated && <span className="text-[9px] text-[var(--ds-muted)]">Updated {updated}</span>}
    </span>
  );

  // ── Compact: top 3 headlines, source + time. ────────────────────────────────
  if (compact) {
    return (
      <Surface
        header={
          <span className="flex min-w-0 items-center gap-1.5">
            <Newspaper className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" />
            <SurfaceTitle>{heading(data)}</SurfaceTitle>
          </span>
        }
        right={headerRight}
      >
        <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {items.slice(0, 3).map((n, i) => (
            <li key={`${n.url}-${i}`}>
              <a href={n.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 px-3 py-1.5 transition-colors duration-200 hover:bg-[var(--ds-well)]">
                <span className="mt-0.5 shrink-0">
                  <SourceIcon item={n} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium leading-snug text-[var(--ds-ink)]">{n.title}</span>
                  <MetaLine item={n} showSentiment={false} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      </Surface>
    );
  }

  // ── Detailed: lead story + divided rows. ────────────────────────────────────
  const [lead, ...rest] = items;
  const visibleRest = showAll ? rest : rest.slice(0, PREVIEW - 1);
  const hiddenCount = rest.length - visibleRest.length;

  return (
    <Surface
      header={
        <span className="flex min-w-0 items-center gap-1.5">
          <Newspaper className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
          <SurfaceTitle>{heading(data)}</SurfaceTitle>
        </span>
      }
      right={headerRight}
    >
      {/* Topic chips — live re-query of the producing get_news call, no model round-trip. */}
      {live.canRefresh && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {TOPICS.map((t) => {
            const active = t.id === activeTopic;
            return (
              <button
                key={t.id}
                disabled={live.refreshing}
                onClick={() => void live.refresh({ topic: t.id, query: undefined })}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors duration-200 disabled:cursor-default disabled:opacity-60 ${
                  active
                    ? 'border-transparent bg-[var(--ds-ink)] text-[var(--ds-canvas)]'
                    : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                }`}
                aria-pressed={active}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Subtle shimmer while a topic refresh is in flight. */}
      <div className={`transition-opacity duration-200 ${live.refreshing ? 'pointer-events-none animate-pulse opacity-50' : ''}`}>
      {/* Lead story */}
      <a href={lead.url} target="_blank" rel="noopener noreferrer" className="block px-3 pb-2.5 pt-1 transition-colors duration-200 hover:bg-[var(--ds-well)]">
        {lead.image && (
          <img src={lead.image} alt="" loading="lazy" className="mb-2 aspect-[2/1] w-full rounded-xl object-cover ring-1 ring-[var(--ds-hairline-soft)]" />
        )}
        <span className="block text-sm font-semibold leading-snug tracking-tight text-[var(--ds-ink)] line-clamp-2">{lead.title}</span>
        <span className="mt-1 flex items-center gap-1.5">
          <SourceIcon item={lead} size={14} />
          <MetaLine item={lead} />
        </span>
        {lead.snippet && <span className="mt-1 block text-[11px] leading-snug text-[var(--ds-muted)] line-clamp-2">{lead.snippet}</span>}
      </a>

      {/* Remaining stories as clean divided rows */}
      {visibleRest.length > 0 && (
        <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {visibleRest.map((n, i) => (
            <li key={`${n.url}-${i}`}>
              <a href={n.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 px-3 py-2 transition-colors duration-200 hover:bg-[var(--ds-well)]">
                <span className="mt-0.5 shrink-0">
                  <SourceIcon item={n} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-snug text-[var(--ds-ink)] line-clamp-2">{n.title}</span>
                  <span className="mt-0.5 block">
                    <MetaLine item={n} />
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {(hiddenCount > 0 || showAll) && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] py-1.5 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
        >
          {showAll ? 'Show less' : `Show all ${items.length}`}
        </button>
      )}
      </div>
    </Surface>
  );
};
