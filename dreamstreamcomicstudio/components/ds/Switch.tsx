/**
 * Switch — Atlas `ui-generated/switch.tsx`: a button with role="switch" and aria-checked. Space and Enter
 * toggle it (handled here, so the press never doubles with the button's own activation; a held key does
 * not repeat), as does a click or a tap on its label (inside a Field, or any <label> that wraps it).
 *
 * The track is the ink accent when on and the switch-background step (ink at 18 % over the page) when
 * off; the thumb springs across on the spring curve (instant under reduced motion) and mirrors in a
 * right-to-left layout. The 32 × 18 px control keeps a 44 × 44 hit area under a coarse pointer (an
 * invisible ::after), and transparent edges on the track and thumb so forced-colours mode draws both; the
 * thumb takes the system highlight there when on.
 */
import React, { useState } from 'react';
import { cn } from '../../lib/utils';
import { useFieldControl } from './Field';
import { FOCUS_RING } from './recipes';

export const SWITCH_TRACK =
  "group/switch relative inline-flex h-[1.15rem] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-[background-color,box-shadow,border-color] duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[var(--ds-accent-fill)] data-[state=unchecked]:bg-[color:color-mix(in_srgb,var(--ds-ink)_18%,var(--ds-canvas))] aria-invalid:border-[var(--ds-danger-mark)]";
/** The coarse-pointer hit area: an invisible 44 × 44 square centred on the track. */
export const SWITCH_HIT_AREA =
  "coarse:after:absolute coarse:after:left-1/2 coarse:after:top-1/2 coarse:after:h-[var(--ds-density-touch)] coarse:after:w-[var(--ds-density-touch)] coarse:after:-translate-x-1/2 coarse:after:-translate-y-1/2 coarse:after:content-['']";
export const SWITCH_THUMB =
  'pointer-events-none block size-4 rounded-full border border-transparent bg-[var(--ds-raised)] shadow-[shadow:var(--ds-shadow-segment)] transition-transform duration-[var(--ds-motion-slow)] ease-[var(--ds-ease-spring)] motion-reduce:transition-none data-[state=checked]:translate-x-[calc(100%-2px)] rtl:data-[state=checked]:-translate-x-[calc(100%-2px)] data-[state=checked]:bg-[var(--ds-on-accent)] dark:data-[state=unchecked]:bg-[var(--ds-ink)] forced-colors:[forced-color-adjust:none] forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:data-[state=checked]:border-[Highlight] forced-colors:data-[state=checked]:bg-[Highlight]';

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value' | 'defaultValue'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, defaultChecked = false, onCheckedChange, className, onClick, onKeyDown, ...props },
  ref
) {
  const wired = useFieldControl(props);
  const [inner, setInner] = useState(defaultChecked);
  const on = checked ?? inner;
  const state = on ? 'checked' : 'unchecked';
  const toggle = () => {
    if (wired.disabled) return;
    if (checked === undefined) setInner(!on);
    onCheckedChange?.(!on);
  };
  return (
    <button
      {...wired}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={on}
      data-state={state}
      data-slot="switch"
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) toggle();
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || (e.key !== ' ' && e.key !== 'Enter')) return;
        e.preventDefault();
        if (!e.repeat) toggle();
      }}
      className={`${cn(SWITCH_TRACK, SWITCH_HIT_AREA, className)} ${FOCUS_RING}`}
    >
      <span aria-hidden="true" data-slot="switch-thumb" data-state={state} className={SWITCH_THUMB} />
    </button>
  );
});
