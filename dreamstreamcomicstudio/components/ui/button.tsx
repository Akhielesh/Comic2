// shadcn-style Button, themed for the Code Studio (Linear/AI-studio dark). cva variants +
// cn(). No Radix Slot (kept dependency-light); use a plain <button>. Studio-scoped.

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Primary AI action — violet→cyan gradient with a soft glow.
        default:
          'bg-gradient-to-r from-violet-500 to-violet-600 text-white shadow-[0_0_0_1px_rgba(124,92,255,0.4),0_8px_30px_-8px_rgba(124,92,255,0.7)] hover:from-violet-400 hover:to-violet-500 hover:shadow-[0_0_0_1px_rgba(124,92,255,0.6),0_10px_36px_-8px_rgba(124,92,255,0.9)]',
        // Glassy secondary.
        secondary:
          'bg-white/[0.06] text-slate-100 border border-white/10 backdrop-blur-md hover:bg-white/[0.1]',
        outline:
          'border border-white/15 bg-transparent text-slate-200 hover:bg-white/[0.06] hover:border-white/25',
        ghost: 'bg-transparent text-slate-300 hover:bg-white/[0.06] hover:text-slate-100',
        destructive:
          'bg-rose-500/90 text-white hover:bg-rose-500 shadow-[0_8px_30px_-8px_rgba(244,63,94,0.6)]',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-12 rounded-2xl px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = 'Button';

export { buttonVariants };
