/**
 * Badge — Atlas `ui-generated/badge.tsx`, 1:1 variants on the tokens: default (the text-bearing accent
 * fill), secondary, destructive (the danger fill under `--ds-on-danger`), outline, and the status tints
 * success / warning (TONE_CHIP: readable tone ink on its own tint — pair it with a word, never colour
 * alone). 12 px medium, the chip radius, a 1 px edge in every variant (forced-colours mode draws it).
 *
 * Long labels (docs/design/design-system.md "Long words"): string / number runs sit in one CLIP_TEXT span that fills the badge, so a long name
 * ends in an ellipsis inside the edge instead of being cut at both ends by the centring. A hover `title` appears only
 * when the text is actually cut: on pointerenter the badge compares the span's scrollWidth with its clientWidth and sets
 * or clears the attribute on the element (no state, no timer). A caller's own `title` always wins; screen readers read
 * the full text either way.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { wrapTextRuns } from './Button';
import { ACCENT_FILL, CLIP_TEXT, DANGER_FILL, ON_ACCENT_TEXT, RADIUS_PILL, TONE_CHIP } from './recipes';

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

/** The badge's text runs, each in one CLIP_TEXT span (`{n} new` stays one span); elements (icons) stay direct children. */
const badgeChildren = (children: React.ReactNode) =>
  wrapTextRuns(children, (text, key) => (
    <span key={key} data-slot="badge-label" className={CLIP_TEXT}>
      {text}
    </span>
  ));

/** Sets the badge's `title` to its label only while a label span is cut (scrollWidth > clientWidth), else clears it. */
export function syncCutTitle(badge: HTMLElement): void {
  const spans = Array.from(badge.querySelectorAll<HTMLElement>(':scope > [data-slot="badge-label"]'));
  const cut = spans.some((s) => s.scrollWidth > s.clientWidth + 1);
  const text = (badge.textContent ?? '').trim();
  if (cut && text) badge.setAttribute('title', text);
  else badge.removeAttribute('title');
}

export function Badge({ variant = 'default', className, children, title, onPointerEnter, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      title={title}
      onPointerEnter={(e) => {
        if (title === undefined) syncCutTitle(e.currentTarget);
        onPointerEnter?.(e);
      }}
      data-slot="badge"
      data-variant={variant}
      className={cn(BADGE_BASE, BADGE_VARIANT[variant], className)}
    >
      {badgeChildren(children)}
    </span>
  );
}
