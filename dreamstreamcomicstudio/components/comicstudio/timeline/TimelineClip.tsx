// One clip of the book timeline (timeline.md §4.2): an aspect-true thumbnail in a fixed-height box,
// a status ring, the version count and the real money recorded against it. The clip is a listbox
// option (roving focus is handled by BookTimeline); every action it offers also exists in ClipMenu.
// A11y (P1-QA timeline-clip-option-a11y): the option holds no focusable control (the ⋯ is a pointer
// affordance; keyboard users press M / the context-menu key) and its name is its own content — the
// full description for screen readers, the short visible label hidden from them — so no aria-label
// can drift from the visible text. Money is printed for the viewer (governed users: no dollars).

import React from 'react';
import { AlertTriangle, Info, LoaderCircle, MoreHorizontal, Plus } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { CostFormat } from '../conversation/cost';
import { LayoutGlyph } from '../library/procedural/LayoutGlyph';
import type { StudioController } from '../types';
import { STATUS_TEXT, plural, type ClipVM } from './bookModel';
import { amountInSentence } from '../../../services/costDisplay';
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

/**
 * "Page 3, out of date, 3 versions, $0.17 spent". `money` prints for the viewer; without one the
 * amount is left out (never dollars by default — governed users never see them).
 */
export const clipAriaLabel = (clip: ClipVM, money?: (usd: number) => string): string => {
  const parts = [clip.label];
  if (clip.plate) parts.push('made by software, free');
  else parts.push(STATUS_TEXT[clip.status].toLowerCase());
  if (clip.versions > 1) parts.push(plural(clip.versions, 'version'));
  if (clip.spentUsd > 0 && money) parts.push(`${amountInSentence(money(clip.spentUsd))} spent`);
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
  /** "Redraw ≈ $0.06" hint on hover/focus (registry price, printed for the viewer); undefined hides it. */
  nextPrice?: string;
  /** The viewer's money format (conversation/cost useCostFormat). Absent: no amounts are printed. */
  cost?: CostFormat;
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
  cost,
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
  const money = cost?.exact;
  // The tiny label under the thumb only fits a dollar amount; a governed share lives in the title and name.
  const spentTiny = clip.spentUsd > 0 && cost && !cost.governed ? cost.exact(clip.spentUsd) : '';
  const title = [clip.label, clip.plate ? 'Free — made by software' : STATUS_TEXT[clip.status], clip.versions > 1 ? `v${clip.versions}` : '', clip.spentUsd > 0 && money ? `${amountInSentence(money(clip.spentUsd))} spent` : '', nextPrice || '']
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
      <span className="sr-only">{clipAriaLabel(clip, money)}</span>
      <div className={cx('relative overflow-hidden rounded-lg bg-[var(--ds-well)]', ringFor(clip))} style={{ width: w, height: h }} aria-hidden>
        {body}
        {busy && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/25" aria-hidden>
            <LoaderCircle className="h-4 w-4 animate-spin text-white motion-reduce:animate-none" />
          </span>
        )}
        {clip.mismatch && !compact && (
          <span className="absolute left-0.5 top-0.5 inline-flex items-center gap-0.5 rounded bg-amber-700 px-1 text-[9px] font-semibold leading-[14px] text-white" aria-hidden>
            <AlertTriangle className="h-2.5 w-2.5" />
            {clip.mismatch.got}
          </span>
        )}
        {clip.status === 'stale' && (
          <span className="absolute inset-x-0 bottom-0 bg-amber-700 text-center text-[8.5px] font-semibold leading-[13px] text-white" aria-hidden>
            Out of date
          </span>
        )}
        {clip.status === 'failed' && (
          // red-700 under white 10 px semibold text: 6.5:1 (red-600/90 under 8.5 px measured 4.35:1 — P1-QA
          // timeline-failed-badge-contrast). "Failed" fits the narrowest (34 px compact) thumb at this size.
          <span className="absolute inset-x-0 bottom-0 truncate bg-red-700 text-center text-[10px] font-semibold leading-[14px] text-white" aria-hidden data-clip-badge="failed">
            Failed
          </span>
        )}
        {clip.continuity && !compact && (
          <span className="absolute bottom-0.5 right-0.5 rounded-full bg-[var(--ds-surface-strong)] p-px text-[var(--ds-muted)]" aria-hidden>
            <Info className="h-2.5 w-2.5" />
          </span>
        )}
        {/* A pointer affordance, not a control: no button inside the option (nested-interactive). The
            same menu opens with M, the context-menu key and a right-click / long-press. Positioned by
            itself (no .tap-target, whose touch rule overrode `absolute` — P1-SHELL). */}
        {!compact && (
          <span
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onMenu(e.currentTarget);
            }}
            title={`${clip.label} actions`}
            className="absolute right-0.5 top-0.5 inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-md bg-transparent text-[var(--ds-ink)] opacity-0 transition-opacity hover:bg-[var(--ds-surface-strong)] group-hover:opacity-100 group-focus-within:opacity-100 coarse:h-7 coarse:w-7 coarse:bg-[var(--ds-surface-strong)] coarse:opacity-90"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
      {!compact && (
        <div className="w-full min-w-0 text-center leading-tight" style={{ maxWidth: w + 8 }} aria-hidden>
          <p className="truncate text-[10.5px] font-semibold text-[var(--ds-ink)]">{short}</p>
          <p className="truncate text-[10px] tabular-nums text-[var(--ds-muted)]">
            {clip.plate ? 'Free' : [clip.versions > 1 ? `v${clip.versions}` : '', spentTiny].filter(Boolean).join(' · ') || ' '}
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
      title={`${label} — ${hint}`}
      tabIndex={tabIndex}
      onClick={() => !disabled && onActivate()}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      className={cx('flex shrink-0 cursor-pointer flex-col items-center gap-0.5 rounded-xl p-1 hover:bg-[var(--ds-hover)]', FOCUS_RING, disabled && 'cursor-not-allowed opacity-45')}
      style={{ minWidth: 44 }}
    >
      <span className="sr-only">{`${label} — ${hint}`}</span>
      <div
        aria-hidden
        className={cx(
          'flex items-center justify-center rounded-lg border border-dashed',
          ghost ? 'border-[var(--ds-hairline)] bg-transparent text-[var(--ds-muted)]' : 'border-[#D97757]/45 bg-[#D97757]/5 text-[var(--ds-accent)]'
        )}
        style={{ width: compact ? 36 : ghost ? 56 : 44, height: h }}
      >
        <Plus className="h-4 w-4" aria-hidden />
      </div>
      {!compact && (
        <div className="w-full min-w-0 text-center leading-tight" style={{ maxWidth: ghost ? 64 : 52 }} aria-hidden>
          <p className="truncate text-[10.5px] font-semibold text-[var(--ds-ink)]">{label}</p>
          <p className="truncate text-[10px] text-[var(--ds-muted)]">Free</p>
        </div>
      )}
    </div>
  );
};

export default TimelineClip;
