import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Newspaper, Lock } from 'lucide-react';
import type { NewsResultsArtifact, NewsItem } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, relativeTime, useCompact, useLiveData } from './kit';
import { ArticleReader } from './ArticleReader';
import { NewsReaderPane, hostOf, prefetchArticle } from './NewsReader';

// News digest, rebuilt in the calm-studio language.
//  • compact — the top 3 headlines with source + time. No images, no controls:
//    a pure glance card.
//  • detailed + WIDE (the card itself measures ≥ 560px) — a master-detail split:
//    a scrollable headline list on the left, an in-card article reader on the
//    right (extracted content, reading-progress bar, ↑/↓ selection, hover
//    prefetch). Scroll the list, read on the right — like flipping through a feed.
//  • detailed + narrow — the classic lead story above clean divided rows; tapping
//    a story opens the ArticleReader modal overlay.
//  • live — when the live-data context can re-run the producing get_news call,
//    the detailed view grows a topic chip row: clicking a chip re-queries the tool
//    with that topic (no model round-trip); the split stays put and the first new
//    story is selected.

// The REAL publisher favicon. Prefer the feed-resolved publisher domain (e.g.
// "wsj.com"); never derive the icon from the news.google.com redirect host (that's
// what made every story show Google's logo). sz=128 stays crisp on retina at 16px.
const faviconFor = (item: NewsItem): string | null => {
  const host = hostOf(item.url);
  const domain = item.sourceDomain || (host && !/(^|\.)news\.google\.com$/i.test(host) ? host : '');
  return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` : null;
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
  neutral: 'var(--ds-muted)',
  negative: '#dc2626'
};

const heading = (data: NewsResultsArtifact): string => {
  if (data.query) return `“${data.query}”`;
  if (data.topic) return `${data.topic.charAt(0).toUpperCase()}${data.topic.slice(1)} headlines`;
  return 'Top headlines';
};

const SourceIcon: React.FC<{ item: NewsItem; size?: number }> = ({ item, size = 16 }) => {
  const [failed, setFailed] = useState(false);
  const fav = faviconFor(item);
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
      <span className="truncate font-medium">{item.source || item.sourceDomain || hostOf(item.url)}</span>
      {item.paywall && (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-[var(--ds-faint)]" title="Subscription / paywalled — full text may not load in-app">
          <Lock className="h-2.5 w-2.5" />
        </span>
      )}
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

// The card's OWN width (not the viewport) at which the detailed view becomes a
// master-detail split. Measured with a ResizeObserver so the same card adapts in
// the chat column, the two-up artifact grid, dashboard tiles and the lightbox.
const SPLIT_MIN_WIDTH = 560;

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
  // Which article is open in the modal reader (narrow/compact paths; null = none).
  const [reading, setReading] = useState<NewsItem | null>(null);

  // ── Width-aware layout: measure the card itself. ────────────────────────────
  const shellRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (compact) return;
    const el = shellRef.current;
    if (!el) return;
    const update = (w: number) => setWide(w >= SPLIT_MIN_WIDTH);
    update(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (typeof w === 'number') update(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact]);

  // ── Split-pane selection. Auto-select the first story on mount and whenever the
  //    item set changes (e.g. a topic chip refresh swaps the feed). ─────────────
  const itemsKey = useMemo(() => items.map((n) => n.url).join('\n'), [items]);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(items[0]?.url ?? null);
  useEffect(() => {
    setSelectedUrl(items[0]?.url ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);
  const selectedIndex = Math.max(0, items.findIndex((n) => n.url === selectedUrl));
  const selectedItem = items[selectedIndex];
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const moveSelection = (delta: number) => {
    if (!items.length) return;
    const next = Math.min(items.length - 1, Math.max(0, selectedIndex + delta));
    if (next === selectedIndex) return;
    setSelectedUrl(items[next].url);
    rowRefs.current[next]?.scrollIntoView?.({ block: 'nearest' });
  };
  // ↑/↓ move the selection while focus is anywhere inside the split (list rows or
  // the reader pane) — the handler catches the bubbled keydown from either side.
  const onSplitKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    }
  };

  if (!items.length) return null;

  const reader = reading && <ArticleReader item={reading} onClose={() => setReading(null)} />;

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
              <button type="button" onClick={() => setReading(n)} className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors duration-200 hover:bg-[var(--ds-well)]">
                <span className="mt-0.5 shrink-0">
                  <SourceIcon item={n} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium leading-snug text-[var(--ds-ink)]">{n.title}</span>
                  <MetaLine item={n} showSentiment={false} />
                </span>
              </button>
            </li>
          ))}
        </ul>
        {reader}
      </Surface>
    );
  }

  // ── Detailed: topic chips (live), then either the master-detail split (wide)
  //    or the classic lead-story list (narrow). ─────────────────────────────────
  const [lead, ...rest] = items;
  const visibleRest = showAll ? rest : rest.slice(0, PREVIEW - 1);
  const hiddenCount = rest.length - visibleRest.length;

  const topicChips = live.canRefresh && (
    <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
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
  );

  // Master-detail split: headline list (left, ~38%) ⇄ in-card reader (right).
  // `flex-[1_1_420px]` is the height contract: a pleasant 420px by default (chat
  // flow, auto-height), but grow/shrink to fill when an ancestor (dashboard tile,
  // dragged WidgetFrame, lightbox) hands the card a constrained height.
  const splitBody = (
    <div
      onKeyDown={onSplitKeyDown}
      className={`flex min-h-0 flex-[1_1_420px] border-t border-[var(--ds-hairline-soft)] transition-opacity duration-200 ${
        live.refreshing ? 'pointer-events-none animate-pulse opacity-50' : ''
      }`}
    >
      {/* Left — scrollable headline list. */}
      <ul
        role="listbox"
        aria-label="Stories"
        className="min-h-0 w-[38%] min-w-[200px] shrink-0 divide-y divide-[var(--ds-hairline-soft)] overflow-y-auto overscroll-auto border-r border-[var(--ds-hairline-soft)] [scrollbar-width:thin]"
      >
        {items.map((n, i) => {
          const selected = i === selectedIndex;
          const time = relativeTime(n.publishedAt);
          return (
            <li key={`${n.url}-${i}`} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={selected}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                onClick={() => setSelectedUrl(n.url)}
                onMouseEnter={() => prefetchArticle(n.url)}
                onFocus={() => prefetchArticle(n.url)}
                className={`relative flex w-full items-start gap-2 py-2 pl-3.5 pr-3 text-left transition-colors duration-150 ${
                  selected ? 'bg-[var(--ds-well)]' : 'hover:bg-[var(--ds-hover)]'
                }`}
              >
                {/* Accent rail on the selected story. */}
                {selected && <span aria-hidden className="absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded-r-full bg-[var(--ds-accent)]" />}
                <span className="mt-0.5 shrink-0">
                  <SourceIcon item={n} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[12px] leading-snug text-[var(--ds-ink)] line-clamp-2 ${selected ? 'font-semibold' : 'font-medium'}`}>
                    {n.title}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--ds-muted)]">
                    <span className="truncate font-medium">{n.source || hostOf(n.url)}</span>
                    {time && <span className="shrink-0">· {time}</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Right — the reader for the selected story. */}
      <NewsReaderPane item={selectedItem} />
    </div>
  );

  // Classic narrow list: lead story + divided rows; stories open the modal reader.
  const listBody = (
    <div className={`transition-opacity duration-200 ${live.refreshing ? 'pointer-events-none animate-pulse opacity-50' : ''}`}>
      {/* Lead story — opens the in-app reader. */}
      <button type="button" onClick={() => setReading(lead)} className="block w-full px-3 pb-2.5 pt-1 text-left transition-colors duration-200 hover:bg-[var(--ds-well)]">
        {lead.image && (
          <img src={lead.image} alt="" loading="lazy" className="mb-2 aspect-[2/1] w-full rounded-xl object-cover ring-1 ring-[var(--ds-hairline-soft)]" />
        )}
        <span className="block text-sm font-semibold leading-snug tracking-tight text-[var(--ds-ink)] line-clamp-2">{lead.title}</span>
        <span className="mt-1 flex items-center gap-1.5">
          <SourceIcon item={lead} size={14} />
          <MetaLine item={lead} />
        </span>
        {lead.snippet && <span className="mt-1 block text-[11px] leading-snug text-[var(--ds-muted)] line-clamp-2">{lead.snippet}</span>}
      </button>

      {/* Remaining stories as clean divided rows — each opens the in-app reader. */}
      {visibleRest.length > 0 && (
        <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {visibleRest.map((n, i) => (
            <li key={`${n.url}-${i}`}>
              <button type="button" onClick={() => setReading(n)} className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors duration-200 hover:bg-[var(--ds-well)]">
                <span className="mt-0.5 shrink-0">
                  <SourceIcon item={n} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-snug text-[var(--ds-ink)] line-clamp-2">{n.title}</span>
                  <span className="mt-0.5 block">
                    <MetaLine item={n} />
                  </span>
                </span>
              </button>
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
  );

  // The wrapper is the measured element AND the height conduit: as a flex column
  // with h-full, a height-constrained ancestor (dashboard tile, lightbox) flows its
  // height through Surface (flex-1, margins respected) into the split's panes,
  // which then scroll internally instead of overflowing the card.
  return (
    <div ref={shellRef} className="flex h-full max-h-full min-h-0 flex-col">
      <Surface
        className={wide ? 'flex min-h-0 flex-1 flex-col' : ''}
        header={
          <span className="flex min-w-0 items-center gap-1.5">
            <Newspaper className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
            <SurfaceTitle>{heading(data)}</SurfaceTitle>
          </span>
        }
        right={headerRight}
      >
        {/* Topic chips — live re-query of the producing get_news call, no model round-trip.
            Switching topics keeps the split; the first new story is auto-selected. */}
        {topicChips}
        {wide ? splitBody : listBody}
        {reader}
      </Surface>
    </div>
  );
};
