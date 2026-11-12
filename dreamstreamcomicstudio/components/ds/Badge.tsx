/**
 * Badge — Atlas `ui-generated/badge.tsx`, 1:1 variants on the tokens: default (the text-bearing accent
 * fill), secondary, destructive (the danger fill under `--ds-on-danger`), outline, and the status tints
 * success / warning (TONE_CHIP: readable tone ink on its own tint — pair it with a word, never colour
 * alone). 12 px medium, the chip radius, a 1 px edge in every variant (forced-colours mode draws it).
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { ACCENT_FILL, DANGER_FILL, ON_ACCENT_TEXT, RADIUS_PILL, TONE_CHIP } from './recipes';

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
export const BADGE_VARIANTS: readonly BadgeVariant[] = ['default', 'secondary', 'destructive', 'outline', 'success', 'warning'];

export const BADGE_BASE = `inline-flex w-fit max-w-full shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap ${RADIUS_PILL} border px-2 py-0.5 text-xs font-medium [&>svg]:pointer-events-none [&>svg]:size-3 transition-[color,background-color,border-color,box-shadow] duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)]`;

export const BADGE_VARIANT: Record<BadgeVariant, string> = {
  default: `border-transparent ${ACCENT_FILL} ${ON_ACCENT_TEXT}`,
  secondary: 'border-[color:color-mix(in_srgb,var(--ds-hairline)_60%,transparent)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)]',
  destructive: `border-transparent ${DANGER_FILL}`,
  outline: 'border-[var(--ds-hairline)] text-[var(--ds-ink)]',
  success: TONE_CHIP.success,
  warning: TONE_CHIP.warning
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = 'default', className, ...rest }: BadgeProps) {
  return <span {...rest} data-slot="badge" data-variant={variant} className={cn(BADGE_BASE, BADGE_VARIANT[variant], className)} />;
}
