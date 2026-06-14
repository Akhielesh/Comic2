// shadcn-pattern primitives themed to the "calm studio" --ds-* tokens (the stock
// components/ui Button is Code-Studio dark/violet, which clashes with the light
// settings modal). Used by the Connectors settings UI.

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 ' +
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--ds-accent)] text-white shadow-sm hover:bg-[var(--ds-accent-hover)]',
        outline: 'border border-[var(--ds-hairline)] bg-transparent text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]',
        ghost: 'bg-transparent text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]',
        destructive: 'bg-transparent text-rose-600 hover:bg-rose-500/10'
      },
      size: {
        sm: 'h-8 px-3 text-xs [&_svg]:h-3.5 [&_svg]:w-3.5',
        md: 'h-9 px-3.5 text-sm [&_svg]:h-4 [&_svg]:w-4',
        icon: 'h-8 w-8 [&_svg]:h-4 [&_svg]:w-4'
      }
    },
    defaultVariants: { variant: 'primary', size: 'md' }
  }
);

export interface DSButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, DSButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button ref={ref} type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
);
Button.displayName = 'DSButton';

/** A labeled settings section with an optional right-aligned action. */
export const Section: React.FC<{
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, subtitle, action, children, className }) => (
  <section className={cn('mb-6', className)}>
    <div className="mb-2 flex items-end justify-between gap-3 px-0.5">
      <div className="min-w-0">
        <h3 className="text-[13px] font-semibold text-[var(--ds-ink)]">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-[var(--ds-muted)]">{subtitle}</p>}
      </div>
      {action}
    </div>
    {children}
  </section>
);

/** A hairline-divided, rounded container — the macOS-settings grouped list. */
export const Group: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div
    className={cn(
      'divide-y divide-[var(--ds-hairline-soft)] overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)]',
      className
    )}
  >
    {children}
  </div>
);

/** Square icon tile used at the start of each row. */
export const IconTile: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div
    className={cn(
      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#D97757]/10 text-[var(--ds-accent)]',
      className
    )}
  >
    {children}
  </div>
);
