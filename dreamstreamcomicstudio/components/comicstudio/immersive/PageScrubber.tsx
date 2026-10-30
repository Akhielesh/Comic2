// Page scrubber (reader.md §6.6): a native range input (keyboard and screen-reader friendly) drawn as a
// track with a tick per view and taller chapter marks. Dragging shows a thumbnail of the page — only
// from images the reader already decoded (never a download just for a thumbnail) — plus the page and
// chapter. Release jumps there with a riffle. RTL comics scrub right-to-left.

import React, { useMemo, useState } from 'react';
import type { ReaderItem } from '../reader/readerModel';
import { chapterOf } from '../reader/readerModel';
import { pageImageCache, useCacheVersion } from './pageImageCache';
import type { BookView } from './readerLayout';
import { glass } from './ReaderHud';

export interface PageScrubberProps {
  views: BookView[];
  items: ReaderItem[];
  view: number;
  rtl: boolean;
  labelOf(view: number): string;
  onGoto(view: number): void;
  onActivity(): void;
}

const thumbFor = (item: ReaderItem | undefined): string | undefined => {
  if (!item) return undefined;
  const paths = [item.asset.path, ...(item.asset.variants || []).map((v) => v.path)];
  for (const p of paths) {
    const e = pageImageCache.get(p);
    if (e?.state === 'ready' && e.objectUrl) return e.objectUrl;
  }
  return undefined;
};

export const PageScrubber: React.FC<PageScrubberProps> = ({ views, items, view, rtl, labelOf, onGoto, onActivity }) => {
  useCacheVersion();
  const [preview, setPreview] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const max = Math.max(0, views.length - 1);
  const shown = preview ?? view;
  const chapters = useMemo(
    () =>
      views
        .map((v, i) => {
          // A chapter may start on either page of a spread.
          const title = v.items.map((it) => items[it]?.page?.chapterTitle?.trim()).find(Boolean);
          return title ? { view: i, title } : null;
        })
        .filter((c): c is { view: number; title: string } => !!c),
    [views, items]
  );
  const firstItem = views[shown]?.items[0];
  const chapter = firstItem !== undefined ? chapterOf(items, firstItem)?.title : undefined;
  const thumb = thumbFor(firstItem !== undefined ? items[firstItem] : undefined);
  const pct = (v: number) => (max ? (v / max) * 100 : 0);
  const pos = (v: number) => (rtl ? 100 - pct(v) : pct(v));
  if (views.length < 2) return null;
  return (
    <div className={`pointer-events-auto relative w-[min(640px,100%)] rounded-full px-4 py-0 shadow-[0_8px_30px_rgba(0,0,0,0.35)] ${glass}`} data-no-turn data-testid="page-scrubber">
      {preview !== null && (
        <div
          className="pointer-events-none absolute bottom-[calc(100%+10px)] w-[112px] -translate-x-1/2 rounded-xl bg-black/70 p-1.5 text-center text-[11px] text-white shadow-lg backdrop-blur-md"
          style={{ left: `clamp(60px, ${pos(preview)}%, calc(100% - 60px))` }}
          aria-hidden
        >
          <div className="mx-auto mb-1 grid h-[120px] w-[100px] place-items-center overflow-hidden rounded-md bg-[var(--ds-reader-paper-back)]">
            {thumb ? <img src={thumb} alt="" className="h-full w-full object-contain" draggable={false} /> : <span className="text-[22px] font-semibold text-[var(--ds-reader-ink-soft)]">{labelOf(preview).replace(/^Pages? /, '')}</span>}
          </div>
          <p className="truncate font-medium">{labelOf(preview)}</p>
          {chapter && <p className="truncate text-white/75">{chapter}</p>}
        </div>
      )}
      <div className="relative h-11">
        {/* Ticks: one per view; chapter starts are taller and labelled on hover. */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/20" aria-hidden>
          <div className="absolute inset-y-0 rounded-full bg-[var(--ds-accent)]" style={rtl ? { right: 0, width: `${pct(shown)}%` } : { left: 0, width: `${pct(shown)}%` }} />
        </div>
        {views.length <= 80 &&
          views.map((_, i) => (
            <span key={i} aria-hidden className="pointer-events-none absolute top-1/2 h-1.5 w-px -translate-y-1/2 bg-white/35" style={{ left: `${pos(i)}%` }} />
          ))}
        {chapters.map((c) => (
          <span key={`ch-${c.view}`} aria-hidden title={c.title} className="pointer-events-none absolute top-1/2 h-4 w-[2px] -translate-y-1/2 rounded bg-white/80" style={{ left: `${pos(c.view)}%` }} />
        ))}
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={shown}
          dir={rtl ? 'rtl' : 'ltr'}
          aria-label="Page"
          aria-valuetext={`${labelOf(shown)} (${shown + 1} of ${views.length})`}
          className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
          onPointerDown={() => {
            setDragging(true);
            onActivity();
          }}
          onPointerUp={() => {
            setDragging(false);
            if (preview !== null && preview !== view) onGoto(preview);
            setPreview(null);
          }}
          onPointerCancel={() => {
            // The browser took the gesture (scroll, system swipe): drop the preview, don't jump.
            setDragging(false);
            setPreview(null);
          }}
          onBlur={() => {
            setDragging(false);
            setPreview(null);
          }}
          onChange={(e) => {
            const v = Number(e.currentTarget.value);
            onActivity();
            if (dragging) setPreview(v);
            else onGoto(v);
          }}
        />
        {/* The visible thumb. */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.45)] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ds-accent)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-black"
          style={{ left: `${pos(shown)}%` }}
        />
      </div>
    </div>
  );
};

export default PageScrubber;
