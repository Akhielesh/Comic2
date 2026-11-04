/**
 * Select — a styled NATIVE <select> (the Radix select waits for the overlay decision, D6): the FIELD
 * recipe with Atlas's trigger sizes (sm h-8, default h-9) and chevron, 44 px under a coarse pointer, 16 px
 * text on phones. Native means the platform picker on phones, type-ahead and full keyboard support, and
 * form submission for free; in dark the popup follows `color-scheme`. A `placeholder` is a disabled first
 * option shown in the muted ink while nothing is chosen.
 */
import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useFieldControl } from './Field';
import { DENSITY, FIELD } from './recipes';

export type SelectSize = 'sm' | 'default';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export const SELECT_CLASSES = `${FIELD} w-full min-w-0 cursor-pointer appearance-none truncate py-0 pe-9 ps-3 text-base md:text-[length:var(--ds-text-base)] aria-invalid:border-[var(--ds-danger-mark)] data-[placeholder]:text-[var(--ds-muted)] ${DENSITY.coarse}`;
export const SELECT_SIZE: Record<SelectSize, string> = { sm: 'h-8', default: 'h-9' };

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: SelectSize;
  /** The choices (or pass <option> children). */
  options?: readonly SelectOption[];
  /** Shown while nothing is chosen (value ''); never selectable again once a choice is made. */
  placeholder?: string;
  /** Classes for the wrapper (width, margins); `className` styles the select itself. */
  wrapperClassName?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'default', options, placeholder, wrapperClassName, className, children, ...props },
  ref
) {
  const wired = useFieldControl(props);
  const controlled = wired.value !== undefined;
  // Uncontrolled, the placeholder ink follows the live choice.
  const [uncontrolledEmpty, setUncontrolledEmpty] = React.useState(wired.defaultValue === undefined || wired.defaultValue === '');
  const empty = controlled ? wired.value === '' : uncontrolledEmpty;
  const showingPlaceholder = Boolean(placeholder) && empty;
  const onChange: React.ChangeEventHandler<HTMLSelectElement> = (e) => {
    if (!controlled) setUncontrolledEmpty(e.target.value === '');
    wired.onChange?.(e);
  };
  return (
    <span data-slot="select" className={cn('relative inline-flex w-full min-w-0', wrapperClassName)}>
      <select
        {...wired}
        ref={ref}
        defaultValue={!controlled && wired.defaultValue === undefined && placeholder ? '' : wired.defaultValue}
        onChange={onChange}
        data-size={size}
        data-placeholder={showingPlaceholder ? '' : undefined}
        className={cn(SELECT_CLASSES, SELECT_SIZE[size], className)}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-[var(--ds-muted)]" />
    </span>
  );
});
