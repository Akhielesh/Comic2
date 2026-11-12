/**
 * IconButton — an icon-only Button that always has a name (master plan §1.1: 32 px on a fine pointer,
 * 44 × 44 under a coarse one). `label` is the accessible name and, until the Tooltip primitive lands
 * (DS-1c), the native hover title. The icon itself is decoration (aria-hidden).
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { BUTTON_BASE, BUTTON_VARIANT, type ButtonVariant } from './Button';
import { DENSITY, FOCUS_RING } from './recipes';

export type IconButtonSize = 'sm' | 'default' | 'lg';

/** 28 / 32 / 36 px squares; every size is 44 × 44 under a coarse pointer. */
export const ICON_BUTTON_SIZE: Record<IconButtonSize, string> = {
  sm: 'size-7 p-0',
  default: 'size-8 p-0',
  lg: 'size-9 p-0'
};

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The accessible name (icon-only controls must have one). */
  label: string;
  /** The icon (a lucide icon element); hidden from assistive tech. */
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: IconButtonSize;
  /** The native tooltip; the label by default. Pass `null` to drop it. */
  title?: string | null;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, variant = 'ghost', size = 'default', title, className, type, ...rest },
  ref
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={title === null ? undefined : (title ?? label)}
      data-slot="icon-button"
      data-variant={variant}
      data-size={size}
      className={`${cn(BUTTON_BASE, BUTTON_VARIANT[variant], ICON_BUTTON_SIZE[size], DENSITY.coarseSquare, className)} ${FOCUS_RING}`}
    >
      <span aria-hidden="true" className="contents">
        {children}
      </span>
    </button>
  );
});
