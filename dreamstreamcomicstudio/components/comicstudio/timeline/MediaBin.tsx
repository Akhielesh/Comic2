// The media bin (timeline.md §4.3; critic: one "Media" tab): every image in this comic — every page
// and cover version, sheets, places, style options and board, reference photos, chat uploads,
// deleted pages and the archive — grouped by what it belongs to, in book order. Filters, search and
// sort are local; tiles sign their URLs only when they scroll into view (cheap on a 300-image
// archive). "Examples from the library" shows the platform library for inspiration when it is
// available. The archive counter ("Archive 12/300") makes the cap visible, never silent.

import React, { useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Star } from 'lucide-react';
import type { LibraryAssetPublic } from '../../../shared/comic/library';
import type { StudioController } from '../types';
import { EmptyArt } from '../library/procedural/EmptyArt';
import { LibraryImage } from '../library/LibraryImage';
import { useComicLibrary } from '../library/useComicLibrary';
import {
  MEDIA_FILTERS,
  archiveUsage,
  collectMedia,
  filterMedia,
  groupMedia,
  mediaCounts,
  type MediaFilter,
  type MediaItem,
  type MediaSort
} from './bookModel';
import { MediaPreview } from './MediaPreview';
import { UndoToast, useTimelineEdit } from './UndoToast';
import { Badge, BlockedTile, cx, FOCUS_RING, TimelineDialog, useInView } from './ui';
import { useCostFormat } from '../conversation/cost';
import { amountInSentence } from '../../../services/costDisplay';

export interface MediaBinProps {
  studio: StudioController;
  initialFilter?: MediaFilter;
}

const MediaTile: React.FC<{ item: MediaItem; studio: StudioController; onOpen(): void }> = ({ item, studio, onOpen }) => {
  const [ref, seen] = useInView<HTMLButtonElement>('300px');
  const url = seen && !item.blocked ? studio.urlFor(item.asset, { width: 240 }) : undefined;
  const label = `${item.owner.label}${item.versionLabel ? `, ${item.versionLabel}` : ''}${item.archived ? ', archived' : ''}${item.role === 'deleted_page' ? ', deleted' : ''}`;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className={cx('group relative block aspect-square w-full min-w-0 overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] hover:border-[#D97757]/50', FOCUS_RING)}
    >
      {item.blocked ? (
        <BlockedTile compact />
      ) : url ? (
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 h-full w-full object-contain" />
      ) : (
        <span className={cx('absolute inset-0', seen && 'studio-shimmer')} aria-hidden />
      )}
      <span className="absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1 bg-gradient-to-t from-black/65 to-transparent px-1.5 pb-1 pt-3 text-left">
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-white">{item.versionLabel ?? item.owner.label}</span>
        {item.starred && <Star className="h-3 w-3 shrink-0 fill-current text-amber-300" aria-hidden />}
      </span>
      {(item.archived || item.role === 'deleted_page' || item.stale) && (
        <span className="absolute left-1 top-1 flex gap-0.5">
          {item.role === 'deleted_page' && <Badge tone="danger">Deleted</Badge>}
          {item.archived && <Badge>Archived</Badge>}
          {item.stale && item.current && <Badge tone="warn">Out of date</Badge>}
        </span>
      )}
    </button>
  );
};

const ExampleTile: React.FC<{ asset: LibraryAssetPublic }> = ({ asset }) => (
  <figure className="min-w-0">
    <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]">
      <LibraryImage
        id={asset.id}
        alt={asset.alt}
        sizes="120px"
        className="absolute inset-0 h-full w-full object-cover"
        fallback={
          <span className="flex h-full w-full items-center justify-center text-[var(--ds-muted)]">
            <EmptyArt variant="media" />
          </span>
        }
      />
    </div>
    {asset.caption && <figcaption className="mt-1 truncate text-[10.5px] text-[var(--ds-muted)]">{asset.caption}</figcaption>}
  </figure>
);

export const MediaBin: React.FC<MediaBinProps> = ({ studio, initialFilter = 'all' }) => {
  const doc = studio.doc;
  const [filter, setFilter] = useState<MediaFilter>(initialFilter);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<MediaSort>('book');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  /** The previewed image, by PATH: an action in the preview (use for a page, restore, star) regroups the
   *  list, and an index would then silently point at a different image. */
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const lastPreviewIdx = useRef(0);
  const edit = useTimelineEdit(studio);
  const library = useComicLibrary();
  const searchId = useId();
  const sortId = useId();

  const all = useMemo(() => (doc ? collectMedia(doc) : []), [doc]);
  const counts = useMemo(() => mediaCounts(all), [all]);
  const shown = useMemo(() => filterMedia(all, filter, query), [all, filter, query]);
  const groups = useMemo(() => groupMedia(shown, sort), [shown, sort]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // The open image's place in the current list; when it left the filtered set (a restored page leaves
  // "Deleted"), its neighbour is shown instead of closing under the user's finger.
  let preview: number | null = null;
  if (previewPath !== null && flat.length) {
    const at = flat.findIndex((it) => it.path === previewPath);
    preview = at >= 0 ? at : Math.min(lastPreviewIdx.current, flat.length - 1);
    lastPreviewIdx.current = preview;
  }
  const setPreview = (i: number | null) => setPreviewPath(i === null ? null : flat[i]?.path ?? null);
  // Recorded costs in the viewer's terms (governed users never see dollars).
  const cost = useCostFormat(studio);

  if (!doc) return null;
  const examples = library.status === 'ready' ? [...library.byKind('cover_example'), ...library.byKind('genre_example')].slice(0, 12) : [];
  const archive = archiveUsage(doc);
  const spentOnImages = all.reduce((n, it) => n + (typeof it.costUsd === 'number' ? it.costUsd : 0), 0);

  const toggle = (key: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="min-w-0 space-y-3">
      <div className="space-y-2">
        <div
          role="radiogroup"
          aria-label="Show"
          className="-mx-1 -my-1.5 flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain px-1 py-1.5 [scrollbar-width:none]"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const visible = MEDIA_FILTERS.filter((f) => f.id === filter || f.id === 'all' || counts[f.id] > 0);
            const i = visible.findIndex((f) => f.id === filter);
            const next = visible[(i + (e.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
            setFilter(next.id);
            (e.currentTarget.querySelector(`[data-filter="${next.id}"]`) as HTMLElement | null)?.focus();
          }}
        >
          {MEDIA_FILTERS.map((f) => {
            const on = f.id === filter;
            const n = counts[f.id];
            if (!on && !n && f.id !== 'all') return null;
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                data-filter={f.id}
                onClick={() => setFilter(f.id)}
                className={cx(
                  'tap-target inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-[12px] font-medium',
                  FOCUS_RING,
                  on ? 'border-[#D97757]/40 bg-[#D97757]/10 text-[var(--ds-ink)]' : 'border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                )}
              >
                {f.label}
                <span className="tabular-nums text-[11px] opacity-80">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-40">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-muted)]" aria-hidden />
            <label htmlFor={searchId} className="sr-only">
              Search by page, character or place
            </label>
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Page 3, MAYA, cover…"
              className="h-9 w-full rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] pl-8 pr-3 text-[16px] text-[var(--ds-ink)] placeholder:text-[var(--ds-faint)] focus:border-[#D97757]/50 focus:outline-none sm:text-[12.5px]"
            />
          </div>
          <label htmlFor={sortId} className="sr-only">
            Sort
          </label>
          <select
            id={sortId}
            value={sort}
            onChange={(e) => setSort(e.target.value as MediaSort)}
            className="h-9 shrink-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 text-[16px] text-[var(--ds-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 sm:text-[12.5px]"
          >
            <option value="book">Book order</option>
            <option value="newest">Newest first</option>
          </select>
        </div>
      </div>

      {!flat.length ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-[var(--ds-hairline)] px-6 py-10 text-center">
          <EmptyArt variant="media" />
          <p className="text-[14px] font-semibold text-[var(--ds-ink)]">{all.length ? 'Nothing matches' : 'No images yet'}</p>
          <p className="max-w-sm text-[13px] text-[var(--ds-muted)]">
            {all.length ? 'Try another filter or search.' : 'Every page, cover, sheet and upload appears here as you make the comic — with all its versions.'}
          </p>
        </div>
      ) : (
        groups.map((g) => {
          const isClosed = closed.has(g.key);
          return (
            <section key={g.key} className="min-w-0" aria-label={g.label}>
              <h3>
                <button
                  type="button"
                  aria-expanded={!isClosed}
                  onClick={() => toggle(g.key)}
                  className={cx('tap-target flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] hover:text-[var(--ds-ink)]', FOCUS_RING)}
                >
                  <ChevronDown className={cx('h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none', isClosed && '-rotate-90')} aria-hidden />
                  <span className="min-w-0 truncate">{g.label}</span>
                  <span className="shrink-0 tabular-nums">{g.items.length}</span>
                </button>
              </h3>
              {!isClosed && (
                <div className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
                  {g.items.map((it) => (
                    <MediaTile key={it.path} item={it} studio={studio} onOpen={() => setPreviewPath(it.path)} />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}

      {filter === 'all' && !query && examples.length > 0 && (
        <section className="min-w-0" aria-label="Examples from the library">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Examples from the library</h3>
          <p className="mb-1.5 text-[12px] text-[var(--ds-muted)]">For inspiration — shared DreamStream examples, not part of your comic.</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
            {examples.map((a) => (
              <ExampleTile key={a.id} asset={a} />
            ))}
          </div>
        </section>
      )}

      <footer className="border-t border-[var(--ds-hairline-soft)] pt-2 text-[11.5px] leading-relaxed text-[var(--ds-muted)]">
        <p>
          <span className="font-semibold tabular-nums text-[var(--ds-ink)]">
            Archive {archive.used}/{archive.cap}
          </span>{' '}
          · Starred images are never removed. Once the archive is full, the oldest unstarred versions that nothing uses are removed — the studio tells you when.
        </p>
        {spentOnImages > 0 && <p className="tabular-nums">Recorded image cost of everything here: {amountInSentence(cost.exact(spentOnImages), 'some of your usage')}.</p>}
      </footer>

      <TimelineDialog open={preview !== null && !!flat[preview]} onClose={() => setPreview(null)} title={preview !== null && flat[preview] ? flat[preview].owner.label : 'Image'} wide>
        {preview !== null && flat[preview] && <MediaPreview studio={studio} doc={doc} items={flat} index={preview} onIndex={setPreview} edit={edit} />}
      </TimelineDialog>
      <UndoToast entry={edit.toast} onUndo={edit.undo} onDismiss={edit.dismiss} />
    </div>
  );
};

export default MediaBin;
