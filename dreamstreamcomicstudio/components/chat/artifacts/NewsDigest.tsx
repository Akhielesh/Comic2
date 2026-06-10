import React, { useState } from 'react';
import { Newspaper } from 'lucide-react';
import type { NewsResultsArtifact, NewsItem } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, relativeTime, useCompact } from './kit';

// News digest, rebuilt in the calm-studio language.
//  • compact — the top 3 headlines with source + time. No images, no controls:
//    a pure glance card.
//  • detailed — a lead story (with image when available) above clean divided rows:
//    headline, source favicon, relative time, a tiny tinted sentiment dot + label,
//    and read minutes. "Show all" expansion preserved.

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
    return <img src={fav} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} className="rounded ring-1 ring-black/5" style={{ width: size, height: size }} />;
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
    <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-[#6e6a60]">
      <span className="truncate font-medium">{item.source || hostOf(item.url)}</span>
      {time && <span className="shrink-0">· {time}</span>}
      {item.readMinutes ? <span className="shrink-0">· {item.readMinutes} min</span> : null}
      {showSentiment && item.sentiment && (
        <>
          <span className="shrink-0 text-black/20">·</span>
          <SentimentMark sentiment={item.sentiment} />
        </>
      )}
    </span>
  );
};

const PREVIEW = 5;

export const NewsDigest: React.FC<{ data: NewsResultsArtifact }> = ({ data }) => {
  const compact = useCompact();
  const items = data.items ?? [];
  const [showAll, setShowAll] = useState(false);
  if (!items.length) return null;

  // ── Compact: top 3 headlines, source + time. ────────────────────────────────
  if (compact) {
    return (
      <Surface
        header={
          <span className="flex min-w-0 items-center gap-1.5">
            <Newspaper className="h-3.5 w-3.5 shrink-0 text-[#6e6a60]" />
            <SurfaceTitle>{heading(data)}</SurfaceTitle>
          </span>
        }
        right={<SurfaceSubtitle>{items.length} stories</SurfaceSubtitle>}
      >
        <ul className="divide-y divide-black/5 border-t border-black/5">
          {items.slice(0, 3).map((n, i) => (
            <li key={`${n.url}-${i}`}>
              <a href={n.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 px-3 py-1.5 transition-colors duration-200 hover:bg-black/[0.03]">
                <span className="mt-0.5 shrink-0">
                  <SourceIcon item={n} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium leading-snug text-[#1a1915]">{n.title}</span>
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
          <Newspaper className="h-4 w-4 shrink-0 text-[#6e6a60]" />
          <SurfaceTitle>{heading(data)}</SurfaceTitle>
        </span>
      }
      right={<SurfaceSubtitle>{items.length} stories</SurfaceSubtitle>}
    >
      {/* Lead story */}
      <a href={lead.url} target="_blank" rel="noopener noreferrer" className="block px-3 pb-2.5 pt-1 transition-colors duration-200 hover:bg-black/[0.03]">
        {lead.image && (
          <img src={lead.image} alt="" loading="lazy" className="mb-2 aspect-[2/1] w-full rounded-xl object-cover ring-1 ring-black/5" />
        )}
        <span className="block text-sm font-semibold leading-snug tracking-tight text-[#1a1915] line-clamp-2">{lead.title}</span>
        <span className="mt-1 flex items-center gap-1.5">
          <SourceIcon item={lead} size={14} />
          <MetaLine item={lead} />
        </span>
        {lead.snippet && <span className="mt-1 block text-[11px] leading-snug text-[#6e6a60] line-clamp-2">{lead.snippet}</span>}
      </a>

      {/* Remaining stories as clean divided rows */}
      {visibleRest.length > 0 && (
        <ul className="divide-y divide-black/5 border-t border-black/5">
          {visibleRest.map((n, i) => (
            <li key={`${n.url}-${i}`}>
              <a href={n.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 px-3 py-2 transition-colors duration-200 hover:bg-black/[0.03]">
                <span className="mt-0.5 shrink-0">
                  <SourceIcon item={n} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-snug text-[#1a1915] line-clamp-2">{n.title}</span>
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
          className="w-full border-t border-black/5 bg-black/[0.025] py-1.5 text-[11px] font-semibold text-[#6e6a60] transition-colors duration-200 hover:bg-black/5 hover:text-[#1a1915]"
        >
          {showAll ? 'Show less' : `Show all ${items.length}`}
        </button>
      )}
    </Surface>
  );
};
