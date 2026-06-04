import React, { useMemo, useState } from 'react';
import { Newspaper, ExternalLink, Clock } from 'lucide-react';
import type { NewsResultsArtifact, NewsItem } from '../../../apiTypes';
import { Surface, Badge, relativeTime } from './kit';

// Flagship news card: a lead story with imagery, source filter chips, favicon-
// branded headlines with relative time and expandable snippets. Imageless items
// fall back to a deterministic gradient seeded from the source, so the layout never
// shows an empty box.

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

// Deterministic hue from a string → a soft two-stop gradient for fallbacks.
const seededGradient = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 70% 42%))`;
};

const initials = (s?: string): string =>
  (s || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

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

// A small favicon chip with an initials fallback when the icon fails to load.
const SourceIcon: React.FC<{ item: NewsItem; size?: number }> = ({ item, size = 18 }) => {
  const [failed, setFailed] = useState(false);
  const fav = faviconUrl(item.url);
  if (fav && !failed) {
    return <img src={fav} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} className="rounded-sm" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="flex items-center justify-center rounded-sm text-[8px] font-extrabold text-white"
      style={{ width: size, height: size, background: seededGradient(item.source || hostOf(item.url)) }}
    >
      {initials(item.source || hostOf(item.url))}
    </span>
  );
};

const meta = (item: NewsItem): string =>
  [item.source, relativeTime(item.publishedAt), item.readMinutes ? `${item.readMinutes} min read` : '']
    .filter(Boolean)
    .join(' · ');

export const NewsDigest: React.FC<{ data: NewsResultsArtifact }> = ({ data }) => {
  const items = data.items ?? [];
  const [source, setSource] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) if (it.source) counts.set(it.source, (counts.get(it.source) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s]) => s);
  }, [items]);

  const filtered = source ? items.filter((i) => i.source === source) : items;
  if (!items.length) return null;

  const [lead, ...rest] = filtered;
  const toggle = (i: number) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  return (
    <Surface
      header={
        <span className="flex items-center gap-1.5 text-[12px] font-extrabold uppercase tracking-wide">
          <Newspaper className="h-4 w-4" /> {heading(data)}
        </span>
      }
      right={<span className="text-[11px] font-semibold text-slate-400">{filtered.length} stories</span>}
    >
      {/* Source filter chips */}
      {sources.length > 1 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          <button
            onClick={() => setSource(null)}
            aria-pressed={source === null}
            className={`rounded-full border-2 px-2.5 py-0.5 text-[11px] font-bold transition-colors ${source === null ? 'border-black bg-slate-900 text-white' : 'border-black/15 text-slate-600 hover:border-black/40'}`}
          >
            All
          </button>
          {sources.map((s) => (
            <button
              key={s}
              onClick={() => setSource((cur) => (cur === s ? null : s))}
              aria-pressed={source === s}
              className={`rounded-full border-2 px-2.5 py-0.5 text-[11px] font-bold transition-colors ${source === s ? 'border-black bg-brand-blue text-white' : 'border-black/15 text-slate-600 hover:border-black/40'}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Lead story */}
      {lead && (
        <a href={lead.url} target="_blank" rel="noopener noreferrer" className="group block border-t-2 border-black/10">
          <div className="relative h-32 w-full overflow-hidden" style={lead.image ? undefined : { background: seededGradient(lead.source || lead.title) }}>
            {lead.image ? (
              <img src={lead.image} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
            ) : (
              <span className="absolute right-3 top-2 text-4xl font-display text-white/30">{initials(lead.source)}</span>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
            <div className="absolute bottom-2 left-3 right-3 text-white">
              <div className="mb-1 flex items-center gap-1.5">
                <SourceIcon item={lead} />
                <span className="text-[11px] font-bold opacity-90">{meta(lead)}</span>
                {lead.sentiment && <Badge color={SENTIMENT[lead.sentiment]}>{lead.sentiment}</Badge>}
              </div>
              <div className="text-sm font-extrabold leading-snug drop-shadow group-hover:underline">{lead.title}</div>
            </div>
          </div>
          {lead.snippet && <p className="px-3 py-2 text-[12px] text-slate-600 line-clamp-2">{lead.snippet}</p>}
        </a>
      )}

      {/* Secondary headlines */}
      {rest.length > 0 && (
        <ul className="divide-y divide-slate-200 border-t-2 border-black/10">
          {rest.map((n, i) => {
            const isOpen = expanded.has(i);
            return (
              <li key={`${n.url}-${i}`} className="px-3 py-2 transition-colors hover:bg-amber-50/60">
                <div className="flex gap-2">
                  <span className="pt-0.5"><SourceIcon item={n} /></span>
                  <div className="min-w-0 flex-1">
                    <a href={n.url} target="_blank" rel="noopener noreferrer" className="group block text-[13px] font-bold leading-snug hover:underline">
                      {n.title}
                      <ExternalLink className="ml-1 inline h-3 w-3 align-[-1px] opacity-0 group-hover:opacity-60" />
                    </a>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                      <span className="truncate">{meta(n)}</span>
                      {n.sentiment && <Badge color={SENTIMENT[n.sentiment]}>{n.sentiment}</Badge>}
                    </div>
                    {n.snippet && (
                      <>
                        <p className={`mt-0.5 text-[11px] text-slate-600 ${isOpen ? '' : 'line-clamp-2'}`}>{n.snippet}</p>
                        {n.snippet.length > 120 && (
                          <button onClick={() => toggle(i)} className="mt-0.5 text-[10px] font-bold text-brand-blue hover:underline">
                            {isOpen ? 'Less' : 'More'}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-center gap-1 border-t-2 border-black/10 bg-slate-50 py-1.5 text-[10px] font-semibold text-slate-400">
        <Clock className="h-3 w-3" /> Updated {relativeTime(items[0]?.publishedAt) || 'recently'}
      </div>
    </Surface>
  );
};
