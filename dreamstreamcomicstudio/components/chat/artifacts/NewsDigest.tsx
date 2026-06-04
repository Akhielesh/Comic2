import React, { useState } from 'react';
import { Newspaper, ExternalLink } from 'lucide-react';
import type { NewsResultsArtifact, NewsItem } from '../../../apiTypes';
import { Surface, Badge, relativeTime } from './kit';

// Compact news digest. Deliberately small and information-dense: a tight, source-
// branded list where each row carries the headline + source/time + a one-line gist
// (the snippet) — not a giant hero image and a wall of bare URL+title rows. The
// model's prose carries the synthesis; this card is the quiet, scannable source list.

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
  return `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 70% 42%))`;
};
const initials = (s?: string): string =>
  (s || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const SENTIMENT: Record<NonNullable<NewsItem['sentiment']>, string> = {
  positive: '#059669',
  neutral: '#64748b',
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
    return <img src={fav} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} className="rounded-sm" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="flex items-center justify-center rounded-sm text-[7px] font-extrabold text-white"
      style={{ width: size, height: size, background: seededGradient(item.source || hostOf(item.url)) }}
    >
      {initials(item.source || hostOf(item.url))}
    </span>
  );
};

const meta = (item: NewsItem): string =>
  [item.source || hostOf(item.url), relativeTime(item.publishedAt), item.readMinutes ? `${item.readMinutes} min` : '']
    .filter(Boolean)
    .join(' · ');

const PREVIEW = 5;

export const NewsDigest: React.FC<{ data: NewsResultsArtifact }> = ({ data }) => {
  const items = data.items ?? [];
  const [showAll, setShowAll] = useState(false);
  if (!items.length) return null;
  const visible = showAll ? items : items.slice(0, PREVIEW);

  return (
    <Surface
      header={
        <span className="flex items-center gap-1.5 text-[12px] font-extrabold uppercase tracking-wide">
          <Newspaper className="h-4 w-4" /> {heading(data)}
        </span>
      }
      right={<span className="text-[11px] font-semibold text-slate-400">{items.length} stories</span>}
    >
      <ul className="divide-y divide-slate-100 border-t-2 border-black/10">
        {visible.map((n, i) => (
          <li key={`${n.url}-${i}`}>
            <a href={n.url} target="_blank" rel="noopener noreferrer" className="group flex gap-2 px-3 py-2 transition-colors hover:bg-amber-50/60">
              <span className="pt-0.5">
                <SourceIcon item={n} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-bold leading-snug text-slate-800 line-clamp-2 group-hover:underline">
                  {n.title}
                  <ExternalLink className="ml-1 inline h-3 w-3 align-[-1px] opacity-0 group-hover:opacity-50" />
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">
                  <span className="truncate">{meta(n)}</span>
                  {n.sentiment && <Badge color={SENTIMENT[n.sentiment]}>{n.sentiment}</Badge>}
                </span>
                {n.snippet && <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 line-clamp-2">{n.snippet}</span>}
              </span>
              {n.image && <img src={n.image} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-md border border-black/10 object-cover" />}
            </a>
          </li>
        ))}
      </ul>
      {items.length > PREVIEW && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full border-t border-black/10 bg-slate-50 py-1.5 text-[10px] font-bold text-slate-500 transition-colors hover:bg-slate-100"
        >
          {showAll ? 'Show less' : `Show ${items.length - PREVIEW} more`}
        </button>
      )}
    </Surface>
  );
};
