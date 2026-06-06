// shadcn-style Badge / chip, themed for the Code Studio dark surface. Studio-scoped.

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-slate-100',
        accent: 'border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20',
        success: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge: React.FC<BadgeProps> = ({ className, variant, ...props }) => (
  <span className={cn(badgeVariants({ variant }), className)} {...props} />
);
