// ScrubField — a typed number with a scrubbable label (master plan §2.4 "numeric fields", §2.9 non-drag alternatives;
// the Figma / Photoshop pattern). Three ways to change it, each ONE commit (so one undo entry):
//   - type a value and press Enter (or leave the field): clamped, snapped to the step, committed once if it changed;
//   - the arrow keys: one step (Shift ×10), committed per press (callers coalesce a run of presses into one entry);
//   - drag the label sideways: the value follows live through `onChange` (a preview), and `onCommit` runs once on
//     release. A second pointer or Esc cancels the drag and restores the start value; nothing is committed.
// 44 px tall under a coarse pointer; tabular numbers; the unit is a suffix the screen reader hears with the value.

import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../../../../lib/utils';
import { DENSITY, FIELD, FOCUS_RING, INK, MUTED, RADIUS_CONTROL } from '../../../chat/studioDesign';

export interface ScrubFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Default 1. */
  step?: number;
  /** "°", "%", "pt". */
  unit?: string;
  /** Pixels of drag per step (default 4). */
  pxPerStep?: number;
  disabled?: boolean;
  /** Live while scrubbing (a preview; never an undo entry). */
  onChange?(value: number): void;
  /** One committed value (a typed Enter, an arrow press, a finished scrub). */
  onCommit(value: number): void;
  className?: string;
  id?: string;
}

const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;

/** Clamp to [min, max] and snap to the step (float-safe). Pure; tested. */
export const clampToStep = (v: number, min: number, max: number, step = 1): number => {
  if (!Number.isFinite(v)) return min;
  const c = Math.min(max, Math.max(min, v));
  if (!(step > 0)) return c;
  const s = Math.round((c - min) / step) * step + min;
  return Number(Math.min(max, Math.max(min, s)).toFixed(Math.max(decimals(step), decimals(min))));
};

/** "12", "-7.5", "12°", "12 %" → 12 / -7.5 (null when it is not a number). Pure. */
export const parseNumber = (text: string): number | null => {
  const m = text.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};

export const ScrubField: React.FC<ScrubFieldProps> = ({ label, value, min, max, step = 1, unit, pxPerStep = 4, disabled, onChange, onCommit, className, id }) => {
  const [text, setText] = useState(String(value));
  const [scrubbing, setScrubbing] = useState(false);
  const scrub = useRef<{ x: number; start: number; latest: number; pointer: number } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!scrubbing) setText(String(value));
  }, [value, scrubbing]);
  useEffect(() => () => cleanup.current?.(), []);

  const commit = (v: number) => {
    const next = clampToStep(v, min, max, step);
    setText(String(next));
    if (next !== value) onCommit(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const n = parseNumber(text);
      if (n === null) setText(String(value));
      else commit(n);
      return;
    }
    if (e.key === 'Escape') {
      setText(String(value));
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
    commit((parseNumber(text) ?? value) + delta);
  };

  const beginScrub = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    cleanup.current?.();
    const st = { x: e.clientX, start: value, latest: value, pointer: e.pointerId };
    scrub.current = st;
    setScrubbing(true);
    const end = (commitIt: boolean) => {
      cleanup.current?.();
      scrub.current = null;
      setScrubbing(false);
      if (!commitIt) {
        setText(String(st.start));
        onChange?.(st.start);
        return;
      }
      if (st.latest !== st.start) onCommit(st.latest);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== st.pointer) {
        // A second pointer (a pinch, another finger) cancels the scrub: nothing is committed.
        end(false);
        return;
      }
      const next = clampToStep(st.start + Math.round((ev.clientX - st.x) / pxPerStep) * step, min, max, step);
      if (next === st.latest) return;
      st.latest = next;
      setText(String(next));
      onChange?.(next);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === st.pointer) end(true);
    };
    const cancel = () => end(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') end(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      cleanup.current = null;
    };
  };

  return (
    <span data-slot="scrub-field" className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span
        aria-hidden="true"
        data-testid="scrub-handle"
        onPointerDown={beginScrub}
        className={cn('shrink-0 cursor-ew-resize select-none px-1 text-[11px] font-medium touch-none', scrubbing ? INK : MUTED, disabled && 'cursor-default opacity-50')}
        title={disabled ? undefined : `Drag to change ${label.toLowerCase()}`}
      >
        {label}
      </span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={unit ? `${value}${unit}` : String(value)}
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          const n = parseNumber(text);
          if (n === null) setText(String(value));
          else commit(n);
        }}
        className={`${cn(FIELD, RADIUS_CONTROL, 'h-7 w-16 min-w-0 px-1.5 text-right text-[12px] tabular-nums', DENSITY.coarse, 'coarse:text-[16px]')} ${FOCUS_RING}`}
      />
      {unit && (
        <span aria-hidden="true" className={cn('shrink-0 text-[11px]', MUTED)}>
          {unit}
        </span>
      )}
    </span>
  );
};
