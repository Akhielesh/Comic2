/**
 * Segmented — one choice out of a few, as a radio group (Atlas PanelTabs' look: SEGMENTED_TRACK with a
 * gliding SEGMENTED_PILL under the selected item). Selection follows focus, as radios do: the arrow keys
 * (mirrored right-to-left) move and choose, Home / End jump; only the chosen item is in the tab order
 * (the first enabled one while nothing is chosen, so the group is never unreachable). Each item is
 * 44 px tall under a coarse pointer, keeps a transparent edge for forced-colours mode and draws the
 * chosen one in the system highlight there.
 */
import React, { useRef } from 'react';
import { cn } from '../../lib/utils';
import { DENSITY, FOCUS_RING_FLUSH, SEGMENTED_ITEM, SEGMENTED_PILL, SEGMENTED_TRACK } from './recipes';
import { isRtl, nextRovingIndex } from './roving';
import { useGlidingPill } from './useGlidingPill';

export type SegmentedSize = 'sm' | 'default';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** A leading icon (decoration; the label names the item). */
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Native tooltip, e.g. for an icon-only item (pair with an aria-label in `label`). */
  title?: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** The group's accessible name. */
  label: string;
  size?: SegmentedSize;
  /** Stretch across the container (items share the width). */
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Item heights: 28 / 32 px (the track adds its 2 px inset and hairline), 44 px under a coarse pointer. */
export const SEGMENTED_SIZE: Record<SegmentedSize, string> = { sm: 'h-7 px-2.5', default: 'h-8' };
/** The item's own edge (transparent; forced colours draw it) and the chosen item in forced colours. */
export const SEGMENTED_ITEM_EDGE = 'border border-transparent disabled:pointer-events-none disabled:opacity-50 forced-colors:aria-checked:border-[Highlight] forced-colors:aria-selected:border-[Highlight]';

export function Segmented<T extends string>({ value, onChange, options, label, size = 'default', fullWidth = false, disabled = false, className }: SegmentedProps<T>) {
  const track = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const { rect, ready } = useGlidingPill(track, '[role="radio"][aria-checked="true"]', '[role="radio"]', `${value}|${options.length}`);
  const enabled = options.map((o) => !disabled && !o.disabled);
  const checkedIndex = options.findIndex((o, i) => o.value === value && enabled[i]);
  const tabStop = checkedIndex >= 0 ? checkedIndex : enabled.indexOf(true);

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const next = nextRovingIndex(e.key, index, enabled, isRtl(track.current));
    if (next === null) return;
    e.preventDefault();
    items.current[next]?.focus();
    if (options[next].value !== value) onChange(options[next].value);
  };

  return (
    <div
      ref={track}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-slot="segmented"
      className={cn(SEGMENTED_TRACK, fullWidth && 'flex w-full', className)}
    >
      {rect ? (
        <span
          aria-hidden="true"
          data-slot="segmented-pill"
          className={cn(SEGMENTED_PILL, !ready && 'transition-none')}
          style={{ width: rect.width, transform: `translateX(${rect.left}px)` }}
        />
      ) : null}
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              items.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={!enabled[i]}
            title={o.title}
            data-state={on ? 'on' : 'off'}
            onClick={() => {
              if (!on) onChange(o.value);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`${cn(SEGMENTED_ITEM, SEGMENTED_SIZE[size], SEGMENTED_ITEM_EDGE, DENSITY.coarse)} ${FOCUS_RING_FLUSH}`}
          >
            {o.icon ? (
              <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-4">
                {o.icon}
              </span>
            ) : null}
            <span className="min-w-0 truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
