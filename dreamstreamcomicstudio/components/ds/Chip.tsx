/**
 * Chip — a neutral label (Atlas MetaChip on the CHIP / CHIP_VARIANT recipes): outline (default), filled
 * (a soft ink fill for something named: a comic, a series, a style) or dashed (provisional / not set).
 * Status meaning is StatusChip's job; a chip never colours itself. Long labels truncate inside it.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { CHIP, CHIP_VARIANT } from './recipes';

export type ChipVariant = keyof typeof CHIP_VARIANT;

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: ChipVariant;
  /** A leading icon (decoration). */
  icon?: React.ReactNode;
}

export function Chip({ variant = 'outline', icon, className, children, ...rest }: ChipProps) {
  return (
    <span {...rest} data-slot="chip" data-variant={variant} className={cn(CHIP, CHIP_VARIANT[variant], className)}>
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-3">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
