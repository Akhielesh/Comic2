// MediaGrid (redesign plan §4; master §11.3 M7): every image of a comic as one grid — `collectMedia` → a CardGrid
// of MediaTiles. It is the grid Pages › Assets shows (DS-R13 moves MediaBin onto it in S5) and the one Program 2's
// Pro asset bin mounts for its Images and Takes (PE-ASSETS, S3), so the bin and Assets are one grid.
//
// What it keeps from MediaBin's tile (timeline/MediaBin.tsx): sign-when-visible (a tile asks studio.urlFor for its
// 240 px URL only once it is near the viewport, cheap on a 300-image archive), the blocked tile (never an <img>, no
// URL signed), the on-art Deleted / Archived / Out of date badges, the version caption and the kept star. What it
// adds: the art waits for its decode and then fades in (useImageReveal via MediaTile; nothing animates under reduced
// motion), each tile is keyed by its stored path (a new picture in a mounted box is revealed again, MO-1 note),
// explicit columns from layout.ts, and selection mode with the arrow keys (CardGrid) and aria-pressed tiles.
//
// It filters, sorts and groups with bookModel's own functions; it never prints a price (the bin's spend line stays
// MediaBin's, in the viewer's terms).

import React, { useMemo } from 'react';
import { Star } from 'lucide-react';
import type { StudioController } from '../types';
import { CardGrid } from '../../ds/CardGrid';
import { MediaTile } from '../../ds/MediaTile';
import { countWords } from '../../ds/announce';
import type { Selection } from '../../ds/useSelection';
import { OVERLINE } from '../../chat/studioDesign';
import { cn } from '../../../lib/utils';
import { collectMedia, filterMedia, groupMedia, type MediaFilter, type MediaItem, type MediaSort } from './bookModel';
import { Badge, BlockedTile } from './ui';

export interface MediaGridProps {
  studio: Pick<StudioController, 'doc' | 'urlFor'>;
  /** Explicit columns (layout.ts: the Pages count for the place, or the bin's own). */
  columns: number;
  filter?: MediaFilter;
  query?: string;
  sort?: MediaSort;
  /** Group under each owner's heading (book order), as the Assets view does; one flat grid otherwise. */
  grouped?: boolean;
  /** A tile was tapped outside selection mode (open the Lightbox at it). */
  onOpen?: (item: MediaItem, index: number, items: MediaItem[]) => void;
  /** Selection mode: a tap toggles the tile (useSelection over the item paths). */
  selection?: Pick<Selection<string>, 'selecting' | 'isSelected' | 'toggle' | 'clear'>;
  /** The ⋯ for a tile (the screen's Menu). */
  menuFor?: (item: MediaItem) => React.ReactNode;
  /** The grid's accessible name. */
  label?: string;
  /** Said when nothing matches. */
  emptyText?: string;
  className?: string;
}

/** A tile's accessible name: owner, version, and what is special about it (MediaBin's words). */
export function mediaTileLabel(item: MediaItem): string {
  return [
    item.owner.label,
    item.versionLabel,
    item.archived ? 'archived' : null,
    item.role === 'deleted_page' ? 'deleted' : null,
    item.stale && item.current ? 'out of date' : null,
    item.starred ? 'kept forever' : null,
    item.blocked ? 'hidden by the content check' : null
  ]
    .filter(Boolean)
    .join(', ');
}

/** The tile width the grid asks urlFor for (MediaBin's thumbnails). */
export const MEDIA_GRID_THUMB_PX = 240;

function MediaGridTile({
  item,
  index,
  items,
  studio,
  onOpen,
  selection,
  menuFor
}: {
  item: MediaItem;
  index: number;
  items: MediaItem[];
  studio: MediaGridProps['studio'];
  onOpen?: MediaGridProps['onOpen'];
  selection?: MediaGridProps['selection'];
  menuFor?: MediaGridProps['menuFor'];
}) {
  const selecting = !!selection?.selecting;
  const selected = !!selection?.isSelected(item.path);
  const chips =
    item.role === 'deleted_page' || item.archived || (item.stale && item.current) ? (
      <>
        {item.role === 'deleted_page' && (
          <Badge tone="danger" onArt>
            Deleted
          </Badge>
        )}
        {item.archived && <Badge onArt>Archived</Badge>}
        {item.stale && item.current && (
          <Badge tone="warn" onArt>
            Out of date
          </Badge>
        )}
      </>
    ) : null;
  return (
    <MediaTile
      key={item.path}
      artKey={item.path}
      aspect="1 / 1"
      fit="contain"
      label={mediaTileLabel(item)}
      // A blocked image is never signed and never becomes an <img>.
      resolve={item.blocked ? undefined : () => studio.urlFor(item.asset, { width: MEDIA_GRID_THUMB_PX })}
      fallback={item.blocked ? <BlockedTile compact /> : null}
      chip={chips}
      caption={item.versionLabel ?? item.owner.label}
      badge={
        item.starred ? (
          <Badge onArt title="Kept forever">
            <Star aria-hidden="true" className="size-3 fill-current" />
          </Badge>
        ) : null
      }
      menu={menuFor && !selecting ? menuFor(item) : null}
      selected={selected}
      selecting={selecting}
      onOpen={selecting ? () => selection?.toggle(item.path) : onOpen ? () => onOpen(item, index, items) : undefined}
    />
  );
}

export const MediaGrid: React.FC<MediaGridProps> = ({
  studio,
  columns,
  filter = 'all',
  query = '',
  sort = 'book',
  grouped = false,
  onOpen,
  selection,
  menuFor,
  label = 'Assets',
  emptyText = 'Images you draw or upload appear here',
  className
}) => {
  const doc = studio.doc;
  const all = useMemo(() => (doc ? collectMedia(doc) : []), [doc]);
  const groups = useMemo(() => groupMedia(filterMedia(all, filter, query), sort), [all, filter, query, sort]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  if (!doc) return null;
  if (!flat.length) {
    return (
      <p data-slot="media-grid-empty" className={cn('m-0 py-8 text-center text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]', className)}>
        {query || filter !== 'all' ? 'No images match these filters' : emptyText}
      </p>
    );
  }

  const tile = (item: MediaItem) => (
    <MediaGridTile key={item.path} item={item} index={flat.indexOf(item)} items={flat} studio={studio} onOpen={onOpen} selection={selection} menuFor={menuFor} />
  );
  const grid = (items: readonly MediaItem[], name: string) => (
    <CardGrid
      items={items}
      getKey={(it) => it.path}
      renderItem={tile}
      columns={columns}
      label={name}
      selecting={!!selection?.selecting}
      onExitSelection={selection?.clear}
    />
  );

  if (!grouped) {
    return (
      <div data-slot="media-grid" data-count={flat.length} className={className}>
        {grid(flat, `${label}, ${countWords(flat.length, 'image')}`)}
      </div>
    );
  }
  return (
    <div data-slot="media-grid" data-count={flat.length} className={cn('flex min-w-0 flex-col gap-5', className)}>
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label} className="flex min-w-0 flex-col gap-2">
          <h3 className={`m-0 ${OVERLINE}`}>
            {g.label} <span className="tabular-nums">{g.items.length}</span>
          </h3>
          {grid(g.items, `${g.label}, ${countWords(g.items.length, 'image')}`)}
        </section>
      ))}
    </div>
  );
};

export default MediaGrid;
