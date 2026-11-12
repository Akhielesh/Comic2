/**
 * MediaTile — the art box every grid shares (redesign plan §4): a page on the Pages board, an asset in Assets, a
 * cover inside ComicCard, a preset tile. It replaces timeline/MediaBin's hand-built tile and the page cards' art.
 *
 *   box       the reserved aspect (1:1 by default), the comic's tint (`artColor` → --ds-art through ART_PLACEHOLDER)
 *             until the art arrives, the panel radius, a hairline;
 *   art       either children (a CoverImage, a procedural thumb) or `src` — or `resolve` for sign-when-visible,
 *             asked once the tile is near the viewport, once per picture (`artKey`, its stored path). The picture
 *             is revealed through useImageReveal (CoverImage's RevealImage: load, decode, then the art entrance;
 *             nothing animates under reduced motion) and shows `fallback` if it fails;
 *   veil      a SafetyVeil slot: `veil(art)` wraps the art (blur, the blocked tile), the chrome stays on top;
 *   chips     `chip` top-left and `badge` bottom-right (version, "Out of date") are opaque on-art pills the caller
 *             builds (Badge onArt, StatusChip on art, RatingBadge onArt); `caption` is a short opaque label bottom-left;
 *   ⋯         `menu`, top-right: the screen passes its Menu trigger (DS-1c), the tile only places it;
 *   selected  a spark outline set off the art (SPARK_RING_ON_ART: selection on art is the one place the spark
 *             marks a choice), and `aria-pressed` on the tile's control in selection mode. `ring="inside"` draws
 *             it inside the art instead (MEDIA_TILE_RING_INSIDE, an overlay painted over the picture) for a tile
 *             whose container clips its edges: ComicCard's cover sits flush in a card that clips to its radius,
 *             where a ring set outside the art is cut off on three sides.
 *
 * With `onOpen` the whole tile is one button (named by `label`) under the chips and the menu, which stay
 * separately tappable. The tile never prints a price.
 *
 * `as="span"` builds the tile from spans (each `block` or positioned, so it looks the same): for a tile inside a
 * button (PresetTile), whose content may only be phrasing content. The art passed in must then be phrasing too.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { artBoxStyle, revealKeyOf, RevealImage, useNearViewport } from './CoverImage';
import { ART_PLACEHOLDER, FOCUS_RING, LIFT, RADIUS_CONTROL, SPARK_RING_ON_ART } from './recipes';

export interface MediaTileProps {
  /** CSS aspect-ratio of the box ("1 / 1", "2 / 3", "9 / 16"). */
  aspect?: string;
  /** The art, when the caller draws it (a CoverImage, a procedural thumb). */
  children?: React.ReactNode;
  /** A ready URL for the art. */
  src?: string | null;
  srcSet?: string;
  sizes?: string;
  /** Sign-when-visible: the art's URL, asked once the tile is near the viewport (once per `artKey`). */
  resolve?: () => string | null | undefined;
  /** The art's identity (its stored path): a new key reveals the new picture from the start. */
  artKey?: string | null;
  alt?: string;
  fit?: 'cover' | 'contain';
  /** Shown when there is no art yet, or it failed to load. */
  fallback?: React.ReactNode;
  /** Wraps the art (SafetyVeil). The chips, the menu and the selection ring stay outside it. */
  veil?: (art: React.ReactNode) => React.ReactNode;
  chip?: React.ReactNode;
  badge?: React.ReactNode;
  caption?: React.ReactNode;
  menu?: React.ReactNode;
  selected?: boolean;
  /** In selection mode the tile's control toggles (aria-pressed) instead of opening. */
  selecting?: boolean;
  onOpen?: () => void;
  /** The tile's accessible name: the control's with onOpen, else the picture's (role img). */
  label?: string;
  artColor?: string | null;
  /** First row: load now. */
  priority?: boolean;
  /** Hover lift (cards on a grid; off inside a card that lifts itself). */
  lift?: boolean;
  /** Where the selection ring is drawn: set off the art (default) or inside it (a container that clips the tile). */
  ring?: 'outside' | 'inside';
  /** The element the tile is built from: `span` inside a button (phrasing content only). */
  as?: 'div' | 'span';
  className?: string;
}

/** The box: reserved aspect, the comic's tint, the control radius, a hairline. */
export const MEDIA_TILE = `group/tile relative isolate block w-full min-w-0 overflow-hidden ${RADIUS_CONTROL} border border-[var(--ds-hairline)] ${ART_PLACEHOLDER}`;
/**
 * The selection ring drawn inside the art: an overlay over the picture (the art is positioned, so an outline on the
 * tile itself would be painted under it), the spark outline 2–4 px inside the edge, following the tile's radius.
 */
export const MEDIA_TILE_RING_INSIDE = 'pointer-events-none absolute inset-0 block rounded-[inherit] outline-offset-[-4px]';
/** An opaque label on the art (the raised surface and the muted ink: readable on any picture). */
export const ON_ART_LABEL = 'pointer-events-none inline-flex max-w-full items-center truncate rounded-[var(--ds-radius-chip)] border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-1.5 py-0.5 text-[10.5px] font-medium leading-4 text-[var(--ds-ink)]';

export function MediaTile({
  aspect = '1 / 1',
  children,
  src,
  srcSet,
  sizes,
  resolve,
  artKey,
  alt = '',
  fit = 'cover',
  fallback = null,
  veil,
  chip,
  badge,
  caption,
  menu,
  selected = false,
  selecting = false,
  onOpen,
  label,
  artColor,
  priority = false,
  lift = true,
  ring = 'outside',
  as: Box = 'div',
  className
}: MediaTileProps) {
  const [boxRef, near] = useNearViewport<HTMLElement>('300px', !priority && !!resolve && !src);
  const resolveRef = React.useRef(resolve);
  resolveRef.current = resolve;
  const resolvedUrl = React.useMemo(() => (resolve && !src && near ? resolveRef.current?.() ?? null : null), [near, artKey, !!resolve, src]); // once per artKey
  const url = src || resolvedUrl || null;

  const art =
    children ??
    (url ? (
      <RevealImage src={url} srcSet={srcSet} sizes={sizes} alt={alt} revealKey={revealKeyOf(artKey, url)} priority={priority} fit={fit} fallback={fallback} />
    ) : (
      fallback
    ));

  return (
    <Box
      ref={boxRef}
      // A tile that is not a control is still named: a picture with its label (the chips' words are in it).
      role={!onOpen && !menu && label ? 'img' : undefined}
      aria-label={!onOpen && !menu && label ? label : undefined}
      data-slot="media-tile"
      data-selected={selected || undefined}
      className={cn(MEDIA_TILE, lift && onOpen && LIFT, selected && ring === 'outside' && SPARK_RING_ON_ART, className)}
      style={artBoxStyle(aspect, artColor)}
    >
      <Box className="absolute inset-0 block" data-slot="media-tile-art">
        {veil ? veil(art) : art}
      </Box>
      {/* After the art (painted over it), before the control, the chips and the menu (which stay on top). */}
      {selected && ring === 'inside' ? <Box aria-hidden="true" data-slot="media-tile-ring" className={cn(SPARK_RING_ON_ART, MEDIA_TILE_RING_INSIDE)} /> : null}
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={label}
          aria-pressed={selecting ? selected : undefined}
          data-slot="media-tile-open"
          className={`absolute inset-0 block h-full w-full cursor-pointer bg-transparent ${RADIUS_CONTROL} ${FOCUS_RING}`}
        />
      ) : null}
      {chip ? <Box className="pointer-events-none absolute left-1.5 top-1.5 flex max-w-[calc(100%-3.5rem)] flex-wrap gap-1 [&>*]:pointer-events-auto">{chip}</Box> : null}
      {menu ? <Box className="absolute right-1 top-1 block">{menu}</Box> : null}
      {caption || badge ? (
        <Box className="pointer-events-none absolute inset-x-1.5 bottom-1.5 flex min-w-0 items-end justify-between gap-1">
          {caption ? <span className={ON_ART_LABEL}>{caption}</span> : <span />}
          {badge ? <span className="flex shrink-0 gap-1">{badge}</span> : null}
        </Box>
      ) : null}
    </Box>
  );
}
