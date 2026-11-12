// PropertyRow — one labelled row of a Pro inspector panel (master plan §2.4 inspector, §2.7 chrome rules): the name on
// the left, the control(s) on the right, 32 px tall on a fine pointer and 44 px under a coarse one. The row is a
// labelled group, so a screen reader announces "Rotation, group" before the control; `hint` is one muted line under it.

import React, { useId } from 'react';
import { cn } from '../../../../lib/utils';
import { DENSITY, INK, MUTED } from '../../../chat/studioDesign';

export interface PropertyRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: string;
  /** One line under the row (a unit, a limit, why it is off). */
  hint?: string;
  children: React.ReactNode;
}

export const PropertyRow: React.FC<PropertyRowProps> = ({ label, hint, children, className, ...rest }) => {
  const id = useId();
  const hintId = useId();
  return (
    <div
      {...rest}
      role="group"
      aria-labelledby={id}
      aria-describedby={hint ? hintId : undefined}
      data-slot="property-row"
      className={cn('grid min-w-0 grid-cols-[minmax(0,6rem)_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5', DENSITY.compact, DENSITY.coarse, className)}
    >
      <span id={id} className={cn('min-w-0 truncate text-[12px] font-medium', INK)}>
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
      {hint && (
        <p id={hintId} className={cn('col-span-2 m-0 min-w-0 text-[11px] leading-snug [overflow-wrap:anywhere]', MUTED)}>
          {hint}
        </p>
      )}
    </div>
  );
};
