/**
 * Button — Atlas `ui-generated/button.tsx` on the `--ds-*` tokens (docs/design/design-system.md).
 *
 * Variants and sizes are Atlas's, 1:1: default / destructive / outline / secondary / ghost / link ×
 * sm (h-8) / default (h-9) / lg (h-10) / icon (36 px square). Mapped onto the tokens: the primary fill is
 * the text-bearing accent (ink under the skin, the brand outside it, label ≥ 4.5:1 either way); the
 * destructive fill carries `--ds-on-danger`; Atlas's `hover:bg-accent` is `--ds-hover` (its menu hover:
 * the same step in dark, neutral outside the skin where `--ds-accent-soft` is the brand tint).
 *
 * Every button: a 1 px edge (transparent where Atlas has none, so forced-colours mode still draws the
 * button), 44 px tall under a coarse pointer (square for `icon`), the ink focus outline, press feedback
 * (motion-safe), `aria-invalid` in the danger mark. `loading` keeps the button focused (aria-disabled,
 * not disabled), says so (aria-busy and a spinner) and ignores presses.
 *
 * One DreamStream variant beside Atlas's six (the colour layer "Ink & Spark", docs/design/design-system.md):
 * `create`, the spark fill, named by meaning. It is the ONE "start making" action in a view (New comic, Start a
 * comic, composer Send, Share when ready), never a control that spends or shows a price (those stay `default`,
 * the ink primary), and never two in a view: tests/config/sparkGuard.test.ts holds every use to its allowlist
 * and fails on a price inside or beside it; the layout smoke counts `[data-variant="create"]` per viewport.
 */
import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  ACCENT_FILL,
  ACCENT_FILL_HOVER,
  ACCENT_TEXT,
  DANGER_FILL,
  DANGER_FILL_HOVER,
  DENSITY,
  FOCUS_RING,
  ON_ACCENT_TEXT,
  RADIUS_CONTROL,
  SHADOW_SOFT,
  SPARK_FILL
} from './recipes';

export type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' | 'create';
export type ButtonSize = 'sm' | 'default' | 'lg' | 'icon';

/** Atlas's six variants, 1:1. */
export const BUTTON_VARIANTS: readonly ButtonVariant[] = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'];
/** The DreamStream extensions beside them (not from Atlas): `create`, the spark fill. */
export const BUTTON_EXTENSION_VARIANTS: readonly ButtonVariant[] = ['create'];
export const BUTTON_SIZES: readonly ButtonSize[] = ['sm', 'default', 'lg', 'icon'];

/** Shape, type, motion and states shared by every variant (the focus outline is appended after the merge). */
export const BUTTON_BASE = `inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap ${RADIUS_CONTROL} border text-[length:var(--ds-text-base)] font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] motion-safe:active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-[invalid=true]:border-[var(--ds-danger-mark)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 ${DENSITY.coarse}`;

export const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  default: `border-transparent ${ACCENT_FILL} ${ON_ACCENT_TEXT} ${ACCENT_FILL_HOVER} ${SHADOW_SOFT}`,
  destructive: `border-transparent ${DANGER_FILL} ${DANGER_FILL_HOVER} ${SHADOW_SOFT}`,
  outline:
    'border-[var(--ds-hairline)] bg-[var(--ds-raised)] text-[var(--ds-ink)] hover:border-[color:color-mix(in_srgb,var(--ds-ink)_25%,transparent)] hover:bg-[var(--ds-hover)]',
  secondary: 'border-transparent bg-[var(--ds-surface-soft)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]',
  ghost: 'border-transparent bg-transparent hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]',
  link: `border-transparent ${ACCENT_TEXT} underline-offset-4 hover:underline`,
  create: `border-transparent ${SPARK_FILL} ${SHADOW_SOFT}`
};

export const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 has-[>svg]:px-2.5',
  default: 'h-9 px-4 py-2 has-[>svg]:px-3',
  lg: 'h-10 px-6 has-[>svg]:px-4',
  icon: `size-9 p-0 ${DENSITY.coarseSquare}`
};

/**
 * The button classes, for an element that is not a <button> but must look like one (a link to a page).
 * The focus outline is appended after the merge (components/ds/recipes.ts explains why).
 */
export function buttonClasses({ variant = 'default', size = 'default', className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return `${cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)} ${FOCUS_RING}`;
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `create` is the spark: one per view, only to start making something, never with a price in or beside its
   * label and never on a control that spends (sparkGuard.test.ts).
   */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Busy: a spinner and aria-busy; presses are ignored and focus stays (aria-disabled, not disabled). */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'default', loading = false, className, type, children, onClick, ...rest },
  ref
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type ?? 'button'}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      aria-disabled={loading ? true : rest['aria-disabled']}
      aria-busy={loading ? true : rest['aria-busy']}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      className={buttonClasses({ variant, size, className })}
    >
      {loading ? <Loader2 aria-hidden="true" data-slot="button-spinner" className="animate-spin motion-reduce:animate-none" /> : null}
      {loading && size === 'icon' ? null : children}
    </button>
  );
});
