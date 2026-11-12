/**
 * FilterChips — one filter out of a few, as chips with counts (redesign plan §4; the Library's five chips, Discover's
 * kind and language chips): a radio group, so exactly one chip is on ("All" first), the arrow keys move and
 * choose (mirrored right-to-left), Home / End jump, and only the chosen chip is in the tab order.
 *
 * A count is shown after the label ("Drafts 3", tabular) and spoken with it ("Drafts, 3 comics"). A chip with a
 * zero count stays choosable (the grid then says why it is empty) unless `hideEmpty`. On one line (`scroll`) the
 * row scrolls sideways with an edge fade, never wrapping into a second row of chrome on a phone. Each chip is 32 px
 * and 44 px tall under a coarse pointer. The chosen chip is the ink chip; colour never carries the state alone
 * (aria-checked and the filled shape say it too).
 */
import React, { useRef } from 'react';
import { cn } from '../../lib/utils';
import { CHIP, CHIP_VARIANT, DENSITY, FOCUS_RING } from './recipes';
import { isRtl, nextRovingIndex } from './roving';

export interface FilterChipOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  disabled?: boolean;
}

export interface FilterChipsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly FilterChipOption<T>[];
  /** The group's accessible name ("Filter comics"). */
  label: string;
  /** The noun a count is spoken with ("comics"). */
  countNoun?: string;
  /** Leave out chips whose count is 0 (the chosen one always stays). */
  hideEmpty?: boolean;
  /** One line that scrolls sideways instead of wrapping. */
  scroll?: boolean;
  className?: string;
}

/** The chip's shape at the kit's sizes (32 px; 44 px under a coarse pointer). */
export const FILTER_CHIP = `${CHIP} h-8 shrink-0 cursor-pointer px-3 text-[13px] leading-5 ${DENSITY.coarse} disabled:cursor-not-allowed disabled:opacity-50`;
/** The chosen chip: the ink chip with the page colour for its words. */
export const FILTER_CHIP_ON = 'border-transparent bg-[var(--ds-ink)] text-[var(--ds-canvas)]';

export function FilterChips<T extends string>({ value, onChange, options, label, countNoun, hideEmpty = false, scroll = false, className }: FilterChipsProps<T>) {
  const group = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = hideEmpty ? options.filter((o) => o.value === value || o.count === undefined || o.count > 0) : options;
  const enabled = shown.map((o) => !o.disabled);
  const checked = shown.findIndex((o) => o.value === value && !o.disabled);
  const tabStop = checked >= 0 ? checked : enabled.indexOf(true);

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const next = nextRovingIndex(e.key, index, enabled, isRtl(group.current));
    if (next === null) return;
    e.preventDefault();
    items.current[next]?.focus();
    if (shown[next].value !== value) onChange(shown[next].value);
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      data-slot="filter-chips"
      className={cn('flex min-w-0 gap-1.5', scroll ? 'ds-fade-edge-x flex-nowrap overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : 'flex-wrap', className)}
    >
      {shown.map((o, i) => {
        const on = o.value === value;
        const spoken = typeof o.count === 'number' ? `${o.label}, ${o.count.toLocaleString()}${countNoun ? ` ${countNoun}` : ''}` : o.label;
        return (
          <button
            key={o.value}
            ref={(el) => {
              items.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={spoken}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={!enabled[i]}
            data-state={on ? 'on' : 'off'}
            onClick={() => {
              if (!on) onChange(o.value);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`${cn(FILTER_CHIP, on ? FILTER_CHIP_ON : cn(CHIP_VARIANT.outline, 'hover:border-[var(--ds-control-border-hover)] hover:text-[var(--ds-ink)]'))} ${FOCUS_RING}`}
          >
            <span>{o.label}</span>
            {typeof o.count === 'number' ? <span className="tabular-nums opacity-80">{o.count.toLocaleString()}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
