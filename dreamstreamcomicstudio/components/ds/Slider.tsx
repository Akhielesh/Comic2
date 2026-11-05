/**
 * Slider — Atlas `ui-generated/slider.tsx` (track h-4, the accent range, a 16 px paper thumb ringed in
 * the accent) on a NATIVE range input: role slider, value and drag on touch come from the platform.
 * The keyboard is handled here so every browser behaves the same (and the native step is not applied a
 * second time): the arrows (Left / Right mirrored right-to-left) move one `step`, Page Up / Page Down a
 * `largeStep` (a tenth of the range by default), Home / End the ends; values snap to the step.
 *
 * The filled part is a gradient stop (`--slider-fill`) on the track, so it follows the value without a
 * second element and mirrors right-to-left. 44 px tall under a coarse pointer (the track stays 16 px,
 * centred); the ink focus outline around the control; in forced-colours mode the track is outlined and
 * the thumb keeps its edge.
 */
import React, { useState } from 'react';
import { cn } from '../../lib/utils';
import { useFieldControl } from './Field';
import { DENSITY, FOCUS_RING } from './recipes';
import { isRtl } from './roving';

export const SLIDER_CLASSES = [
  'relative block h-4 w-full min-w-0 cursor-pointer appearance-none rounded-full bg-transparent disabled:cursor-not-allowed disabled:opacity-50',
  DENSITY.coarse,
  // WebKit / Blink
  '[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:rounded-full',
  '[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--ds-accent-fill)_var(--slider-fill),var(--ds-well-strong)_var(--slider-fill))]',
  'rtl:[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_left,var(--ds-accent-fill)_var(--slider-fill),var(--ds-well-strong)_var(--slider-fill))]',
  '[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-solid [&::-webkit-slider-thumb]:border-[var(--ds-accent-fill)] [&::-webkit-slider-thumb]:bg-[var(--ds-canvas)] [&::-webkit-slider-thumb]:shadow-[shadow:var(--ds-shadow-soft)]',
  'hover:[&::-webkit-slider-thumb]:shadow-[0_0_0_4px_color-mix(in_srgb,var(--ds-ring)_50%,transparent)]',
  // Firefox
  '[&::-moz-range-track]:h-4 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[var(--ds-well-strong)]',
  '[&::-moz-range-progress]:h-4 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-[var(--ds-accent-fill)]',
  '[&::-moz-range-thumb]:box-border [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-solid [&::-moz-range-thumb]:border-[var(--ds-accent-fill)] [&::-moz-range-thumb]:bg-[var(--ds-canvas)]',
  // Forced colours: the track is outlined (its fills are painted over), the thumb keeps its edge. The outline
  // style is an arbitrary property: tailwind-merge reads a bare `outline` as a width and would drop it.
  'forced-colors:[&::-webkit-slider-runnable-track]:[outline-style:solid] forced-colors:[&::-webkit-slider-runnable-track]:outline-1 forced-colors:[&::-moz-range-track]:[outline-style:solid] forced-colors:[&::-moz-range-track]:outline-1'
].join(' ');

export interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'step' | 'size'> {
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  /** The Page Up / Page Down step (a tenth of the range by default, at least one step). */
  largeStep?: number;
  onValueChange?: (value: number) => void;
  /** The spoken value (aria-valuetext), e.g. `(v) => `${v} %``. */
  valueText?: (value: number) => string;
}

const decimals = (n: number) => (String(n).split('.')[1] ?? '').length;

/** Clamp to [min, max] and snap to the step grid (float-safe). */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  if (!(step > 0)) return clamped;
  const snapped = Math.round((clamped - min) / step) * step + min;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(Math.max(decimals(step), decimals(min))));
}

export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { value, defaultValue, min = 0, max = 100, step = 1, largeStep, onValueChange, valueText, className, style, onKeyDown, ...props },
  ref
) {
  const wired = useFieldControl(props);
  const [inner, setInner] = useState(() => snapToStep(defaultValue ?? min, min, max, step));
  const current = value ?? inner;
  const big = largeStep ?? Math.max(step, snapToStep((max - min) / 10, 0, max - min, step));
  const commit = (next: number) => {
    const v = snapToStep(next, min, max, step);
    if (v === current) return;
    if (value === undefined) setInner(v);
    onValueChange?.(v);
  };
  const fill = max > min ? ((current - min) / (max - min)) * 100 : 0;
  return (
    <input
      {...wired}
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={step}
      value={current}
      aria-valuetext={valueText ? valueText(current) : wired['aria-valuetext']}
      data-slot="slider"
      onChange={(e) => commit(Number(e.target.value))}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || wired.disabled) return;
        const rtl = isRtl(e.currentTarget);
        const deltas: Record<string, number> = {
          ArrowUp: step,
          ArrowDown: -step,
          ArrowRight: rtl ? -step : step,
          ArrowLeft: rtl ? step : -step,
          PageUp: big,
          PageDown: -big
        };
        let next: number | null = null;
        if (e.key in deltas) next = current + deltas[e.key];
        else if (e.key === 'Home') next = min;
        else if (e.key === 'End') next = max;
        if (next === null) return;
        e.preventDefault();
        commit(next);
      }}
      style={{ ...style, ['--slider-fill' as string]: `${fill}%` }}
      className={`${cn(SLIDER_CLASSES, className)} ${FOCUS_RING}`}
    />
  );
});
