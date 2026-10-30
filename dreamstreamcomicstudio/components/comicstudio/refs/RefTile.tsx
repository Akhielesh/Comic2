// One reference photo tile + the actions panel for the selected photo (refs.md §7.1). Owner: P1-REFS.
//
// Tile: the photo (veiled when blocked — never an <img> then), ★ on the main photo (index 0), the
// view label, honest "Sheet" / "Pages" / "Style" badges from the compiler's own ranking, gentle
// quality chips ("Blurry — we'll prefer your other photos") and a grey dot while the content check
// is still pending. Keyboard: Alt+←/→ moves it, Home makes it the main photo, Delete removes it.
// The drag handle reorders with pointer events (mouse, pen and touch alike).
//
// Actions (shown under the grid for the selected tile, full width — no popover can overflow a
// phone): Make main · label · note (≤ 140) · Tighten to subject / Reset crop · Move to… · Remove.

import React, { useEffect, useState } from 'react';
import { GripVertical, Star, Trash2, Crop, Undo2, ArrowRightLeft } from 'lucide-react';
import type { ContentRating } from '../../../shared/comic/safety';
import type { RefAsset, RefLabel, RefOwner } from '../../../shared/comic/doc';
import { REF_LIMITS, refOwnerKey } from '../../../shared/comic/refs';
import { TONE_TEXT } from '../../chat/studioDesign';
import { cx } from '../conversation/ui';
import { SafetyVeil } from '../safety/SafetyVeil';
import { labelText, labelsFor, type RefUsage } from './refsModel';

const QUALITY_COPY: Record<string, string> = {
  blurry: 'Blurry',
  dark: 'Dark',
  lowRes: 'Low-res',
  multiSubject: 'Several subjects'
};

export interface RefTileProps {
  refAsset: RefAsset;
  index: number;
  count: number;
  owner: RefOwner;
  src?: string;
  rating: ContentRating;
  usage?: RefUsage;
  selected?: boolean;
  /** Drag target highlight while another tile is dragged over this one. */
  dropTarget?: boolean;
  onSelect(): void;
  onMove(to: number): void;
  onRemove(): void;
  onDragHandleDown?(e: React.PointerEvent): void;
}

/** "Front Sheet, Photo 1 (main)" — the visible chip words first, then the position. */
export const refTileName = (index: number, visibleWords: string[]): string => {
  const position = `Photo ${index + 1}${index === 0 ? ' (main)' : ''}`;
  return visibleWords.length ? `${visibleWords.join(' ')}, ${position}` : position;
};

export const RefTile: React.FC<RefTileProps> = ({ refAsset: ref, index, count, owner, src, rating, usage, selected, dropTarget, onSelect, onMove, onRemove, onDragHandleDown }) => {
  const quality = Object.entries(ref.quality || {})
    .filter(([, v]) => v)
    .map(([k]) => QUALITY_COPY[k])
    .filter(Boolean);
  const unchecked = !ref.safety && ref.source === 'upload';
  // The words printed on the tile, in DOM order. The accessible name STARTS with them (axe
  // label-content-name-mismatch / WCAG 2.5.3, P1-QA ref-tile-names), then says which photo it is.
  const chips = [
    ref.label ? labelText(ref.label) : '',
    usage?.sheet ? 'Sheet' : '',
    usage?.pages ? 'Pages' : '',
    usage?.style ? 'Style' : '',
    ...quality
  ].filter(Boolean);
  const name = refTileName(index, chips);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey && e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      onMove(index - 1);
    } else if (e.altKey && e.key === 'ArrowRight' && index < count - 1) {
      e.preventDefault();
      onMove(index + 1);
    } else if (e.key === 'Home' && index > 0) {
      e.preventDefault();
      onMove(0);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onRemove();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={!!selected}
      aria-label={name}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Home Delete"
      data-ref-index={index}
      data-owner={refOwnerKey(owner)}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cx(
        'group relative aspect-square min-w-0 overflow-hidden rounded-xl border bg-[var(--ds-well)] outline-none transition-shadow motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[#D97757]/60',
        selected ? 'border-[#D97757] ring-2 ring-[#D97757]/40' : 'border-[var(--ds-hairline)]',
        dropTarget && 'ring-2 ring-[#D97757]/70'
      )}
    >
      <SafetyVeil asset={ref} rating={rating}>
        {src ? (
          <img src={src} alt="" draggable={false} loading="lazy" decoding="async" className="h-full w-full select-none object-cover" />
        ) : (
          <span className="studio-shimmer block h-full w-full" aria-hidden />
        )}
      </SafetyVeil>
      {/* The main photo: a compact ★ (its meaning is in the name and the title) — a worded "Main" badge
          collided with the label chip on small grid tiles (P1-QA ref-tile-badges-overlap). */}
      {index === 0 && (
        <span className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/55 text-white" title="Main photo" aria-hidden>
          <Star className="h-3 w-3 fill-current" />
        </span>
      )}
      {unchecked && (
        <span role="img" className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-zinc-400 ring-2 ring-white/80" title="Will be checked before it's used" aria-label="Will be checked before it's used" />
      )}
      {onDragHandleDown && count > 1 && (
        <span
          role="presentation"
          onPointerDown={(e) => {
            e.stopPropagation();
            onDragHandleDown(e);
          }}
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-0 right-0 flex h-11 w-11 cursor-grab touch-none items-end justify-end p-1.5 text-white/90 active:cursor-grabbing"
          title="Drag to reorder"
        >
          <GripVertical className="h-4 w-4 drop-shadow" aria-hidden />
        </span>
      )}
      {/* Chips stay in the bottom half (never reaching the ★ or the check dot), separated by real spaces
          so the visible words read as words. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex max-h-[60%] min-w-0 flex-wrap content-end gap-1 overflow-hidden bg-gradient-to-t from-black/60 to-transparent p-1.5 pr-10 pt-4">
        {ref.label && <span className="max-w-full truncate rounded-full bg-white/85 px-1.5 py-0.5 text-[10px] font-medium text-zinc-900">{labelText(ref.label)}</span>}{' '}
        {usage?.sheet && <span className="max-w-full truncate rounded-full bg-[#D97757] px-1.5 py-0.5 text-[10px] font-medium text-white">Sheet</span>}{' '}
        {usage?.pages && <span className="max-w-full truncate rounded-full bg-[#D97757]/85 px-1.5 py-0.5 text-[10px] font-medium text-white">Pages</span>}{' '}
        {usage?.style && <span className="max-w-full truncate rounded-full bg-[#D97757] px-1.5 py-0.5 text-[10px] font-medium text-white">Style</span>}{' '}
        {quality.map((q) => (
          <React.Fragment key={q}>
            <span className="max-w-full truncate rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] text-white" title={`${q} — we'll prefer your other photos`}>
              {q}
            </span>{' '}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

export interface RefActionsProps {
  refAsset: RefAsset;
  index: number;
  owner: RefOwner;
  moveTargets: { owner: RefOwner; label: string; full: boolean }[];
  onMakeMain(): void;
  onLabel(label: RefLabel | null): void;
  onNote(note: string | null): void;
  onCrop(mode: 'auto' | 'reset'): void;
  onTransfer(to: RefOwner): void;
  onRemove(): void;
  busy?: boolean;
}

// The action button's shape without an ink (`cx` does not merge: a tone stacked on the neutral ink
// loses to it). ACTION_BTN is the neutral action; Remove is ACTION_BTN_SHAPE + TONE_TEXT.danger.
const ACTION_BTN_SHAPE =
  'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[13px] font-medium transition-colors motion-reduce:transition-none hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 disabled:opacity-45';
const ACTION_BTN = `${ACTION_BTN_SHAPE} text-[var(--ds-ink)]`;
const FIELD =
  'min-h-[44px] w-full min-w-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-3 text-[16px] sm:text-[13px] text-[var(--ds-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45';

/** The selected photo's actions (full width under the grid). */
export const RefActions: React.FC<RefActionsProps> = ({ refAsset: ref, index, owner, moveTargets, onMakeMain, onLabel, onNote, onCrop, onTransfer, onRemove, busy }) => {
  const [note, setNote] = useState(ref.note || '');
  useEffect(() => setNote(ref.note || ''), [ref.path, ref.note]);
  const commitNote = () => {
    const next = note.replace(/\s+/g, ' ').trim().slice(0, REF_LIMITS.noteChars);
    if (next !== (ref.note || '')) onNote(next || null);
  };
  const labels = labelsFor(owner);
  const multi = !!ref.quality?.multiSubject;
  return (
    <section aria-label={`Photo ${index + 1} actions`} className="min-w-0 space-y-2 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3">
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="min-w-0 text-[12px] text-[var(--ds-muted)]">
          View
          <select className={cx(FIELD, 'mt-1')} value={ref.label || ''} onChange={(e) => onLabel((e.target.value || null) as RefLabel | null)} disabled={busy}>
            <option value="">No label</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {labelText(l)}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 text-[12px] text-[var(--ds-muted)]">
          Note <span className="tabular-nums">({note.length}/{REF_LIMITS.noteChars})</span>
          <input
            className={cx(FIELD, 'mt-1')}
            value={note}
            maxLength={REF_LIMITS.noteChars}
            placeholder="e.g. her festival outfit"
            onChange={(e) => setNote(e.target.value)}
            onBlur={commitNote}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitNote();
              }
            }}
            disabled={busy}
          />
        </label>
      </div>
      {multi && !ref.original && <p className="text-[12px] text-[var(--ds-muted)]">This photo shows several subjects — "Tighten to subject" helps the artist focus.</p>}
      <div className="flex min-w-0 flex-wrap gap-2">
        {index > 0 && (
          <button type="button" className={ACTION_BTN} onClick={onMakeMain} disabled={busy}>
            <Star className="h-4 w-4" aria-hidden /> Make main
          </button>
        )}
        {ref.original ? (
          <button type="button" className={ACTION_BTN} onClick={() => onCrop('reset')} disabled={busy}>
            <Undo2 className="h-4 w-4" aria-hidden /> Reset crop
          </button>
        ) : (
          <button type="button" className={ACTION_BTN} onClick={() => onCrop('auto')} disabled={busy}>
            <Crop className="h-4 w-4" aria-hidden /> Tighten to subject <span className="text-[11px] text-[var(--ds-muted)]">Free</span>
          </button>
        )}
        {moveTargets.length > 0 && (
          <label className="inline-flex min-w-0 max-w-full items-center gap-1.5">
            <ArrowRightLeft className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-hidden />
            <span className="sr-only">Move to</span>
            <select
              className={cx(FIELD, 'w-auto max-w-[220px]')}
              value=""
              onChange={(e) => {
                const target = moveTargets.find((t) => refOwnerKey(t.owner) === e.target.value);
                if (target && !target.full) onTransfer(target.owner);
              }}
              disabled={busy}
              aria-label="Move to"
            >
              <option value="">Move to…</option>
              {moveTargets.map((t) => (
                <option key={refOwnerKey(t.owner)} value={refOwnerKey(t.owner)} disabled={t.full}>
                  {t.label}
                  {t.full ? ' (full)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className={cx(ACTION_BTN_SHAPE, TONE_TEXT.danger)} onClick={onRemove} disabled={busy}>
          <Trash2 className="h-4 w-4" aria-hidden /> Remove
        </button>
      </div>
    </section>
  );
};

export default RefTile;
