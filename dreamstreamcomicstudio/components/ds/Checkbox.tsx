/**
 * Checkbox — Atlas `ui-generated/checkbox.tsx` built on a NATIVE checkbox: Space toggles, forms submit it
 * and a <label> anywhere names it, with no script. The input is invisible and laid over a drawn 16 px box
 * (and spreads to 44 × 44 under a coarse pointer, so the box is easy to hit); the box, the check and the
 * dash for "some" are siblings styled from the input's state (`peer-*`), never from script.
 *
 * `checked="indeterminate"` sets the input's `indeterminate` (screen readers say "mixed"); a press then
 * reports `true`. The edge is ink at 45 % (Atlas `border-foreground/45`, ≥ 3:1 on the page in every
 * theme), the ink accent when checked, the danger mark while `aria-invalid`; forced-colours mode keeps the
 * edge and draws the mark in the text colour. Pass `label` (and `description`, its description, not
 * part of its name) for a labelled row, or name it with a Field / aria-label.
 */
import React, { useCallback, useId, useLayoutEffect, useRef } from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useFieldControl } from './Field';
import { DENSITY } from './recipes';

/** The invisible native input over the drawn box; 44 × 44 under a coarse pointer. */
export const CHECKBOX_INPUT =
  'peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-[var(--ds-radius-sm)] opacity-0 disabled:cursor-not-allowed coarse:-inset-[calc((var(--ds-density-touch)_-_100%)/2)]';
/**
 * The drawn box. Its focus outline is FOCUS_RING read from the input (`peer-focus-visible:`), spelled out
 * here because Tailwind only generates class names it finds whole in the source.
 */
export const CHECKBOX_BOX =
  'pointer-events-none block size-4 shrink-0 rounded-[var(--ds-radius-sm)] border border-[color:color-mix(in_srgb,var(--ds-ink)_45%,transparent)] bg-[var(--ds-canvas)] shadow-[shadow:var(--ds-shadow-soft)] transition-[background-color,border-color,box-shadow] duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] peer-checked:border-[var(--ds-accent-fill)] peer-checked:bg-[var(--ds-accent-fill)] peer-indeterminate:border-[var(--ds-accent-fill)] peer-indeterminate:bg-[var(--ds-accent-fill)] peer-aria-[invalid=true]:border-[var(--ds-danger-mark)] peer-disabled:opacity-50 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color:var(--ds-focus)] contrast-more:peer-focus-visible:outline-[3px]';
const MARK = 'pointer-events-none absolute inset-0 m-auto hidden size-3.5 text-[var(--ds-on-accent)]';
export const CHECKBOX_CHECK = `${MARK} peer-checked:block peer-indeterminate:hidden`;
export const CHECKBOX_DASH = `${MARK} peer-indeterminate:block`;

export type CheckedState = boolean | 'indeterminate';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'defaultChecked' | 'size'> {
  checked?: CheckedState;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** A visible label beside the box; the whole row is the target. */
  label?: React.ReactNode;
  /** A muted line under the label (part of the checkbox's description). */
  description?: React.ReactNode;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, defaultChecked, onCheckedChange, onChange, label, description, className, ...props },
  forwarded
) {
  const wired = useFieldControl(props);
  const inner = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback(
    (el: HTMLInputElement | null) => {
      inner.current = el;
      if (typeof forwarded === 'function') forwarded(el);
      else if (forwarded) forwarded.current = el;
    },
    [forwarded]
  );
  const indeterminate = checked === 'indeterminate';
  // Every render: a press clears the DOM flag, and a parent that keeps "indeterminate" must restore it.
  useLayoutEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  });
  const generated = useId().replace(/:/g, '');
  const inputId = wired.id ?? `checkbox-${generated}`;
  const descriptionId = description ? `${inputId}-hint` : undefined;
  const describedBy = [wired['aria-describedby'], descriptionId].filter(Boolean).join(' ') || undefined;

  const box = (
    <span data-slot="checkbox" className={cn('relative inline-flex size-4 shrink-0', label ? 'mt-0.5 coarse:mt-0' : '', className)}>
      <input
        {...wired}
        ref={setRef}
        id={inputId}
        type="checkbox"
        aria-describedby={describedBy}
        checked={checked === undefined ? undefined : checked === true}
        defaultChecked={checked === undefined ? defaultChecked : undefined}
        data-state={indeterminate ? 'indeterminate' : checked === undefined ? undefined : checked ? 'checked' : 'unchecked'}
        onChange={(e) => {
          onChange?.(e);
          onCheckedChange?.(e.target.checked);
        }}
        className={CHECKBOX_INPUT}
      />
      <span aria-hidden="true" data-slot="checkbox-box" className={CHECKBOX_BOX} />
      <Check aria-hidden="true" strokeWidth={3} data-slot="checkbox-check" className={CHECKBOX_CHECK} />
      <Minus aria-hidden="true" strokeWidth={3} data-slot="checkbox-dash" className={CHECKBOX_DASH} />
    </span>
  );
  if (!label) return box;
  return (
    <span
      data-slot="checkbox-row"
      className={cn('inline-flex min-w-0 items-start gap-2.5 text-[length:var(--ds-text-base)] leading-5 text-[var(--ds-ink)] has-[:disabled]:opacity-50 coarse:items-center', DENSITY.coarse)}
    >
      {box}
      <span className="min-w-0">
        <label htmlFor={inputId} className="block cursor-pointer [overflow-wrap:anywhere]">
          {label}
        </label>
        {description ? (
          <span id={descriptionId} className="block text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]">
            {description}
          </span>
        ) : null}
      </span>
    </span>
  );
});
