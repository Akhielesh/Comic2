// A typed number field for the Pro inspector (agent-editor plan §3 C2; master plan §2.4 "Inspector"): every slider
// gets one. Arrow keys step, Shift ×10; Enter (or leaving the field) commits ONE undo entry; Escape puts the value
// back. Values are clamped to the field's range. On touch it is "− value +" with real 44 px steppers, and the input
// opens the number keypad (inputMode decimal). Keys typed here never reach the editor's shortcuts.
//
// The field shows DISPLAY units (a percentage, 1/1000 em, degrees…) and commits STORED units: `scale` converts
// (stored × scale = shown). A selection that disagrees shows "Mixed" and the arrows wait for a typed value.
//
// A typed value belongs to what the field showed when the typing started: the field keeps the `onCommit` of that
// moment and commits the draft through it. The page editor selects a balloon on pointerdown, before the field blurs, so
// "type 150, then click the next balloon" re-renders the field for the next balloon first; the draft still goes to the
// balloon it was typed for, never to the newly selected one.

import React, { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FOCUS_RING_FLUSH, INK, MUTED, RADIUS_CONTROL } from '../../chat/studioDesign';

/** How a value was committed: typed (Enter / leaving the field) or stepped (arrow keys, the − / + buttons). Steps are
 *  what callers coalesce into one undo entry; a typed value is always its own. */
export interface NumberCommit {
  via: 'type' | 'step';
}

export interface NumberFieldProps {
  label: string;
  /** Stored value; undefined when the selection disagrees ("Mixed"). */
  value: number | undefined;
  /** Range and step in DISPLAY units. */
  min: number;
  max: number;
  step: number;
  /** Stored × scale = shown (100 shows a fraction as a percentage). Default 1. */
  scale?: number;
  /** Decimals shown; default from the step. */
  decimals?: number;
  /** "%", "°", "‰ em", "mm"… shown after the value. */
  unit?: string;
  disabled?: boolean;
  title?: string;
  /** The row already names the field: keep the label for screen readers only. */
  hideLabel?: boolean;
  /** The − / + buttons (default true; the touch keypad path). */
  steppers?: boolean;
  /** Commits a STORED value (clamped, rounded to the shown decimals). */
  onCommit(value: number, how: NumberCommit): void;
  testId?: string;
  className?: string;
}

const decimalsOf = (step: number): number => {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(4, s.length - i - 1);
};

/** Round to `decimals` places (no −0). */
export const roundTo = (v: number, decimals: number): number => {
  const f = 10 ** Math.max(0, decimals);
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
};

/** Clamp into [min, max] (a non-finite value becomes min). */
export const clampTo = (v: number, min: number, max: number): number => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min);

/** One arrow step from `from` (display units): ±step, ×10 with Shift, clamped and rounded. */
export const stepValue = (from: number, dir: 1 | -1, step: number, big: boolean, min: number, max: number, decimals = decimalsOf(step)): number =>
  roundTo(clampTo(from + dir * step * (big ? 10 : 1), min, max), decimals);

/** What a person typed, as a number: "12", "-3.5", "40 %", "15°", "1,5" (a decimal comma). Undefined when it is not one. */
export const parseNumberText = (text: string): number | undefined => {
  const t = text.trim().replace(/[%°\s]|‰|em|mm|in|pt/gi, '').replace(/^\+/, '').replace(/[−–]/g, '-');
  if (!t) return undefined;
  const normal = /^-?\d+,\d+$/.test(t) ? t.replace(',', '.') : t;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(normal)) return undefined;
  const n = Number(normal);
  return Number.isFinite(n) ? n : undefined;
};

const STEPPER = cn(
  'grid h-7 w-6 shrink-0 place-items-center text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:cursor-not-allowed disabled:opacity-40',
  'coarse:h-11 coarse:min-h-11 coarse:w-11 coarse:min-w-11',
  RADIUS_CONTROL,
  FOCUS_RING_FLUSH
);

export const NumberField: React.FC<NumberFieldProps> = ({
  label,
  value,
  min,
  max,
  step,
  scale = 1,
  decimals,
  unit,
  disabled,
  title,
  hideLabel,
  steppers = true,
  onCommit,
  testId,
  className
}) => {
  const id = useId();
  const places = decimals ?? decimalsOf(step);
  const shown = value === undefined || !Number.isFinite(value) ? undefined : roundTo(value * scale, places);
  const [draft, setDraft] = useState<string | null>(null);
  // The value shown for the field's current target (display units).
  const last = useRef<number | undefined>(shown);
  // Who the pending draft belongs to (see the header): the `onCommit` of the moment it started, and the value it started
  // from. A commit only goes out when the value really differs from that start, so Enter and then leaving the field
  // never makes two undo entries, and an unchanged value ("50.0" for 50) makes none.
  const pending = useRef<{ send: NumberFieldProps['onCommit']; base: number | undefined } | null>(null);
  const own = () => (pending.current ??= { send: onCommit, base: last.current });
  const clearDraft = () => {
    pending.current = null;
    setDraft(null);
  };
  useEffect(() => {
    last.current = shown;
    pending.current = null;
    setDraft(null);
  }, [shown]);

  const commit = (display: number, how: NumberCommit) => {
    const p = own();
    const next = roundTo(clampTo(display, min, max), places);
    if (p.base !== undefined && Math.abs(next - p.base) < 10 ** -(places + 1)) {
      clearDraft();
      return;
    }
    if (how.via === 'step') {
      // Arrow steps run on from the stepped value until the new value comes back as `shown`.
      p.base = next;
      setDraft(String(next));
    } else clearDraft();
    p.send(roundTo(next / scale, places + Math.max(0, Math.round(Math.log10(scale))) + 2), how);
  };
  const commitDraft = () => {
    if (draft === null) return;
    const n = parseNumberText(draft);
    if (n === undefined) {
      clearDraft();
      return;
    }
    commit(n, { via: 'type' });
  };
  const typeDraft = (text: string) => {
    own();
    setDraft(text);
  };
  const stepBy = (dir: 1 | -1, big: boolean) => {
    if (disabled) return;
    const base = draft !== null ? parseNumberText(draft) ?? pending.current?.base ?? last.current : last.current;
    // Mixed: the arrows wait for a typed value (stepping from an arbitrary middle would be a guess).
    if (base === undefined) return;
    commit(stepValue(base, dir, step, big, min, max, places), { via: 'step' });
  };

  const text = draft ?? (shown === undefined ? '' : String(shown));
  return (
    <div className={cn('min-w-0', className)} data-testid={testId}>
      <label htmlFor={id} className={cn('mb-0.5 block text-[11.5px] font-medium', MUTED, hideLabel && 'sr-only')}>
        {label}
      </label>
      <div className={cn('flex min-w-0 items-center gap-0.5 border border-[var(--ds-hairline)] bg-[var(--ds-canvas)] focus-within:border-[var(--ds-focus)]', RADIUS_CONTROL, disabled && 'opacity-50')}>
        {steppers && (
          <button type="button" tabIndex={-1} aria-label={`Decrease ${label.toLowerCase()}`} disabled={disabled || shown === undefined || shown <= min} className={STEPPER} onClick={() => stepBy(-1, false)}>
            <Minus className="h-3 w-3" aria-hidden />
          </button>
        )}
        <input
          id={id}
          type="text"
          inputMode="decimal"
          role="spinbutton"
          autoComplete="off"
          spellCheck={false}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={shown}
          aria-valuetext={shown === undefined ? 'Mixed' : `${shown}${unit ? ` ${unit}` : ''}`}
          title={title}
          disabled={disabled}
          placeholder={shown === undefined ? 'Mixed' : undefined}
          value={text}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => typeDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            // Typing here never moves a balloon, turns the page or fires a tool.
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              clearDraft();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              stepBy(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
            }
          }}
          className={cn('h-7 w-full min-w-0 flex-1 bg-transparent px-1 text-right text-[12px] tabular-nums focus-visible:outline-none coarse:h-11 coarse:text-[14px]', INK)}
        />
        {unit && (
          <span aria-hidden className={cn('shrink-0 pr-1 text-[11px]', MUTED)}>
            {unit}
          </span>
        )}
        {steppers && (
          <button type="button" tabIndex={-1} aria-label={`Increase ${label.toLowerCase()}`} disabled={disabled || shown === undefined || shown >= max} className={STEPPER} onClick={() => stepBy(1, false)}>
            <Plus className="h-3 w-3" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
};

export default NumberField;
