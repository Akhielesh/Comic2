// One clip of the book timeline (timeline.md §4.2): an aspect-true thumbnail in a fixed-height box,
// a status ring, the version count and the real money recorded against it. The clip is a listbox
// option (roving focus is handled by BookTimeline); every action it offers also exists in ClipMenu.

import React from 'react';
import { AlertTriangle, Info, LoaderCircle, MoreHorizontal, Plus } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { formatUsd } from '../../../shared/comic/models';
import { LayoutGlyph } from '../library/procedural/LayoutGlyph';
import type { StudioController } from '../types';
import { STATUS_TEXT, plural, type ClipVM } from './bookModel';
import { PlateView } from './PlateView';
import type { PlateKind } from './plates';
import { BlockedTile, cx, FOCUS_RING } from './ui';

/** Thumbnail box height (px) per mode; widths follow the art's aspect within bounds. */
export const CLIP_THUMB_H = { full: 64, compact: 52 } as const;
const CLIP_W = { full: [44, 116], compact: [34, 76] } as const;

export const clipThumbWidth = (ratio: number, compact: boolean): number => {
  const h = compact ? CLIP_THUMB_H.compact : CLIP_THUMB_H.full;
  const [lo, hi] = compact ? CLIP_W.compact : CLIP_W.full;
  return Math.round(Math.min(hi, Math.max(lo, h * (Number.isFinite(ratio) && ratio > 0 ? ratio : 2 / 3))));
};

const ringFor = (clip: ClipVM): string => {
  switch (clip.status) {
    case 'stale':
      return 'ring-2 ring-amber-500/70';
    case 'failed':
      return 'ring-2 ring-red-500/70';
    case 'queued':
    case 'rendering':
      return 'ring-2 ring-[#D97757]/60';
    case 'custom':
      return 'ring-1 ring-[#D97757]/50';
    case 'planned':
    case 'empty':
      return 'border border-dashed border-[var(--ds-hairline)]';
    default:
      return 'ring-1 ring-[var(--ds-hairline)]';
  }
};

/** "Page 3, out of date, 3 versions, $0.17 spent". */
export const clipAriaLabel = (clip: ClipVM): string => {
  const parts = [clip.label];
  if (clip.plate) parts.push('made by software, free');
  else parts.push(STATUS_TEXT[clip.status].toLowerCase());
  if (clip.versions > 1) parts.push(plural(clip.versions, 'version'));
  if (clip.spentUsd > 0) parts.push(`${formatUsd(clip.spentUsd)} spent`);
  if (clip.mismatch) parts.push(`shape ${clip.mismatch.got}, book is ${clip.mismatch.want}`);
  if (clip.continuity) parts.push('neighbouring page changed');
  return parts.join(', ');
};

export interface TimelineClipProps {
  clip: ClipVM;
  doc: ComicDoc;
  urlFor: StudioController['urlFor'];
  compact: boolean;
  selected: boolean;
  tabIndex: 0 | -1;
  /** "Redraw ≈ $0.06" hint on hover/focus (registry price); undefined hides it. */
  nextPrice?: string;
  /** Drag visuals: translateX of this clip, and whether it is the lifted one. */
  shift?: number;
  lifted?: boolean;
  animate: boolean;
  describedBy?: string;
  itemRef?: (el: HTMLDivElement | null) => void;
  onActivate(): void;
  onMenu(anchor: HTMLElement): void;
  onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void;
  onFocus(): void;
  onPointerDown?(e: React.PointerEvent<HTMLDivElement>): void;
  onContextMenu?(e: React.MouseEvent<HTMLDivElement>): void;
}

export const TimelineClip: React.FC<TimelineClipProps> = ({
  clip,
  doc,
  urlFor,
  compact,
  selected,
  tabIndex,
  nextPrice,
  shift = 0,
  lifted,
  animate,
  describedBy,
  itemRef,
  onActivate,
  onMenu,
  onKeyDown,
  onFocus,
  onPointerDown,
  onContextMenu
}) => {
  const h = compact ? CLIP_THUMB_H.compact : CLIP_THUMB_H.full;
  const w = clipThumbWidth(clip.ratio, compact);
  const url = clip.asset && !clip.blocked ? urlFor(clip.asset, { width: 240 }) : undefined;
  const busy = clip.status === 'queued' || clip.status === 'rendering';
  const short = clip.kind === 'page' ? `P${clip.page?.n ?? ''}` : clip.kind === 'cover' ? 'Cover' : clip.label;
  const title = [clip.label, clip.plate ? 'Free — made by software' : STATUS_TEXT[clip.status], clip.versions > 1 ? `v${clip.versions}` : '', clip.spentUsd > 0 ? `${formatUsd(clip.spentUsd)} spent` : '', nextPrice || '']
    .filter(Boolean)
    .join(' · ');

  let body: React.ReactNode;
  if (clip.plate) {
    body = <PlateView doc={doc} kind={clip.kind as PlateKind} urlFor={(p) => urlFor(p, { width: 240 })} decorative className="h-full w-full" />;
  } else if (clip.blocked) {
    body = <BlockedTile compact />;
  } else if (url) {
    body = <img src={url} alt="" draggable={false} loading="lazy" decoding="async" className="h-full w-full select-none object-contain" />;
  } else if (clip.asset) {
    body = <span className="studio-shimmer block h-full w-full" aria-hidden />;
  } else if (clip.kind === 'page' && clip.page?.panels.length) {
    body = (
      <span className="flex h-full w-full items-center justify-center text-[var(--ds-faint)]" aria-hidden>
        <LayoutGlyph page={clip.page} aspect={doc.format.pageAspect} size={Math.max(18, w - 14)} />
      </span>
    );
  } else {
    body = (
      <span className="flex h-full w-full items-center justify-center px-1 text-center text-[9.5px] leading-tight text-[var(--ds-faint)]" aria-hidden>
        {clip.kind === 'cover' ? 'No cover yet' : 'Empty'}
      </span>
    );
  }

  return (
    <div
      ref={itemRef}
      role="option"
      aria-selected={selected}
      aria-label={clipAriaLabel(clip)}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      tabIndex={tabIndex}
      title={title}
      data-clip-key={clip.key}
      onClick={onActivate}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      className={cx(
        'no-callout group relative flex shrink-0 cursor-pointer select-none flex-col items-center gap-0.5 rounded-xl p-1',
        FOCUS_RING,
        selected ? 'bg-[#D97757]/10' : 'hover:bg-[var(--ds-hover)]',
        lifted && 'z-10 bg-[var(--ds-surface-strong)] shadow-[0_8px_24px_rgba(0,0,0,0.22)]',
        animate && !lifted && 'transition-transform duration-150'
      )}
      style={{ transform: shift ? `translateX(${shift}px)${lifted ? ' scale(1.04)' : ''}` : lifted ? 'scale(1.04)' : undefined, minWidth: 44 }}
    >
      <div className={cx('relative overflow-hidden rounded-lg bg-[var(--ds-well)]', ringFor(clip))} style={{ width: w, height: h }}>
        {body}
        {busy && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/25" aria-hidden>
            <LoaderCircle className="h-4 w-4 animate-spin text-white motion-reduce:animate-none" />
          </span>
        )}
        {clip.mismatch && !compact && (
          <span className="absolute left-0.5 top-0.5 inline-flex items-center gap-0.5 rounded bg-amber-500/90 px-1 text-[9px] font-semibold leading-[14px] text-white" aria-hidden>
            <AlertTriangle className="h-2.5 w-2.5" />
            {clip.mismatch.got}
          </span>
        )}
        {clip.status === 'stale' && (
          <span className="absolute inset-x-0 bottom-0 bg-amber-500/90 text-center text-[8.5px] font-semibold leading-[13px] text-white" aria-hidden>
            Out of date
          </span>
        )}
        {clip.status === 'failed' && (
          <span className="absolute inset-x-0 bottom-0 bg-red-600/90 text-center text-[8.5px] font-semibold leading-[13px] text-white" aria-hidden>
            Failed
          </span>
        )}
        {clip.continuity && !compact && (
          <span className="absolute bottom-0.5 right-0.5 rounded-full bg-[var(--ds-surface-strong)] p-px text-[var(--ds-muted)]" aria-hidden>
            <Info className="h-2.5 w-2.5" />
          </span>
        )}
        {!compact && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onMenu(e.currentTarget);
            }}
            className="tap-target absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-md bg-transparent text-[var(--ds-ink)] opacity-0 transition-opacity hover:bg-[var(--ds-surface-strong)] group-hover:opacity-100 group-focus-within:opacity-100 coarse:opacity-80"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {!compact && (
        <div className="w-full min-w-0 text-center leading-tight" style={{ maxWidth: w + 8 }}>
          <p className="truncate text-[10.5px] font-semibold text-[var(--ds-ink)]">{short}</p>
          <p className="truncate text-[10px] tabular-nums text-[var(--ds-muted)]">
            {clip.plate ? 'Free' : [clip.versions > 1 ? `v${clip.versions}` : '', clip.spentUsd > 0 ? formatUsd(clip.spentUsd) : ''].filter(Boolean).join(' · ') || ' '}
          </p>
        </div>
      )}
    </div>
  );
};

/** "+ Add page" and "+ Title page" options (free). */
export const AddClip: React.FC<{
  label: string;
  hint: string;
  compact: boolean;
  tabIndex: 0 | -1;
  ghost?: boolean;
  disabled?: boolean;
  itemRef?: (el: HTMLDivElement | null) => void;
  onActivate(): void;
  onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void;
  onFocus(): void;
}> = ({ label, hint, compact, tabIndex, ghost, disabled, itemRef, onActivate, onKeyDown, onFocus }) => {
  const h = compact ? CLIP_THUMB_H.compact : CLIP_THUMB_H.full;
  return (
    <div
      ref={itemRef}
      role="option"
      aria-selected={false}
      aria-disabled={disabled || undefined}
      aria-label={`${label} — ${hint}`}
      title={`${label} — ${hint}`}
      tabIndex={tabIndex}
      onClick={() => !disabled && onActivate()}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className={cx('flex shrink-0 cursor-pointer flex-col items-center gap-0.5 rounded-xl p-1 hover:bg-[var(--ds-hover)]', FOCUS_RING, disabled && 'cursor-not-allowed opacity-45')}
      style={{ minWidth: 44 }}
    >
      <div
        className={cx(
          'flex items-center justify-center rounded-lg border border-dashed text-[var(--ds-muted)]',
          ghost ? 'border-[var(--ds-hairline)] bg-transparent' : 'border-[#D97757]/45 bg-[#D97757]/5 text-[var(--ds-accent)]'
        )}
        style={{ width: compact ? 36 : ghost ? 56 : 44, height: h }}
      >
        <Plus className="h-4 w-4" aria-hidden />
      </div>
      {!compact && (
        <div className="w-full min-w-0 text-center leading-tight" style={{ maxWidth: ghost ? 64 : 52 }}>
          <p className="truncate text-[10.5px] font-semibold text-[var(--ds-ink)]">{label}</p>
          <p className="truncate text-[10px] text-[var(--ds-muted)]">Free</p>
        </div>
      )}
    </div>
  );
};

export default TimelineClip;
