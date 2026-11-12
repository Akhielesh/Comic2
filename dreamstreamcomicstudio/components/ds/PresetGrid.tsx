/**
 * PresetGrid — a set of PresetTiles (redesign plan §4: the Start panel's style row, Story › Style, the composer's
 * style strip, the lettering looks). Two semantics, one keyboard model:
 *
 *   radio    a `radiogroup`: exactly one choice; the arrow keys move AND choose (mirrored right-to-left; Up/Down step
 *            a row in a grid), Home / End jump, and only the chosen tile is in the tab order (the first enabled one
 *            while nothing is chosen, so the group is always reachable);
 *   pressed  a `group` of toggles (aria-pressed): the arrow keys only move focus, Space / Enter toggles, so several
 *            can be on (`value` is then the list of chosen ids).
 *
 * Columns are explicit (layout.ts rules: no auto-fill), or `scroll` lays the tiles in one row that scrolls sideways
 * (the composer strip) at `tileWidthPx`. The art is passed in per option; choosing never sends or spends anything
 * (the screen decides what a choice does).
 */
import React, { useRef } from 'react';
import { cn } from '../../lib/utils';
import { columnsStyle } from './layout';
import { PresetTile, type PresetSemantics } from './PresetTile';
import { isRtl, nextRovingIndex } from './roving';
import { useReducedMotion } from './useReducedMotion';

export interface PresetOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  art: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
}

interface PresetGridBase<T extends string> {
  options: readonly PresetOption<T>[];
  /** The group's accessible name ("Art style"). */
  label: string;
  columns?: number;
  /** One sideways-scrolling row instead of a grid. */
  scroll?: boolean;
  tileWidthPx?: number;
  aspect?: string;
  className?: string;
}

export interface PresetGridRadioProps<T extends string> extends PresetGridBase<T> {
  semantics?: 'radio';
  value: T | null;
  onChange: (value: T) => void;
}

export interface PresetGridPressedProps<T extends string> extends PresetGridBase<T> {
  semantics: 'pressed';
  value: readonly T[];
  onChange: (value: T[]) => void;
}

export type PresetGridProps<T extends string> = PresetGridRadioProps<T> | PresetGridPressedProps<T>;

export function PresetGrid<T extends string>(props: PresetGridProps<T>) {
  const { options, label, columns = 3, scroll = false, tileWidthPx = 128, aspect, className } = props;
  const semantics: PresetSemantics = props.semantics === 'pressed' ? 'pressed' : 'radio';
  const group = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o) => !o.disabled);
  const isOn = (v: T) => (props.semantics === 'pressed' ? props.value.includes(v) : props.value === v);
  const checked = options.findIndex((o, i) => enabled[i] && isOn(o.value));
  const tabStop = semantics === 'radio' && checked >= 0 ? checked : enabled.indexOf(true);
  const [focusIndex, setFocusIndex] = React.useState<number | null>(null);
  const stop = semantics === 'pressed' && focusIndex !== null ? focusIndex : tabStop;

  const choose = (i: number) => {
    const v = options[i].value;
    if (props.semantics === 'pressed') {
      props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v]);
    } else if (props.value !== v) props.onChange(v);
  };

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const cols = scroll ? 1 : Math.max(1, columns);
    let next: number | null = null;
    if (!scroll && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && cols > 1) {
      const step = e.key === 'ArrowDown' ? cols : -cols;
      let j = i + step;
      while (j >= 0 && j < options.length && !enabled[j]) j += step;
      next = j >= 0 && j < options.length ? j : null;
      if (next === null) {
        e.preventDefault();
        return;
      }
    } else {
      next = nextRovingIndex(e.key, i, enabled, isRtl(group.current));
    }
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    setFocusIndex(next);
    if (semantics === 'radio') choose(next);
  };

  return (
    <div
      ref={group}
      role={semantics === 'radio' ? 'radiogroup' : 'group'}
      aria-label={label}
      data-slot="preset-grid"
      className={cn(scroll ? 'flex min-w-0 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : 'grid min-w-0 grid-cols-[repeat(var(--cols),minmax(0,1fr))] gap-2', scroll && !reduced && 'ds-fade-edge-x', className)}
      style={scroll ? undefined : columnsStyle(columns)}
    >
      {options.map((o, i) => (
        <div key={o.value} className={scroll ? 'shrink-0' : 'min-w-0'} style={scroll ? { width: tileWidthPx } : undefined}>
          <PresetTile
            label={o.label}
            description={o.description}
            art={o.art}
            aspect={aspect}
            badge={o.badge}
            disabled={o.disabled}
            selected={isOn(o.value)}
            semantics={semantics}
            tabIndex={i === stop ? 0 : -1}
            onSelect={() => {
              setFocusIndex(i);
              choose(i);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            buttonRef={(el) => {
              refs.current[i] = el;
            }}
          />
        </div>
      ))}
    </div>
  );
}
