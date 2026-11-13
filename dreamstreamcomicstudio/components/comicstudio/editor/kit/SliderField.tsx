// SliderField — a labelled ds Slider with its value beside it (master plan §2.4): the value follows the thumb live
// through `onChange` (a preview), and `onCommit` runs ONCE when the gesture ends (pointer up, a key released, or focus
// leaving), so a whole drag is one undo entry. The ds Slider brings the keyboard (arrows, Page Up/Down, Home/End), RTL
// and the 44 px coarse target.

import React, { useId, useRef, useState, useEffect } from 'react';
import { cn } from '../../../../lib/utils';
import { Slider } from '../../../ds/Slider';
import { INK, MUTED } from '../../../chat/studioDesign';

export interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  onChange?(value: number): void;
  onCommit(value: number): void;
  className?: string;
}

export const SliderField: React.FC<SliderFieldProps> = ({ label, value, min, max, step = 1, unit, disabled, onChange, onCommit, className }) => {
  const id = useId();
  const [live, setLive] = useState(value);
  const start = useRef<number | null>(null);
  useEffect(() => {
    if (start.current === null) setLive(value);
  }, [value]);
  const settle = () => {
    const from = start.current;
    start.current = null;
    if (from !== null && live !== from) onCommit(live);
  };
  const shown = unit ? `${live}${unit}` : String(live);
  return (
    <div data-slot="slider-field" className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <label htmlFor={id} className={cn('min-w-0 truncate text-[12px] font-medium', INK)}>
          {label}
        </label>
        <span aria-hidden="true" className={cn('shrink-0 text-[11.5px] tabular-nums', MUTED)}>
          {shown}
        </span>
      </div>
      <Slider
        id={id}
        value={live}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        valueText={() => shown}
        onValueChange={(v) => {
          if (start.current === null) start.current = live;
          setLive(v);
          onChange?.(v);
        }}
        onPointerUp={settle}
        onKeyUp={settle}
        onBlur={settle}
      />
    </div>
  );
};
